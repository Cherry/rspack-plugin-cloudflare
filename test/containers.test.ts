import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

import { resolveWorker } from '../src/config.js';
import { getContainerOptions } from '../src/containers.js';

describe('getContainerOptions', () => {
	let root = '';

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'rspack-plugin-cloudflare-'));
		await fs.mkdir(path.join(root, 'app'), { recursive: true });
		await fs.writeFile(path.join(root, 'app/Dockerfile'), 'FROM scratch\n');
		await fs.writeFile(path.join(root, 'wrangler.json'), JSON.stringify({
			name: 'containers',
			main: './index.ts',
			compatibility_date: '2026-10-23',
			containers: [
				{ class_name: 'App', image: './app/Dockerfile', image_vars: { MODE: 'dev' } },
				{ class_name: 'Remote', image: 'docker.io/library/nginx:1.27' },
				{ name: 'multi', scheduling_policy: 'durable_object', images: { web: { dockerfile: './app/Dockerfile' } } },
			],
			durable_objects: {
				bindings: [
					{ name: 'APP', class_name: 'App' },
					{ name: 'REMOTE', class_name: 'Remote' },
					{ name: 'MULTI', class_name: 'Multi' },
				],
			},
			exports: {
				App: { type: 'durable-object', storage: 'sqlite' },
				Remote: { type: 'durable-object', storage: 'sqlite' },
				Multi: { type: 'durable-object', storage: 'sqlite', container: 'multi' },
			},
		}));
	});

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	// the image plan and wrangler's Durable Object options come from separate helpers, and only the shared build id ties them together
	it('tags each image the way wrangler told its Durable Object to run it', async () => {
		const { config } = await resolveWorker(root, {});
		const { workerOptions } = unstable_getMiniflareWorkerOptions(config, undefined, { containerBuildId: 'build-id' });
		const tags = getContainerOptions(config, 'build-id').map(option => option.image_tag);

		const durableObjects = workerOptions.durableObjects as Record<string, { container: { imageName?: string; images?: { image: string; }[]; }; }>;
		expect(new Set(tags)).toEqual(new Set([
			durableObjects.APP?.container.imageName,
			durableObjects.REMOTE?.container.imageName,
			durableObjects.MULTI?.container.images?.[0]?.image,
		]));
	});
});
