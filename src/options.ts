import type { RspackOptions } from '@rspack/core';
import type { Unstable_Config } from 'wrangler';

export type WorkerConfig = Unstable_Config;

/** Overrides merged into the Wrangler config after it loads, or a function that edits or returns overrides. */
export type WorkerConfigCustomizer = Partial<WorkerConfig> | ((config: WorkerConfig) => Partial<WorkerConfig> | void);

export interface AuxiliaryWorkerOptions {
	/** `cloudflare.config.ts` or Wrangler config for the auxiliary Worker, relative to the rspack `context`. */
	configPath: string;
	/** Changes the auxiliary Worker's config in code, applied after its config file loads. */
	config?: WorkerConfigCustomizer;
	/** Where `rspack build` writes it, relative to its Wrangler config. Defaults to `dist/<worker name>`. */
	outputDir?: string;
}

export interface TunnelOptions {
	/** An existing named tunnel with a route to the dev server. Without one, a Quick Tunnel gets a random trycloudflare.com URL. */
	name?: string;
	/** Email addresses or `*@domain` patterns allowed through a Quick Tunnel, which then asks visitors to sign in. */
	allowedMail?: string[];
}

export interface CloudflarePluginOptions {
	/** `cloudflare.config.ts` or Wrangler config file, relative to the rspack `context`. Defaults to the nearest one at or above `context`. */
	configPath?: string;
	/** Changes the Worker config in code, applied after the config file loads. */
	config?: WorkerConfigCustomizer;
	/** Wrangler environment to use, like `wrangler --env`, for every Worker. Defaults to `CLOUDFLARE_ENV`. */
	environment?: string;
	/** More Workers the entry Worker reaches through service bindings, run and built alongside it. */
	auxiliaryWorkers?: AuxiliaryWorkerOptions[];
	/** Adjusts the rspack config used to bundle a Worker. Return a new config or mutate the one given. */
	worker?: (config: RspackOptions, context: { name: string; }) => RspackOptions | void;
	/** Where `rspack build` writes the Worker bundle and its generated `wrangler.json`, relative to the Wrangler config. Defaults to `dist/<worker name>`. */
	outputDir?: string;
	/** Where local binding state (KV, Durable Objects, etc.) lives in dev, relative to the Wrangler config. `false` keeps it in memory. Defaults to `.wrangler/state`, shared with `wrangler dev`. */
	persistState?: boolean | { path: string; };
	/** Port for the workerd inspector in dev, or `false` to turn it off. Defaults to 9229, or the next free port. */
	inspectorPort?: number | false;
	/** Connects bindings marked `remote: true` to their real resources on Cloudflare in dev. `false` keeps every binding local. */
	remoteBindings?: boolean;
	/** Shares the dev server publicly through a Cloudflare Tunnel once it's listening. */
	tunnel?: boolean | TunnelOptions;
}
