import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { maybeStartOrUpdateRemoteProxySession, unstable_convertConfigBindingsToStartWorkerBindings, unstable_getMiniflareWorkerOptions } from 'wrangler';

import { getContainerImages } from './containers.js';
import {
	HMR_HEADER,
	HMR_RUNNER_CLASS,
	HMR_TOKEN_BINDING,
	createDevEntrySource,
	getConfiguredExports,
} from './dev-entry.js';
import { miniflare } from './miniflare.js';
import { IMPORTED_ASSETS_DIR, createWorkerConfig } from './worker-config.js';

import type { ResolvedWorker } from './config.js';
import type { CloudflarePluginOptions } from './options.js';
import type { AdditionalModulesPlugin, VirtualModules } from './worker-config.js';
import type {
	Compiler,
	MultiStats,
	Stats,
	Watching,
} from '@rspack/core';

type Logger = ReturnType<Compiler['getInfrastructureLogger']>;
type Miniflare = InstanceType<typeof miniflare.Miniflare>;
type RemoteProxySessionData = Awaited<ReturnType<typeof maybeStartOrUpdateRemoteProxySession>>;

// with module output, rspack writes both update chunks and manifests (`*.hot-update.json.mjs`) as ES modules
const HOT_UPDATE_RE = /\.hot-update\.(?:json\.)?mjs$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The export names rspack found on `main`, or undefined when it couldn't tell, like for CommonJS. */
function getProvidedExports(stats: Stats, main: string) {
	const { modules = [] } = stats.toJson({ all: false, modules: true, providedExports: true });
	const mainModule = modules.find(module => module.nameForCondition && path.resolve(module.nameForCondition) === path.resolve(main));
	const provided = mainModule?.providedExports;
	return Array.isArray(provided) ? provided.map(String).toSorted((left, right) => left.localeCompare(right)) : undefined;
}

interface DevWorkerEvents {
	/** A build began, so requests should wait for it. */
	onBuildStart: (worker: DevWorker) => void;
	/** A build finished, successfully or not; `buildError` says which. */
	onBuildDone: (worker: DevWorker) => Promise<void>;
}

/** One Worker in a dev session: its rspack watcher, its hot updates, and its slice of the Miniflare config. */
export class DevWorker {
	readonly #compiler: Compiler;
	readonly #options: CloudflarePluginOptions;
	readonly #logger: Logger;
	readonly #events: DevWorkerEvents;
	readonly #resolve: () => ResolvedWorker;
	// proves an update request came from this session rather than a browser that happened to send the header
	readonly #hmrToken = randomUUID();
	#resolved: ResolvedWorker;
	#watching: Watching | undefined;
	#virtualModules: VirtualModules | undefined;
	#additionalModules: AdditionalModulesPlugin | undefined;
	// the names the dev entry re-exports, which workerd bound when the Worker last (re)started
	#exportNames: string[] = [];
	#loadedModules = '';
	#restartReason: string | undefined = 'it is starting';
	#remoteProxy: RemoteProxySessionData = null;
	// new on every (re)start so changed Dockerfiles get fresh image tags instead of reusing stale images
	#containerBuildId = '';
	buildError: string | undefined;
	building = true;

	constructor(options: { compiler: Compiler; resolve: () => ResolvedWorker; pluginOptions: CloudflarePluginOptions; logger: Logger; events: DevWorkerEvents; }) {
		this.#compiler = options.compiler;
		this.#options = options.pluginOptions;
		this.#logger = options.logger;
		this.#events = options.events;
		this.#resolve = options.resolve;
		this.#resolved = options.resolve();
	}

	// on disk rather than in memory so workerd can read the bundle's source maps for stack traces
	get #outputDir() {
		return path.join(this.#resolved.rootDir, '.wrangler', 'rspack', this.#resolved.name);
	}

	// a virtual module, so it only needs a path that resolves imports the same way main does
	get #entryPath() {
		return path.join(this.#resolved.rootDir, '.wrangler', 'tmp', `rspack-${this.#resolved.name}`, 'dev-entry.js');
	}

	/** Records a finished build, returning false when it triggered another build that should be waited for instead. */
	#handleBuild(main: string, error: Error | null, stats: Stats | MultiStats | undefined) {
		if (error || !stats || stats.hasErrors() || !('compilation' in stats)) {
			this.buildError = error?.message ?? stats?.toString({ preset: 'errors-only', colors: false }) ?? 'Unknown error';
			return true;
		}
		const exportNames = getProvidedExports(stats, main);
		if (exportNames && exportNames.join(',') !== this.#exportNames.join(',')) {
			// the dev entry re-exports by name and workerd binds exports at startup, so regenerate it and restart on the rebuild
			this.#exportNames = exportNames;
			this.#restartReason ??= 'its exports changed';
			this.#virtualModules?.writeModule(this.#entryPath, createDevEntrySource(main, exportNames));
			this.#rebuildEntry();
			return false;
		}
		const entryExports = getProvidedExports(stats, this.#entryPath)?.filter(name => name !== HMR_RUNNER_CLASS);
		if (entryExports && entryExports.join(',') !== this.#exportNames.join(',')) {
			// workerd binds whatever the built entry exports, so a build that missed the rewrite must not reach it
			this.#rebuildEntry();
			return false;
		}
		this.buildError = undefined;
		return true;
	}

	// the watcher is paused while a build callback runs and can drop the virtual entry's change event, and a bare
	// invalidate() then rebuilds with the old entry, so name the changed file outright
	#rebuildEntry() {
		this.#watching?.invalidateWithChangesAndRemovals(new Set([this.#entryPath]));
	}

	#getModules() {
		const modules = [{ type: 'ESModule', path: path.join(this.#outputDir, 'index.js') }];
		for (const { fileName, type } of this.#additionalModules?.modules ?? []) {
			modules.push({ type, path: path.join(this.#outputDir, fileName) });
		}
		return modules;
	}

	/** Starts or refreshes the proxy for bindings marked `remote: true`, which wrangler only opens when some exist. */
	async #getRemoteProxyConnectionString() {
		if (this.#options.remoteBindings === false) {
			return;
		}
		const { config } = this.#resolved;
		this.#remoteProxy = await maybeStartOrUpdateRemoteProxySession({
			name: config.name,
			bindings: unstable_convertConfigBindingsToStartWorkerBindings(config) ?? {},
			account_id: config.account_id,
			complianceRegion: config.compliance_region,
		}, this.#remoteProxy);
		return this.#remoteProxy?.session.remoteProxyConnectionString;
	}

	async #closeWatcher() {
		const watching = this.#watching;
		this.#watching = undefined;
		await new Promise<void>((resolve) => {
			if (watching) {
				watching.close(() => resolve());
			} else {
				resolve();
			}
		});
	}

	get resolved() {
		return this.#resolved;
	}

	get name() {
		return this.#resolved.name;
	}

	/** Why the next build needs a restart instead of a hot update, if it does. */
	get restartReason() {
		if (this.#restartReason) {
			return this.#restartReason;
		}
		if (JSON.stringify(this.#getModules()) !== this.#loadedModules) {
			return 'its .wasm or .bin modules changed';
		}
	}

	start() {
		const { main } = this.#resolved;
		this.#containerBuildId = randomUUID().slice(0, 8);
		if (!main) {
			this.building = false;
			return;
		}
		this.building = true;
		this.#exportNames = getConfiguredExports(this.#resolved);
		const { config, virtualModules, additionalModules } = createWorkerConfig({
			compiler: this.#compiler,
			worker: this.#resolved,
			pluginOptions: this.#options,
			outputDir: this.#outputDir,
			entry: this.#entryPath,
			entrySource: createDevEntrySource(main, this.#exportNames),
			mode: 'development',
			hot: true,
			// a prefix per Worker, so Miniflare's module fallback can tell whose hot update is being imported
			publicPath: `/${this.name}/`,
		});
		this.#virtualModules = virtualModules;
		this.#additionalModules = additionalModules;
		const workerCompiler = this.#compiler.rspack.rspack(config);
		workerCompiler.hooks.invalid.tap('rspack-plugin-cloudflare', () => {
			this.building = true;
			this.#events.onBuildStart(this);
		});
		this.#watching = workerCompiler.watch({}, (error, stats) => {
			if (this.#handleBuild(main, error, stats)) {
				this.building = false;
				this.#events.onBuildDone(this).catch((loadError: unknown) => {
					this.#logger.error(`Worker "${this.name}" failed to load: ${String(loadError)}`);
				});
			}
		});
	}

	/** Re-reads the Wrangler config and rebuilds from scratch, since anything from `main` to bindings may have changed. */
	async reload() {
		await this.#closeWatcher();
		this.#resolved = this.#resolve();
		this.#restartReason = 'its Wrangler config changed';
		this.start();
	}

	/** Records that Miniflare is now running this Worker's latest build. */
	markLoaded() {
		this.#restartReason = undefined;
		this.#loadedModules = JSON.stringify(this.#getModules());
	}

	/** Asks the running Worker to apply its pending hot update, through a fetch its dev entry recognizes by token. */
	async applyHotUpdate(mf: Miniflare): Promise<{ reload: boolean; reason?: string; }> {
		const response = await mf.dispatchFetch('http://localhost/', {
			headers: { [HMR_HEADER]: this.#hmrToken, [miniflare.CoreHeaders.ROUTE_OVERRIDE]: this.name },
		});
		const result: unknown = await response.json();
		if (isPlainObject(result) && result.reload === false) {
			return { reload: false };
		}
		const reason = isPlainObject(result) && typeof result.reason === 'string' ? result.reason : `the update request failed (${response.status})`;
		return { reload: true, reason };
	}

	/** Reads one of this Worker's hot-update modules, given its path below the Worker's public path. */
	async readHotUpdate(relativePath: string) {
		const filePath = path.join(this.#outputDir, relativePath);
		// anything other than a hot update is a genuinely missing import, which should fail like it would in production
		if (!HOT_UPDATE_RE.test(filePath) || !filePath.startsWith(this.#outputDir + path.sep)) {
			return;
		}
		return fs.readFile(filePath, 'utf8');
	}

	/** Where assets imported by the Worker's code are emitted, laid out the way they're served. */
	get importedAssetsDir() {
		return path.join(this.#outputDir, IMPORTED_ASSETS_DIR);
	}

	/** This Worker's Miniflare options, any external Workers wrangler adds for its bindings, and the container images it needs. */
	async getMiniflareOptions(extraServiceBindings: Record<string, unknown>, inspectorEnabled: boolean) {
		const { config, environment } = this.#resolved;
		const remoteProxyConnectionString = await this.#getRemoteProxyConnectionString();
		const { workerOptions, externalWorkers } = unstable_getMiniflareWorkerOptions({ ...config, assets: undefined }, environment, {
			remoteProxyConnectionString,
			containerBuildId: this.#containerBuildId,
		});
		const { modulesRules: _modulesRules, ...options } = workerOptions;
		const containersEnabled = Boolean(config.containers?.length) && config.dev.enable_containers;
		return {
			externalWorkers,
			containerImages: containersEnabled ? getContainerImages(config, options.durableObjects) : [],
			worker: {
				...options,
				name: this.name,
				durableObjects: {
					...(options.durableObjects as Record<string, unknown> | undefined),
					// applies hot updates; ephemeral and never evicted so its I/O context lives as long as the modules it evaluates
					[HMR_RUNNER_CLASS]: { className: HMR_RUNNER_CLASS, unsafeUniqueKey: miniflare.kUnsafeEphemeralUniqueKey, unsafePreventEviction: true },
				},
				unsafeUseModuleFallbackService: true,
				bindings: { ...(options.bindings as Record<string, unknown> | undefined), [HMR_TOKEN_BINDING]: this.#hmrToken },
				serviceBindings: { ...(options.serviceBindings as Record<string, unknown> | undefined), ...extraServiceBindings },
				// rspack already bundled everything into one module, so module rules have nothing left to match
				modulesRoot: this.#outputDir,
				modules: this.#getModules(),
				unsafeInspectorProxy: inspectorEnabled,
			},
		};
	}

	async dispose() {
		await this.#closeWatcher();
		await this.#remoteProxy?.session.dispose();
		this.#remoteProxy = null;
	}
}
