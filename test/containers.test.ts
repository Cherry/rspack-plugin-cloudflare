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
import { getContainerImages } from '../src/containers.js';

describe('getContainerImages', () => {
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

	it('builds or pulls each image under the tag wrangler gave its Durable Object', () => {
		const { config } = resolveWorker(root, {});
		const { workerOptions } = unstable_getMiniflareWorkerOptions(config, undefined, { containerBuildId: 'build-id' });
		const images = getContainerImages(config, workerOptions.durableObjects);

		const durableObjects = workerOptions.durableObjects as Record<string, { container: { imageName?: string; images?: { image: string; }[]; }; }>;
		const dockerfile = path.join(root, 'app', 'Dockerfile');
		expect(images).toEqual([
			{ tag: durableObjects.APP?.container.imageName, dockerfile, buildContext: path.join(root, 'app'), buildArgs: { MODE: 'dev' } },
			{ tag: durableObjects.REMOTE?.container.imageName, uri: 'docker.io/library/nginx:1.27' },
			{ tag: durableObjects.MULTI?.container.images?.[0]?.image, dockerfile, buildContext: path.join(root, 'app'), buildArgs: undefined },
		]);
		// every tag is unique to this build, so a restarted session never runs a stale image
		for (const image of images) {
			expect(image.tag).toContain('build-id');
		}
	});
});
