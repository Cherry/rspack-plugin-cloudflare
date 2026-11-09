import { buildWorkers, copyImportedAssets } from './build.js';
import { getWorkerResolvers } from './config.js';
import { DevSession } from './dev.js';
import { startTunnel } from './tunnel.js';

import type { ResolvedWorker } from './config.js';
import type { CloudflarePluginOptions } from './options.js';
import type { Tunnel } from './tunnel.js';
import type { Compiler, RspackPluginInstance } from '@rspack/core';
import type { RspackDevServer } from '@rspack/dev-server';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export type {
	AuxiliaryWorkerOptions,
	CloudflarePluginOptions,
	TunnelOptions,
	WorkerConfig,
	WorkerConfigCustomizer,
} from './options.js';

const PLUGIN_NAME = 'rspack-plugin-cloudflare';

// listen addresses a tunnel can't dial by name, so it reaches the dev server through localhost instead
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', 'local-ip', 'local-ipv4', 'local-ipv6']);

function getDevServerOrigin(server: RspackDevServer) {
	const address = server.server?.address();
	const port = typeof address === 'object' && address ? address.port : Number(server.options.port);
	const serverOption = server.options.server;
	const serverType = typeof serverOption === 'object' ? serverOption.type : serverOption;
	const protocol = serverType === undefined || serverType === 'http' ? 'http' : 'https';
	const { host } = server.options;
	const hostname = !host || WILDCARD_HOSTS.has(host) ? 'localhost' : host;
	return new URL(`${protocol}://${hostname}:${port}`);
}

/** Lets the tunnel's hostnames past the dev server's Host header check. */
function allowHosts(server: RspackDevServer, urls: string[]) {
	const { allowedHosts } = server.options;
	if (allowedHosts === 'all') {
		return;
	}
	const hostnames = urls.map(url => new URL(url).hostname);
	// a list keeps what 'auto' allowed, since localhost, IPs and the configured host always pass
	if (Array.isArray(allowedHosts)) {
		server.options.allowedHosts = [...allowedHosts, ...hostnames];
	} else if (allowedHosts && allowedHosts !== 'auto') {
		server.options.allowedHosts = [allowedHosts, ...hostnames];
	} else {
		server.options.allowedHosts = hostnames;
	}
}

function getSocketPath(server: RspackDevServer) {
	const socketOptions = server.options.webSocketServer;
	if (typeof socketOptions === 'object' && socketOptions && typeof socketOptions.options?.path === 'string') {
		return socketOptions.options.path;
	}
	return '/ws';
}

export class CloudflarePlugin implements RspackPluginInstance {
	#tunnel: Tunnel | undefined;
	readonly options: CloudflarePluginOptions;

	constructor(options: CloudflarePluginOptions = {}) {
		this.options = options;
	}

	async #openTunnel(server: RspackDevServer, entry: ResolvedWorker | undefined, logger: ReturnType<Compiler['getInfrastructureLogger']>) {
		const { tunnel: tunnelOption } = this.options;
		if (!entry || !tunnelOption) {
			return;
		}
		logger.warn('Starting a Cloudflare Tunnel: anyone with its URL can reach this dev server and its Worker\'s local bindings.');
		this.#tunnel = await startTunnel({
			origin: getDevServerOrigin(server),
			tunnel: tunnelOption === true ? {} : tunnelOption,
			config: entry.config,
			cwd: entry.rootDir,
		});
		allowHosts(server, this.#tunnel.urls);
		for (const url of this.#tunnel.urls) {
			logger.info(`Tunnel: ${url}`);
		}
	}

	apply(compiler: Compiler) {
		type DevServerOptions = NonNullable<RspackDevServer['options']>;
		const logger = compiler.getInfrastructureLogger(PLUGIN_NAME);
		const resolvers = getWorkerResolvers(compiler.context, this.options);
		let session: DevSession | undefined;

		// `rspack serve` builds the dev server from these options after plugins apply, so wrapping them here hooks us in
		const devServer = compiler.options.devServer as DevServerOptions | undefined;
		if (devServer) {
			type Middlewares = Parameters<NonNullable<DevServerOptions['setupMiddlewares']>>[0];
			const { setupMiddlewares, onListening } = devServer;
			devServer.setupMiddlewares = (middlewares: Middlewares, server: RspackDevServer) => {
				const result = setupMiddlewares ? setupMiddlewares(middlewares, server) : middlewares;
				session = new DevSession({ compiler, resolvers, pluginOptions: this.options, logger });
				session.start({
					waitUntilValid: () => new Promise((resolve) => {
						if (server.middleware) {
							server.middleware.waitUntilValid(() => resolve());
						} else {
							resolve();
						}
					}),
					sendToClients: (type, data) => {
						if (server.webSocketServer) {
							server.sendMessage(server.webSocketServer.clients, type, data);
						}
					},
				});
				const activeSession = session;
				// ahead of dev-middleware so `run_worker_first` decides who answers, not whatever the client build emitted
				const devMiddlewareIndex = result.findIndex(middleware => typeof middleware === 'object' && middleware.name === '@rspack/dev-middleware');
				result.splice(devMiddlewareIndex === -1 ? result.length : devMiddlewareIndex, 0, {
					name: PLUGIN_NAME,
					middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => {
						activeSession.handle(req, res, next).catch(next);
					},
				});
				return result;
			};
			devServer.onListening = (server: RspackDevServer) => {
				if (session && server.server) {
					session.attachUpgradeHandler(server.server as Server, getSocketPath(server));
				}
				if (this.options.tunnel) {
					this.#openTunnel(server, resolvers[0]?.(), logger).catch((error: unknown) => {
						logger.error(`Tunnel failed to start: ${error instanceof Error ? error.message : String(error)}`);
					});
				}
				onListening?.(server);
			};
		}

		// the Workers `rspack build` bundled, whose imported assets join the client output once it has emitted
		let builtWorkers: ResolvedWorker[] | undefined;
		compiler.hooks.beforeRun.tapPromise(PLUGIN_NAME, async () => {
			const workers = resolvers.map(resolve => resolve());
			await buildWorkers({ compiler, workers, pluginOptions: this.options });
			for (const worker of workers) {
				logger.info(`Built ${worker.main ? 'Worker' : 'assets-only config'} "${worker.name}" into ${worker.outputDir}`);
			}
			builtWorkers = workers;
		});
		compiler.hooks.afterEmit.tapPromise(PLUGIN_NAME, async () => {
			if (builtWorkers) {
				await copyImportedAssets(builtWorkers);
			}
		});
		compiler.hooks.shutdown.tapPromise(PLUGIN_NAME, async () => {
			this.#tunnel?.close();
			await session?.dispose();
		});
	}
}

export function cloudflare(options?: CloudflarePluginOptions) {
	return new CloudflarePlugin(options);
}
