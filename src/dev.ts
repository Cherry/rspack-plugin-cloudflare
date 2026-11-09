import fs from 'node:fs';
import path from 'node:path';

import { unstable_convertConfigBindingsToStartWorkerBindings, unstable_printBindings } from 'wrangler';
import { WebSocketServer } from 'ws';

import { createAssetServer } from './assets.js';
import {
	getContainerEngine,
	getDockerPath,
	prepareContainerImages,
	removeContainers,
} from './containers.js';
import { DevWorker } from './dev-worker.js';
import {
	createRequestInit,
	getRequestHeaders,
	getRequestUrl,
	sendErrorPage,
	sendResponse,
} from './http.js';
import { DEBUG_PATH, getDebugPageHtml, resolveInspectorPort } from './inspector.js';
import { miniflare } from './miniflare.js';
import { parseStaticRouting, routeRequest } from './routing.js';

import type { AssetServer, ReadableFileSystem } from './assets.js';
import type { ResolvedWorker } from './config.js';
import type { ContainerImage } from './containers.js';
import type { CloudflarePluginOptions } from './options.js';
import type { Compiler } from '@rspack/core';
import type { FSWatcher } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

type Logger = ReturnType<Compiler['getInfrastructureLogger']>;

/** What the session needs from the dev server it runs inside. */
interface DevServerHooks {
	waitUntilValid: () => Promise<void>;
	/** Sends a message to connected HMR clients, which drives the browser's error overlay. */
	sendToClients: (type: string, data?: unknown) => void;
}

// paths the dev server answers itself, before anything reaches the Worker or the assets directory
const DEV_SERVER_PATH_RE = /^\/(?:webpack-dev-server|__webpack_dev_server__|__open-in-editor|lazy-compilation-using-)/;
// Miniflare's own endpoints, like trigger handlers, which skip asset routing
const MINIFLARE_PATH_RE = /^\/(?:cdn-cgi\/local|__cf_local)\//;
// pre-v5 Miniflare paths still in docs and scripts, mapped the same way the Vite plugin does
const LEGACY_PATH_REWRITES = [
	['/cdn-cgi/handler', '/cdn-cgi/local'],
	['/cdn-cgi/mf/scheduled', '/cdn-cgi/local/scheduled'],
	['/cdn-cgi/mf/stream', '/__cf_local/stream'],
	['/cdn-cgi/mf/imagedelivery', '/__cf_local/imagedelivery'],
	['/cdn-cgi/explorer', '/cdn-cgi/local/explorer'],
] as const;
// local secrets files that wrangler reads alongside the config
const SECRETS_FILE_RE = /^\.(?:dev\.vars|env)(?:\..+)?$/;

function rewriteLegacyMiniflarePath(pathname: string) {
	for (const [oldPrefix, newPrefix] of LEGACY_PATH_REWRITES) {
		if (pathname === oldPrefix || pathname.startsWith(`${oldPrefix}/`)) {
			return newPrefix + pathname.slice(oldPrefix.length);
		}
	}
	return pathname;
}

/** Runs the entry Worker and any auxiliary Workers in one Miniflare, routing dev server requests like Cloudflare does. */
export class DevSession {
	readonly #compiler: Compiler;
	readonly #options: CloudflarePluginOptions;
	readonly #logger: Logger;
	readonly #workers: DevWorker[];
	readonly #entry: DevWorker;
	#hooks: DevServerHooks | undefined;
	#assets: AssetServer | undefined;
	#routing;
	#miniflare: InstanceType<typeof miniflare.Miniflare> | undefined;
	#inspectorPort: number | undefined;
	#configWatchers: FSWatcher[] = [];
	// images already built this session, which are also the ones whose containers need removing on exit
	readonly #containerTags = new Set<string>();
	readonly #removeContainersOnExit = () => removeContainers(getDockerPath(), this.#containerTags);
	// Workers rebuilt since Miniflare last picked up their code, and those whose build is failing
	readonly #updated = new Set<DevWorker>();
	readonly #failing = new Set<DevWorker>();
	// builds finish independently, so loading them into Miniflare happens strictly one at a time
	#loading = Promise.resolve();
	// open while any Worker is building, so requests wait for the code they'd otherwise miss
	#gate: { promise: Promise<void>; release: () => void; } | undefined;

	constructor(options: { compiler: Compiler; resolvers: (() => ResolvedWorker)[]; pluginOptions: CloudflarePluginOptions; logger: Logger; }) {
		this.#compiler = options.compiler;
		this.#options = options.pluginOptions;
		this.#logger = options.logger;
		this.#workers = options.resolvers.map(resolve => new DevWorker({
			compiler: options.compiler,
			resolve,
			pluginOptions: options.pluginOptions,
			logger: options.logger,
			events: {
				onBuildStart: () => this.#openGate(),
				onBuildDone: (worker) => {
					this.#loading = this.#loading.then(() => this.#onBuildDone(worker));
					return this.#loading;
				},
			},
		}));
		const [entry] = this.#workers;
		if (!entry) {
			throw new Error('A dev session needs at least one Worker.');
		}
		this.#entry = entry;
		this.#routing = parseStaticRouting(entry.resolved.config.assets?.run_worker_first);
		this.#openGate();
	}

	#openGate() {
		if (this.#gate) {
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#gate = { promise, release: resolve };
	}

	#releaseGateIfIdle() {
		if (this.#gate && this.#workers.every(worker => !worker.building)) {
			this.#gate.release();
			this.#gate = undefined;
		}
	}

	async #ready() {
		while (this.#gate) {
			await this.#gate.promise;
		}
		return this.#miniflare;
	}

	async #onBuildDone(worker: DevWorker) {
		if (worker.buildError) {
			this.#failing.add(worker);
			this.#logger.error(`Worker "${worker.name}" build failed${this.#miniflare ? '; still serving the previous build' : ''}:\n${worker.buildError}`);
			this.#hooks?.sendToClients('errors', [{ moduleName: `Worker "${worker.name}"`, message: worker.buildError }]);
		} else {
			this.#updated.add(worker);
			if (this.#failing.delete(worker) && this.#failing.size === 0) {
				// dismisses the overlay without reloading the page
				this.#hooks?.sendToClients('still-ok');
			}
		}
		// the last Worker to finish loads everyone's changes together
		if (this.#workers.some(other => other.building)) {
			return;
		}
		try {
			await this.#load();
		} catch (error) {
			this.#logger.error(`Workers failed to start:\n${String(error)}`);
		}
		this.#releaseGateIfIdle();
	}

	/** Gets new builds running: hot updates when possible, otherwise a restart of every Worker. */
	async #load() {
		if (!this.#miniflare) {
			if (this.#failing.size > 0) {
				return;
			}
			this.#miniflare = new miniflare.Miniflare(await this.#getMiniflareOptions());
			await this.#miniflare.ready;
			this.#printReady();
			this.#markLoaded();
			return;
		}

		const restart = this.#workers.find(worker => worker.restartReason);
		if (restart) {
			await this.#restart(`Worker "${restart.name}" restarted: ${restart.restartReason ?? ''}`);
			return;
		}
		for (const worker of this.#updated) {
			const result = await worker.applyHotUpdate(this.#miniflare);
			if (result.reload) {
				await this.#restart(`Worker "${worker.name}" restarted: ${result.reason ?? 'the update could not be applied in place'}`);
				return;
			}
			this.#logger.info(`Worker "${worker.name}" hot updated`);
		}
		this.#updated.clear();
	}

	async #restart(message: string) {
		await this.#miniflare?.setOptions(await this.#getMiniflareOptions());
		this.#logger.info(message);
		this.#markLoaded();
	}

	#markLoaded() {
		for (const worker of this.#workers) {
			worker.markLoaded();
		}
		this.#updated.clear();
	}

	#printReady() {
		for (const worker of this.#workers) {
			const { config, name } = worker.resolved;
			unstable_printBindings(unstable_convertConfigBindingsToStartWorkerBindings(config), {
				name,
				local: true,
				warnIfNoBindings: false,
				isMultiWorker: this.#workers.length > 1,
				containers: config.containers,
				tailConsumers: config.tail_consumers,
				streamingTailConsumers: config.streaming_tail_consumers,
				log: (message: string) => this.#logger.info(message),
			});
		}
		const names = this.#workers.map(worker => `"${worker.name}"`).join(', ');
		const debug = this.#inspectorPort === undefined ? '' : `; debug at ${DEBUG_PATH} (inspector on port ${this.#inspectorPort})`;
		this.#logger.info(`${this.#workers.length > 1 ? 'Workers' : 'Worker'} ${names} ready${debug}`);
	}

	/** Serves rspack's hot-update modules, which workerd imports through Miniflare's module fallback as `/<worker>/<file>`. */
	async #serveHotUpdate(request: Parameters<typeof miniflare.parseModuleFallbackRequest>[0]) {
		const parsed = await miniflare.parseModuleFallbackRequest(request);
		const [, workerName = '', ...rest] = (parsed?.specifier ?? '').split('/');
		const worker = this.#workers.find(candidate => candidate.name === workerName);
		const source = await worker?.readHotUpdate(rest.join('/'));
		if (source === undefined) {
			return new miniflare.Response(null, { status: 404 });
		}
		return miniflare.Response.json({ esModule: source });
	}

	#assetsServiceBinding(): Record<string, unknown> {
		const binding = this.#entry.resolved.assets?.binding;
		const assets = this.#assets;
		if (!binding || !assets) {
			return {};
		}
		return {
			[binding]: {
				node: (req: IncomingMessage, res: ServerResponse) => {
					assets.handle(req, res).catch((error: unknown) => this.#sendError(res, error));
				},
			},
		};
	}

	/** Builds images not seen yet this session, returning the engine Miniflare should start containers with. */
	async #prepareContainers(images: ContainerImage[]) {
		if (images.length === 0) {
			return;
		}
		const dockerPath = getDockerPath();
		const pending = images.filter(image => !this.#containerTags.has(image.tag));
		if (pending.length > 0) {
			this.#logger.info('Building container images for local development...');
			await prepareContainerImages(dockerPath, pending);
			for (const image of pending) {
				this.#containerTags.add(image.tag);
			}
			// rspack serve may exit without a shutdown hook, like on a crash, and containers would keep running
			process.off('exit', this.#removeContainersOnExit);
			process.on('exit', this.#removeContainersOnExit);
			this.#logger.info('Container images built; restart dev to rebuild them after changing a Dockerfile.');
		}
		return getContainerEngine(dockerPath);
	}

	async #getMiniflareOptions() {
		const workers: unknown[] = [];
		const externalWorkers: unknown[] = [];
		const containerImages: ContainerImage[] = [];
		for (const worker of this.#workers) {
			if (!worker.resolved.main) {
				continue;
			}
			const extraBindings = worker === this.#entry ? this.#assetsServiceBinding() : {};
			const options = await worker.getMiniflareOptions(extraBindings, this.#inspectorPort !== undefined);
			workers.push(options.worker);
			externalWorkers.push(...options.externalWorkers);
			containerImages.push(...options.containerImages);
		}
		const containerEngine = await this.#prepareContainers(containerImages);

		const { rootDir } = this.#entry.resolved;
		const { persistState = true } = this.#options;
		let resourcePersistencePath: string | undefined;
		if (persistState !== false) {
			const statePath = typeof persistState === 'object' ? persistState.path : path.join('.wrangler', 'state');
			resourcePersistencePath = path.resolve(rootDir, statePath, 'v3');
		}

		return miniflare.convertV4MiniflareOptions({
			log: new miniflare.Log(miniflare.LogLevel.INFO),
			inspectorPort: this.#inspectorPort,
			resourcePersistencePath,
			resourceTmpPath: path.join(rootDir, '.wrangler', 'tmp'),
			containerEngine,
			// lets service bindings reach Workers running in other local dev sessions, and theirs reach these
			unsafeDevRegistryPath: miniflare.getDefaultDevRegistryPath(),
			// serves /cdn-cgi/local/scheduled and friends for testing non-fetch handlers
			unsafeTriggerHandlers: true,
			unsafeModuleFallbackService: (request: Parameters<typeof miniflare.parseModuleFallbackRequest>[0]) => this.#serveHotUpdate(request),
			// the entry Worker comes first, which makes it the one requests reach
			workers: [...workers, ...externalWorkers],
		} as Parameters<typeof miniflare.convertV4MiniflareOptions>[0]);
	}

	#createAssetServer() {
		const { assets, config } = this.#entry.resolved;
		const hooks = this.#hooks;
		if (!assets || !hooks) {
			return;
		}
		return createAssetServer({
			directory: assets.directory,
			config: config.assets,
			// the dev server replaces the client compiler's output filesystem with an in-memory one
			getOutputFileSystem: () => this.#compiler.outputFileSystem as ReadableFileSystem | null ?? undefined,
			// assets imported by Worker code, which `rspack build` copies into the assets directory
			extraDirectories: [this.#entry.importedAssetsDir],
			waitUntilValid: hooks.waitUntilValid,
		});
	}

	/** Rebuilds a Worker when its Wrangler config or local secrets change, like the Vite plugin restarting its server. */
	#watchConfigs() {
		const pending = new Map<DevWorker, ReturnType<typeof setTimeout>>();
		const reload = (worker: DevWorker) => {
			clearTimeout(pending.get(worker));
			// editors often write a file in several steps, so wait for them to settle
			pending.set(worker, setTimeout(() => {
				pending.delete(worker);
				this.#reloadWorker(worker).catch((error: unknown) => {
					this.#logger.error(`Worker "${worker.name}" failed to reload its config:\n${String(error)}`);
				});
			}, 100));
		};
		const directories = new Set(this.#workers.map(worker => worker.resolved.rootDir));
		for (const directory of directories) {
			this.#configWatchers.push(fs.watch(directory, (_event, fileName) => {
				if (!fileName) {
					return;
				}
				for (const worker of this.#workers) {
					const { configPath, rootDir } = worker.resolved;
					if (rootDir === directory && (fileName === path.basename(configPath) || SECRETS_FILE_RE.test(fileName))) {
						reload(worker);
					}
				}
			}));
		}
	}

	async #reloadWorker(worker: DevWorker) {
		this.#logger.info(`Worker "${worker.name}" config changed; rebuilding`);
		this.#openGate();
		await worker.reload();
		if (worker === this.#entry) {
			this.#routing = parseStaticRouting(worker.resolved.config.assets?.run_worker_first);
			this.#assets = this.#createAssetServer();
		}
	}

	async #upgrade(webSocketServer: WebSocketServer, url: URL, req: IncomingMessage, socket: Duplex, head: Buffer) {
		const mf = await this.#ready();
		if (!mf) {
			socket.destroy();
			return;
		}
		const response = await mf.dispatchFetch(url, { method: req.method, headers: [...getRequestHeaders(req)] });
		const workerSocket = response.webSocket;
		if (!workerSocket || socket.destroyed) {
			socket.destroy();
			return;
		}
		webSocketServer.handleUpgrade(req, socket, head, (clientSocket) => {
			miniflare.coupleWebSocket(clientSocket, workerSocket).catch((error: unknown) => {
				this.#logger.error(`WebSocket to the Worker failed: ${String(error)}`);
				clientSocket.terminate();
			});
		});
	}

	#sendError(res: ServerResponse, error: unknown) {
		this.#logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
		sendErrorPage(res, error);
	}

	async #start() {
		this.#inspectorPort = await resolveInspectorPort(this.#options.inspectorPort);
		for (const worker of this.#workers) {
			worker.start();
		}
		this.#watchConfigs();
		// an assets-only project has nothing to build
		this.#releaseGateIfIdle();
	}

	start(hooks: DevServerHooks) {
		this.#hooks = hooks;
		this.#assets = this.#createAssetServer();
		this.#start().catch((error: unknown) => {
			this.#logger.error(`Workers failed to start:\n${String(error)}`);
			this.#gate?.release();
		});
	}

	/** Connect middleware that routes each request to the Worker or the assets directory, like Cloudflare's router does. */
	async handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
		const url = getRequestUrl(req);
		if (DEV_SERVER_PATH_RE.test(url.pathname)) {
			next();
			return;
		}
		if (url.pathname === DEBUG_PATH && this.#inspectorPort !== undefined) {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(getDebugPageHtml(this.#workers.map(worker => worker.name), this.#inspectorPort));
			return;
		}
		try {
			const hasWorker = this.#entry.resolved.main !== undefined;
			url.pathname = rewriteLegacyMiniflarePath(url.pathname);
			const route = MINIFLARE_PATH_RE.test(url.pathname) ? 'worker' : routeRequest(this.#routing, url.pathname, Boolean(this.#assets));
			const assets = this.#assets;
			const servesAsset = !hasWorker || route === 'asset' || (route === 'asset-then-worker' && await assets?.exists(url.pathname));
			if (assets && servesAsset) {
				await assets.handle(req, res);
				return;
			}
			const mf = await this.#ready();
			if (!mf) {
				// already logged when the build failed, so only the browser needs telling
				const errors = [...this.#failing].map(worker => `Worker "${worker.name}":\n${worker.buildError ?? ''}`);
				sendErrorPage(res, `Workers failed to start:\n${errors.join('\n\n')}`);
				return;
			}
			const response = await mf.dispatchFetch(url, createRequestInit(req, res));
			sendResponse(res, response);
		} catch (error) {
			this.#sendError(res, error);
		}
	}

	/** Forwards WebSocket upgrades to the Worker, leaving the dev server's own HMR socket alone. */
	attachUpgradeHandler(server: Server, devServerSocketPath: string) {
		if (!this.#entry.resolved.main) {
			return;
		}
		const webSocketServer = new WebSocketServer({ noServer: true });
		server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
			const url = getRequestUrl(req);
			if (url.pathname === devServerSocketPath || routeRequest(this.#routing, url.pathname, Boolean(this.#assets)) === 'asset') {
				return;
			}
			socket.on('error', () => socket.destroy());
			this.#upgrade(webSocketServer, url, req, socket, head).catch((error: unknown) => {
				this.#logger.error(`WebSocket upgrade to the Worker failed: ${String(error)}`);
				socket.destroy();
			});
		});
	}

	async dispose() {
		for (const watcher of this.#configWatchers) {
			watcher.close();
		}
		await Promise.all(this.#workers.map(worker => worker.dispose()));
		await this.#miniflare?.dispose();
		this.#miniflare = undefined;
		this.#removeContainersOnExit();
		process.off('exit', this.#removeContainersOnExit);
	}
}
