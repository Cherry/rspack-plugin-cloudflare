import fs from 'node:fs';
import path from 'node:path';

import { convertConfigToBindings, printBindings } from '@cloudflare/workers-utils';
import { WebSocketServer } from 'ws';

import {
	ASSET_WORKER_NAME,
	DevAssets,
	ROUTER_WORKER_NAME,
	getAssetConfig,
	getAssetWorkers,
} from './assets.js';
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

import type { AssetRules, AssetWorkerOptions, ReadableFileSystem } from './assets.js';
import type { ResolvedWorker } from './config.js';
import type { CloudflarePluginOptions, WorkerConfig } from './options.js';
import type { ContainerDevOptions } from '@cloudflare/containers-shared';
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

const PLUGIN_NAME = 'rspack-plugin-cloudflare';
// paths the dev server answers itself, before anything reaches the Workers
const DEV_SERVER_PATH_RE = /^\/(?:webpack-dev-server|__webpack_dev_server__|__open-in-editor|lazy-compilation-using-)/;
// @rspack/cli turns lazy compilation on for web builds and serves its endpoint after every other middleware
const LAZY_COMPILATION_PREFIX = '/_rspack/lazy/trigger';
// Miniflare's own endpoints, like trigger handlers, which belong to the Worker rather than the asset router
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

// read per request, since @rspack/cli only enables lazy compilation once the dev server starts
function getLazyCompilationPrefix(compiler: Compiler) {
	const { lazyCompilation } = compiler.options;
	if (typeof lazyCompilation === 'object' && lazyCompilation.prefix) {
		return lazyCompilation.prefix;
	}
	return LAZY_COMPILATION_PREFIX;
}

/** Runs the entry Worker and any auxiliary Workers in one Miniflare, routing dev server requests like Cloudflare does. */
export class DevSession {
	/** Reads every Worker's config before the session starts, since `cloudflare.config.ts` can only be loaded asynchronously. */
	static async create(options: { compiler: Compiler; resolvers: (() => Promise<ResolvedWorker>)[]; pluginOptions: CloudflarePluginOptions; logger: Logger; }) {
		const workers = await Promise.all(options.resolvers.map(async (resolve) => {
			return { resolve, resolved: await resolve() };
		}));
		return new DevSession({ ...options, workers });
	}

	readonly #compiler: Compiler;
	readonly #options: CloudflarePluginOptions;
	readonly #logger: Logger;
	readonly #workers: DevWorker[];
	readonly #entry: DevWorker;
	#hooks: DevServerHooks | undefined;
	#assets: DevAssets | undefined;
	#miniflare: InstanceType<typeof miniflare.Miniflare> | undefined;
	#inspectorPort: number | undefined;
	readonly #configWatchers = new Map<string, FSWatcher>();
	readonly #pendingReloads = new Map<DevWorker, ReturnType<typeof setTimeout>>();
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
	// the `_headers` and `_redirects` Miniflare last started the asset Worker with
	#assetRules: AssetRules | undefined;

	private constructor(options: { compiler: Compiler; workers: { resolved: ResolvedWorker; resolve: () => Promise<ResolvedWorker>; }[]; pluginOptions: CloudflarePluginOptions; logger: Logger; }) {
		this.#compiler = options.compiler;
		this.#options = options.pluginOptions;
		this.#logger = options.logger;
		this.#workers = options.workers.map(({ resolved, resolve }) => new DevWorker({
			compiler: options.compiler,
			resolved,
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
			printBindings(convertConfigToBindings(config, { usePreviewIds: true }), {
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
		if (!binding || !this.#assets) {
			return {};
		}
		return { [binding]: ASSET_WORKER_NAME };
	}

	/** Builds images not seen yet this session, returning the engine Miniflare should start containers with. */
	async #prepareContainers(workers: { config: WorkerConfig; containerOptions: ContainerDevOptions[]; }[]) {
		const withContainers = workers.filter(worker => worker.containerOptions.length > 0);
		const [first] = withContainers;
		if (!first) {
			return;
		}
		const dockerPath = getDockerPath();
		const pending = withContainers.map(({ config, containerOptions }) => {
			return { config, containerOptions: containerOptions.filter(options => !this.#containerTags.has(options.image_tag)) };
		});
		if (pending.some(worker => worker.containerOptions.length > 0)) {
			this.#logger.info('Building container images for local development...');
			for (const { config, containerOptions } of pending) {
				await prepareContainerImages({ config, dockerPath, containerOptions, logger: this.#logger });
				for (const options of containerOptions) {
					this.#containerTags.add(options.image_tag);
				}
			}
			// rspack serve may exit without a shutdown hook, like on a crash, and containers would keep running
			process.off('exit', this.#removeContainersOnExit);
			process.on('exit', this.#removeContainersOnExit);
			this.#logger.info('Container images built; restart dev to rebuild them after changing a Dockerfile.');
		}
		return getContainerEngine(first.config, dockerPath);
	}

	async #getAssetWorkers(assetWorkerOptions: AssetWorkerOptions | undefined) {
		const assets = this.#assets;
		if (!assetWorkerOptions || !assets) {
			return [];
		}
		this.#assetRules = await assets.readRules();
		return getAssetWorkers({
			routerConfig: assetWorkerOptions.routerConfig,
			assetConfig: getAssetConfig(assetWorkerOptions, this.#assetRules, this.#logger),
			userWorkerName: this.#entry.resolved.main ? this.#entry.name : undefined,
			assets,
		});
	}

	/** Restarts the Workers when the build's `_headers` or `_redirects` change, since the asset Worker reads them at startup. */
	async #checkAssetRules() {
		const previous = this.#assetRules;
		if (!this.#miniflare || !this.#assets || !previous) {
			return;
		}
		const current = await this.#assets.readRules();
		if (current.headers !== previous.headers || current.redirects !== previous.redirects) {
			await this.#restart('Workers restarted: _headers or _redirects changed');
		}
	}

	async #getMiniflareOptions() {
		const workers: unknown[] = [];
		const externalWorkers: unknown[] = [];
		const containers: { config: WorkerConfig; containerOptions: ContainerDevOptions[]; }[] = [];
		let assetWorkerOptions: AssetWorkerOptions | undefined;
		for (const worker of this.#workers) {
			const extraBindings = worker === this.#entry ? this.#assetsServiceBinding() : {};
			const options = await worker.getMiniflareOptions(extraBindings, this.#inspectorPort !== undefined);
			if (worker === this.#entry) {
				assetWorkerOptions = options.assetWorkerOptions;
			}
			if (!worker.resolved.main) {
				continue;
			}
			workers.push(options.worker);
			externalWorkers.push(...options.externalWorkers);
			containers.push({ config: worker.resolved.config, containerOptions: options.containerOptions });
		}
		const containerEngine = await this.#prepareContainers(containers);
		const assetWorkers = await this.#getAssetWorkers(assetWorkerOptions);

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
			// the first Worker gets requests without a route override: the entry Worker, or the router for an assets-only project
			workers: [...workers, ...assetWorkers, ...externalWorkers],
		} as Parameters<typeof miniflare.convertV4MiniflareOptions>[0]);
	}

	#createDevAssets() {
		const { assets } = this.#entry.resolved;
		const hooks = this.#hooks;
		if (!assets || !hooks) {
			return;
		}
		return new DevAssets({
			directory: assets.directory,
			// assets imported by Worker code, which `rspack build` copies into the assets directory
			extraDirectories: [this.#entry.importedAssetsDir],
			// the dev server replaces the client compiler's output filesystem with an in-memory one
			getOutputFileSystem: () => this.#compiler.outputFileSystem as ReadableFileSystem | null ?? undefined,
			waitUntilValid: hooks.waitUntilValid,
		});
	}

	/** Rebuilds a Worker when its config, a file its config imports, or its local secrets change, like the Vite plugin restarting its server. */
	#watchConfigs() {
		for (const worker of this.#workers) {
			const { configFiles, rootDir } = worker.resolved;
			for (const directory of [rootDir, ...configFiles.map(file => path.dirname(file))]) {
				if (!this.#configWatchers.has(directory)) {
					this.#configWatchers.set(directory, fs.watch(directory, (_event, fileName) => this.#onConfigDirectoryChange(directory, fileName)));
				}
			}
		}
	}

	#onConfigDirectoryChange(directory: string, fileName: string | null) {
		if (!fileName) {
			return;
		}
		const filePath = path.join(directory, fileName);
		for (const worker of this.#workers) {
			const { configFiles, rootDir } = worker.resolved;
			if (configFiles.includes(filePath) || (rootDir === directory && SECRETS_FILE_RE.test(fileName))) {
				this.#scheduleReload(worker);
			}
		}
	}

	#scheduleReload(worker: DevWorker) {
		clearTimeout(this.#pendingReloads.get(worker));
		// editors often write a file in several steps, so wait for them to settle
		this.#pendingReloads.set(worker, setTimeout(() => {
			this.#pendingReloads.delete(worker);
			this.#reloadWorker(worker).catch((error: unknown) => {
				this.#logger.error(`Worker "${worker.name}" failed to reload its config:\n${String(error)}`);
			});
		}, 100));
	}

	async #reloadWorker(worker: DevWorker) {
		this.#logger.info(`Worker "${worker.name}" config changed; rebuilding`);
		this.#openGate();
		try {
			await worker.reload();
			if (worker === this.#entry) {
				this.#assets = this.#createDevAssets();
			}
		} finally {
			// a config that fails to load keeps the previous build serving, so requests can't be left waiting for a rebuild
			this.#releaseGateIfIdle();
		}
		// the new config can import files from directories nobody is watching yet
		this.#watchConfigs();
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
		if (this.#workers.every(worker => !worker.building)) {
			// an assets-only project has nothing to build, so the router and asset Workers can start straight away
			this.#loading = this.#loading.then(() => this.#load());
			await this.#loading;
		}
		this.#releaseGateIfIdle();
	}

	start(hooks: DevServerHooks) {
		this.#hooks = hooks;
		this.#assets = this.#createDevAssets();
		this.#compiler.hooks.done.tap(PLUGIN_NAME, () => {
			this.#loading = this.#loading.then(() => this.#checkAssetRules()).catch((error: unknown) => {
				this.#logger.error(`Workers failed to pick up _headers or _redirects:\n${String(error)}`);
			});
		});
		this.#start().catch((error: unknown) => {
			this.#logger.error(`Workers failed to start:\n${String(error)}`);
			this.#gate?.release();
		});
	}

	/** Connect middleware that sends each request through Cloudflare's router Worker, or straight to the Worker without assets. */
	async handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
		const url = getRequestUrl(req);
		if (DEV_SERVER_PATH_RE.test(url.pathname) || url.pathname.startsWith(getLazyCompilationPrefix(this.#compiler))) {
			next();
			return;
		}
		if (url.pathname === DEBUG_PATH && this.#inspectorPort !== undefined) {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(getDebugPageHtml(this.#workers.map(worker => worker.name), this.#inspectorPort));
			return;
		}
		try {
			url.pathname = rewriteLegacyMiniflarePath(url.pathname);
			const mf = await this.#ready();
			if (!mf) {
				// already logged when the build failed, so only the browser needs telling
				const errors = [...this.#failing].map(worker => `Worker "${worker.name}":\n${worker.buildError ?? ''}`);
				sendErrorPage(res, `Workers failed to start:\n${errors.join('\n\n')}`);
				return;
			}
			const init = createRequestInit(req, res);
			if (this.#assets && !MINIFLARE_PATH_RE.test(url.pathname)) {
				init.headers.push([miniflare.CoreHeaders.ROUTE_OVERRIDE, ROUTER_WORKER_NAME]);
			}
			const response = await mf.dispatchFetch(url, init);
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
			if (url.pathname === devServerSocketPath) {
				return;
			}
			socket.on('error', () => socket.destroy());
			this.#upgrade(webSocketServer, url, req, socket, head).catch((error: unknown) => {
				this.#logger.error(`WebSocket upgrade to the Worker failed: ${String(error)}`);
				socket.destroy();
			});
		});
	}

	/** The entry Worker as its config was last read. */
	get entry() {
		return this.#entry.resolved;
	}

	async dispose() {
		for (const watcher of this.#configWatchers.values()) {
			watcher.close();
		}
		for (const timeout of this.#pendingReloads.values()) {
			clearTimeout(timeout);
		}
		await Promise.all(this.#workers.map(worker => worker.dispose()));
		await this.#miniflare?.dispose();
		this.#miniflare = undefined;
		this.#removeContainersOnExit();
		process.off('exit', this.#removeContainersOnExit);
	}
}
