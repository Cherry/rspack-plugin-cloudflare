// Cloudflare's asset Worker, reading files from the dev server instead of a manifest built at startup, since the client
// build changes on every rebuild. The Vite plugin extends it the same way.
import { AssetWorkerInner } from '../../../workers-sdk/packages/workers-shared/asset-worker/index.js';

import type { Env } from '../../../workers-sdk/packages/workers-shared/asset-worker/index.js';

interface DevEnv extends Env {
	__RSPACK_ASSETS__: Fetcher;
}

const ORIGIN = 'http://assets.local';

export default class DevAssetWorker extends AssetWorkerInner<DevEnv> {
	override async fetch(request: Request) {
		const response = await super.fetch(request);
		const devResponse = new Response(response.body, response);
		// dev files keep their names across rebuilds, so the browser must never reuse a cached copy
		devResponse.headers.delete('ETag');
		devResponse.headers.delete('Cache-Control');
		return devResponse;
	}

	override async unstable_exists(pathname: string) {
		const response = await this.env.__RSPACK_ASSETS__.fetch(new URL(`/exists?${new URLSearchParams({ pathname })}`, ORIGIN));
		return response.json<string | null>();
	}

	override async unstable_getByETag(eTag: string) {
		const response = await this.env.__RSPACK_ASSETS__.fetch(new URL(`/read?${new URLSearchParams({ eTag })}`, ORIGIN));
		if (!response.ok || !response.body) {
			throw new Error(`Asset ${eTag} disappeared before it could be read.`);
		}
		return { readableStream: response.body, contentType: response.headers.get('Content-Type') ?? undefined, cacheStatus: 'MISS' as const };
	}
}
