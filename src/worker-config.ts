import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { getModuleTypes } from './module-rules.js';
import { getNodeJsCompat } from './nodejs-compat.js';

import type { ResolvedWorker } from './config.js';
import type { ModuleType } from './module-rules.js';
import type { NodeJsCompat } from './nodejs-compat.js';
import type { CloudflarePluginOptions } from './options.js';
import type { Compiler, RspackOptions, RspackPluginInstance } from '@rspack/core';

/** The rspack plugin that holds generated modules, which dev rewrites when the Worker's exports change. */
export type VirtualModules = InstanceType<Compiler['rspack']['experiments']['VirtualModulesPlugin']>;

const PLUGIN_NAME = 'rspack-plugin-cloudflare';
const TYPESCRIPT_RE = /\.[cm]?tsx?$/;
// the static asset types Vite also imports as URLs; .txt stays a Text module, as wrangler treats it
const ASSET_RE = /\.(?:apng|avif|bmp|cur|eot|flac|gif|ico|jfif|jpe?g|jxl|m4a|mov|mp3|mp4|ogg|opus|otf|pdf|pjp|pjpeg|png|svg|ttf|vtt|wav|webm|webmanifest|webp|woff2?|aac)$/i;
// `?url` imports any file as a URL, like Vite
const URL_QUERY_RE = /\?(?:[^#]*&)?url(?:[&=#]|$)/;

/** Output subdirectory for assets Worker code imports, laid out the way the assets directory serves them. */
export const IMPORTED_ASSETS_DIR = 'imported-assets';

interface AdditionalModule {
	/** File name in the output directory, which is also how the bundle imports it. */
	fileName: string;
	type: 'CompiledWasm' | 'Data';
}

/** Copies imported `.wasm`/`.bin` files next to the bundle, where workerd loads them as their own modules. */
export class AdditionalModulesPlugin implements RspackPluginInstance {
	readonly #files = new Map<string, { sourcePath: string; type: AdditionalModule['type']; }>();

	/** Every file emitted so far; dev passes these to Miniflare, since rspack's incremental asset list can leave them out. */
	get modules(): AdditionalModule[] {
		return [...this.#files].map(([fileName, { type }]) => {
			return { fileName, type };
		});
	}

	/** Records a file to emit and returns the specifier the bundle should import it by. */
	add(sourcePath: string, type: AdditionalModule['type']) {
		const hash = createHash('sha1').update(fs.readFileSync(sourcePath)).digest('hex')
			.slice(0, 16);
		const fileName = `${hash}-${path.basename(sourcePath)}`;
		this.#files.set(fileName, { sourcePath, type });
		return `./${fileName}`;
	}

	apply(compiler: Compiler) {
		const { Compilation, sources } = compiler.rspack;
		compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
			compilation.hooks.processAssets.tap({ name: PLUGIN_NAME, stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL }, () => {
				for (const [fileName, { sourcePath }] of this.#files) {
					compilation.emitAsset(fileName, new sources.RawSource(fs.readFileSync(sourcePath)));
					compilation.fileDependencies.add(sourcePath);
				}
			});
		});
	}
}

function createExternals(nodeJsCompat: NodeJsCompat | undefined, moduleTypes: Map<string, ModuleType>, additionalModules: AdditionalModulesPlugin) {
	type ExternalsCallback = (error?: Error, result?: string) => void;
	return ({ request, context }: { request?: string; context?: string; }, callback: ExternalsCallback) => {
		if (!request) {
			callback();
			return;
		}
		if (request.startsWith('cloudflare:')) {
			callback(undefined, request);
			return;
		}
		if (nodeJsCompat) {
			const native = nodeJsCompat.externals.get(request);
			if (native) {
				callback(undefined, native);
				return;
			}
			// a builtin the preset doesn't know about yet; workerd only resolves the node: form
			if (isBuiltin(request) && !nodeJsCompat.polyfills.has(request)) {
				callback(undefined, request.startsWith('node:') ? request : `node:${request}`);
				return;
			}
		}
		const filePath = request.replace(/\?.*$/, '');
		const type = moduleTypes.get(path.extname(filePath));
		const isModule = type === 'CompiledWasm' || type === 'Data';
		if (isModule && !URL_QUERY_RE.test(request) && context && (filePath.startsWith('.') || path.isAbsolute(filePath))) {
			callback(undefined, additionalModules.add(path.resolve(context, filePath), type));
			return;
		}
		callback();
	};
}

/** Text modules inline as strings; with an assets directory, static files and `?url` imports become URLs served from it. */
function getAssetRules(worker: ResolvedWorker, textExtensions: Set<string>) {
	const textRule = { test: (file: string) => textExtensions.has(path.extname(file)), type: 'asset/source' };
	if (!worker.assets) {
		return [textRule];
	}
	const generator = {
		filename: 'assets/[name].[contenthash:8][ext]',
		outputPath: IMPORTED_ASSETS_DIR,
		// served from the root of the assets directory, not the Worker's own public path
		publicPath: '/',
	};
	return [
		{ resourceQuery: URL_QUERY_RE, type: 'asset/resource', generator },
		textRule,
		{ test: ASSET_RE, type: 'asset/resource', generator },
	];
}

/** Builds the rspack config for the Worker bundle: a single ESM file workerd can load as-is. */
export function createWorkerConfig(options: {
	compiler: Compiler;
	worker: ResolvedWorker;
	pluginOptions: CloudflarePluginOptions;
	outputDir: string;
	/** The module to bundle. */
	entry: string;
	/** Source for `entry` when it isn't a real file, like dev's wrapper around `main`. */
	entrySource?: string;
	mode: 'development' | 'production';
	/** Builds in rspack's HMR runtime so dev can update the running Worker in place. */
	hot?: boolean;
	/** Where HMR imports update chunks from; workerd has no import.meta.url to derive it from. */
	publicPath?: string;
}): { config: RspackOptions; virtualModules: VirtualModules; additionalModules: AdditionalModulesPlugin; } {
	const { compiler, worker, pluginOptions, outputDir, entry, entrySource, mode, hot = false, publicPath = '/' } = options;
	const { rspack } = compiler;
	const moduleTypes = getModuleTypes(worker);
	const textExtensions = new Set([...moduleTypes].filter(([, type]) => type === 'Text').map(([extension]) => extension));
	const additionalModules = new AdditionalModulesPlugin();
	const nodeJsCompat = getNodeJsCompat(worker);

	const virtualModules: Record<string, string> = {};
	const entries = [entry];
	if (entrySource !== undefined) {
		virtualModules[entry] = entrySource;
	}
	if (nodeJsCompat?.injectSource) {
		// runs before the Worker so injected globals like `process` exist while its modules evaluate
		const injectPath = path.join(worker.rootDir, '.wrangler', 'tmp', `rspack-${worker.name}`, 'nodejs-compat-inject.js');
		virtualModules[injectPath] = nodeJsCompat.injectSource;
		entries.unshift(injectPath);
	}

	const plugins: RspackPluginInstance[] = [
		new rspack.DefinePlugin(worker.config.define),
		// workerd loads a single module here, so keep dynamic imports in the entry chunk
		new rspack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
		additionalModules,
	];
	const polyfills = nodeJsCompat?.polyfills;
	if (polyfills && polyfills.size > 0) {
		// rspack reads `node:` specifiers as a URL scheme that resolve.alias never sees, so swap polyfills in before resolving
		plugins.push(new rspack.NormalModuleReplacementPlugin(/^(?:node:)?[a-z_]/, (resource: { request: string; }) => {
			const polyfill = polyfills.get(resource.request);
			if (polyfill) {
				resource.request = polyfill;
			}
		}));
	}
	const virtualModulesPlugin = new rspack.experiments.VirtualModulesPlugin(virtualModules);
	plugins.push(virtualModulesPlugin);
	if (hot) {
		plugins.push(new rspack.HotModuleReplacementPlugin());
	}

	let config: RspackOptions = {
		name: `cloudflare:${worker.name}`,
		mode,
		context: worker.rootDir,
		target: ['webworker', 'es2024'],
		entry: { index: entries },
		output: {
			path: outputDir,
			filename: 'index.js',
			module: true,
			chunkFormat: 'module',
			library: { type: 'module' },
			clean: true,
			publicPath,
		},
		externalsType: 'module-import',
		externals: [createExternals(nodeJsCompat, moduleTypes, additionalModules)],
		resolve: {
			extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'],
			extensionAlias: { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'] },
			conditionNames: ['workerd', 'worker', 'browser', 'module', 'import', 'default'],
			alias: worker.config.alias,
		},
		module: {
			rules: [
				{
					test: TYPESCRIPT_RE,
					loader: 'builtin:swc-loader',
					options: {
						jsc: {
							parser: { syntax: 'typescript', tsx: true, decorators: true },
							target: 'es2024',
						},
					},
					type: 'javascript/auto',
				},
				{ oneOf: getAssetRules(worker, textExtensions) },
			],
		},
		devtool: 'source-map',
		optimization: {
			// wrangler doesn't minify by default either, and readable stack traces matter more on the server
			minimize: false,
			// a failed dev build must leave the last good bundle in place, since restarting another Worker reloads it from disk
			emitOnErrors: false,
		},
		plugins,
		performance: { hints: false },
		watchOptions: {
			// dev's generated entry is virtual and the bundle is written under .wrangler, so the watcher would see both as changes
			ignored: /[/\\](?:\.git|node_modules|\.wrangler)[/\\]/,
		},
		stats: 'errors-warnings',
		infrastructureLogging: compiler.options.infrastructureLogging,
	};

	if (pluginOptions.worker) {
		config = pluginOptions.worker(config, { name: worker.name }) ?? config;
	}
	return { config, virtualModules: virtualModulesPlugin, additionalModules };
}
