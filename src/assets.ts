import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as miniflare from 'miniflare';
import { lookup } from 'mrmime';

import { constructHeaders, constructRedirects } from '../workers-sdk/packages/workers-shared/utils/configuration/constructConfiguration.js';
import { parseHeaders } from '../workers-sdk/packages/workers-shared/utils/configuration/parseHeaders.js';
import { parseRedirects } from '../workers-sdk/packages/workers-shared/utils/configuration/parseRedirects.js';

import type { AssetConfig, RouterConfig } from '../workers-sdk/packages/workers-shared/utils/types.js';
import type { Compiler } from '@rspack/core';

type Logger = ReturnType<Compiler['getInfrastructureLogger']>;
type MiniflareRequest = InstanceType<typeof miniflare.Request>;

/** The slice of rspack's output filesystem we read from; the dev server swaps in an in-memory one. */
export interface ReadableFileSystem {
	readFile: (filePath: string, callback: (error: NodeJS.ErrnoException | null, data?: Buffer | string) => void) => void;
	stat: (filePath: string, callback: (error: NodeJS.ErrnoException | null, stats?: { isFile: () => boolean; }) => void) => void;
}

/** The router and asset Worker configs wrangler generates for a Worker with assets. */
export interface AssetWorkerOptions {
	routerConfig: RouterConfig;
	assetConfig: AssetConfig;
}

/** The contents of the build's `_headers` and `_redirects`, which the asset Worker reads when it starts. */
export interface AssetRules {
	headers: string | undefined;
	redirects: string | undefined;
}

export const ROUTER_WORKER_NAME = '__rspack-plugin-cloudflare-router__';
export const ASSET_WORKER_NAME = '__rspack-plugin-cloudflare-assets__';
// the date and flags the Vite plugin runs the same Workers with
const INTERNAL_WORKERS_COMPATIBILITY_DATE = '2024-10-04';
// configuration rather than content, which wrangler never uploads as assets
const RESERVED_FILES = new Set(['/_headers', '/_redirects', '/.assetsignore']);

// Miniflare's JSON bindings reject the undefined values wrangler leaves on options that aren't set
function toJsonBinding(config: AssetConfig | RouterConfig) {
	return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

function getInternalWorkerPath(name: string) {
	return fileURLToPath(new URL(`workers/${name}/index.js`, import.meta.url));
}

function statFile(fileSystem: ReadableFileSystem, filePath: string) {
	return new Promise<boolean>((resolve) => {
		fileSystem.stat(filePath, (error, stats) => {
			resolve(!error && Boolean(stats?.isFile()));
		});
	});
}

function readFile(fileSystem: ReadableFileSystem, filePath: string) {
	return new Promise<Buffer>((resolve, reject) => {
		fileSystem.readFile(filePath, (error, data) => {
			if (error || data === undefined) {
				reject(error ?? new Error(`Could not read ${filePath}`));
				return;
			}
			resolve(Buffer.from(data));
		});
	});
}

/**
 * Finds asset files for the asset Worker, reading the compiler's output filesystem first so files only emitted in
 * memory by the dev server are visible, then the assets directory on disk.
 */
export class DevAssets {
	readonly #roots: string[];
	readonly #getOutputFileSystem: () => ReadableFileSystem | undefined;
	readonly #waitUntilValid: () => Promise<void>;

	constructor(options: {
		directory: string;
		/** More directories served at the root, checked after `directory`. */
		extraDirectories: string[];
		getOutputFileSystem: () => ReadableFileSystem | undefined;
		waitUntilValid: () => Promise<void>;
	}) {
		this.#roots = [options.directory, ...options.extraDirectories];
		this.#getOutputFileSystem = options.getOutputFileSystem;
		this.#waitUntilValid = options.waitUntilValid;
	}

	async #find(pathname: string) {
		const outputFileSystem = this.#getOutputFileSystem();
		for (const root of this.#roots) {
			const filePath = path.join(root, pathname);
			// path.join normalizes `..`, so anything still escaping the root is a traversal attempt
			if (!filePath.startsWith(root + path.sep)) {
				continue;
			}
			if (outputFileSystem && await statFile(outputFileSystem, filePath)) {
				return { fileSystem: outputFileSystem, filePath };
			}
			if (await statFile(fs, filePath)) {
				return { fileSystem: fs, filePath };
			}
		}
	}

	async #readText(pathname: string) {
		const file = await this.#find(pathname);
		return file && String(await readFile(file.fileSystem, file.filePath));
	}

	async readRules(): Promise<AssetRules> {
		await this.#waitUntilValid();
		return { headers: await this.#readText('/_headers'), redirects: await this.#readText('/_redirects') };
	}

	/** Answers the asset Worker's lookups, using the pathname itself as the ETag. */
	async handle(request: MiniflareRequest) {
		const url = new URL(request.url);
		const pathname = url.searchParams.get(url.pathname === '/exists' ? 'pathname' : 'eTag') ?? '';
		await this.#waitUntilValid();
		const file = RESERVED_FILES.has(pathname) ? undefined : await this.#find(pathname);
		if (url.pathname === '/exists') {
			return miniflare.Response.json(file ? pathname : null);
		}
		if (!file) {
			return new miniflare.Response(null, { status: 404 });
		}
		const body = await readFile(file.fileSystem, file.filePath);
		return new miniflare.Response(body, { headers: { 'Content-Type': lookup(file.filePath) ?? 'application/octet-stream' } });
	}
}

/** Adds the build's `_headers` and `_redirects` to wrangler's asset config, the way Miniflare does for wrangler dev. */
export function getAssetConfig(options: AssetWorkerOptions, rules: AssetRules, logger: Logger): AssetConfig {
	const { assetConfig, routerConfig } = options;
	const parserLogger = {
		// the count of valid rules on every restart is noise; invalid ones still warn
		debug: () => {},
		log: () => {},
		info: (message: string) => logger.info(message),
		warn: (message: string) => logger.warn(message),
		error: (error: Error) => logger.error(error.message),
	};
	const config: AssetConfig = { ...assetConfig, debug: true, has_static_routing: Boolean(routerConfig.static_routing) };
	if (rules.redirects !== undefined) {
		const redirects = parseRedirects(rules.redirects, { htmlHandling: assetConfig.html_handling });
		Object.assign(config, constructRedirects({ redirects, redirectsFile: '_redirects', logger: parserLogger }));
	}
	if (rules.headers !== undefined) {
		Object.assign(config, constructHeaders({ headers: parseHeaders(rules.headers), headersFile: '_headers', logger: parserLogger }));
	}
	return config;
}

/** Miniflare options for Cloudflare's router and asset Workers, with assets coming from `assets` instead of a manifest. */
export function getAssetWorkers(options: { routerConfig: RouterConfig; assetConfig: AssetConfig; userWorkerName: string | undefined; assets: DevAssets; }) {
	const routerPath = getInternalWorkerPath('router-worker');
	const assetPath = getInternalWorkerPath('asset-worker');
	return [
		{
			name: ROUTER_WORKER_NAME,
			compatibilityDate: INTERNAL_WORKERS_COMPATIBILITY_DATE,
			// the outer entrypoint reaches the inner one through ctx.exports
			compatibilityFlags: ['enable_ctx_exports'],
			modulesRoot: path.dirname(routerPath),
			modules: [{ type: 'ESModule', path: routerPath }],
			bindings: { CONFIG: toJsonBinding(options.routerConfig) },
			serviceBindings: {
				ASSET_WORKER: ASSET_WORKER_NAME,
				...(options.userWorkerName !== undefined && { USER_WORKER: options.userWorkerName }),
			},
			// internal to this session, so other dev sessions shouldn't see them in the dev registry
			unsafeRegisterWorker: false,
		},
		{
			name: ASSET_WORKER_NAME,
			compatibilityDate: INTERNAL_WORKERS_COMPATIBILITY_DATE,
			modulesRoot: path.dirname(assetPath),
			modules: [{ type: 'ESModule', path: assetPath }],
			bindings: { CONFIG: toJsonBinding(options.assetConfig) },
			serviceBindings: { __RSPACK_ASSETS__: (request: MiniflareRequest) => options.assets.handle(request) },
			unsafeRegisterWorker: false,
		},
	];
}
