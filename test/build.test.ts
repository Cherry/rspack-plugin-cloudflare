import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import {
	basicFixture,
	rspackBin,
	run,
	wranglerBin,
} from './helpers.js';
import { createOutputConfig } from '../src/build.js';
import { resolveWorker } from '../src/config.js';

const outputDir = path.join(basicFixture, 'dist/fixture');

describe('rspack build', () => {
	let buildOutput = '';

	beforeAll(async () => {
		await fs.rm(path.join(basicFixture, 'dist'), { recursive: true, force: true });
		await fs.rm(path.join(basicFixture, '.wrangler'), { recursive: true, force: true });
		const result = await run(rspackBin, ['build'], basicFixture);
		buildOutput = result.output;
		expect(result.code, result.output).toBe(0);
	});

	it('bundles the Worker into one module that leaves runtime builtins to workerd', async () => {
		expect(buildOutput).toContain('Built Worker "fixture"');
		const bundle = await fs.readFile(path.join(outputDir, 'index.js'), 'utf8');
		expect(bundle).toMatch(/^import .* from "node:buffer";$/m);
		expect(bundle).toMatch(/^import .* from "cloudflare:workers";$/m);
		expect(bundle).toContain('from the worker');
	});

	it('writes a deploy config that wrangler deploy accepts', async () => {
		const result = await run(wranglerBin, ['deploy', '--dry-run', '--outdir', path.join(basicFixture, '.wrangler/dry-run')], basicFixture);
		expect(result.code, result.output).toBe(0);
		expect(result.output).toContain('Using redirected Wrangler configuration');
		expect(result.output).toContain('env.COUNTER (Counter)');
		// the output config is rebased onto dist/fixture, so assets must still resolve to the client build
		expect(result.output).toMatch(/assets directory .*fixtures[/\\]basic[/\\]build/);
		expect(result.output).not.toContain('"unsafe" fields are experimental');
		// .wasm and .bin imports ship beside the bundle and wrangler's default rules pick them up without warnings
		expect(result.output).toMatch(/-add\.wasm.*compiled-wasm/);
		expect(result.output).toMatch(/-data\.bin.*buffer/);
		expect(result.output).not.toContain('does not have a fallback');
	});

	it('moves assets imported by Worker code into the client build, which the client clean would otherwise wipe', async () => {
		const bundle = await fs.readFile(path.join(outputDir, 'index.js'), 'utf8');
		const [url] = /\/assets\/logo\.[\da-f]{8}\.svg/.exec(bundle) ?? [];
		expect(url).toBeDefined();
		expect(await fs.readFile(path.join(basicFixture, 'build', url ?? ''), 'utf8')).toContain('fixture logo');
		await expect(fs.access(path.join(outputDir, 'imported-assets'))).rejects.toThrow();
	});

	it('copies local secrets beside the build so wrangler dev can preview it', async () => {
		expect(await fs.readFile(path.join(outputDir, '.dev.vars'), 'utf8')).toBe('SECRET="from-dotenv"\n');
	});
});

describe('resolveWorker', () => {
	it('applies the Wrangler environment named by CLOUDFLARE_ENV', () => {
		process.env.CLOUDFLARE_ENV = 'staging';
		try {
			const worker = resolveWorker(basicFixture, {});
			expect(worker.name).toBe('fixture-staging');
			expect(worker.config.vars.GREETING).toBe('howdy');
		} finally {
			delete process.env.CLOUDFLARE_ENV;
		}
	});

	it('merges config overrides into nested objects instead of replacing them', () => {
		const worker = resolveWorker(basicFixture, { config: { vars: { EXTRA: 'added' } } });
		expect(worker.config.vars).toMatchObject({ GREETING: 'hello', EXTRA: 'added' });
	});

	it('lets a config function edit the loaded config in place', () => {
		const worker = resolveWorker(basicFixture, {
			config: (config) => {
				config.compatibility_flags.push('nodejs_als');
			},
		});
		expect(worker.config.compatibility_flags).toContain('nodejs_als');
	});
});

describe('createOutputConfig', () => {
	it('rebases container Dockerfile paths onto the output directory', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rspack-plugin-cloudflare-'));
		try {
			await fs.mkdir(path.join(root, 'containers/app'), { recursive: true });
			await fs.writeFile(path.join(root, 'containers/app/Dockerfile'), 'FROM scratch\n');
			await fs.writeFile(path.join(root, 'wrangler.json'), JSON.stringify({
				name: 'containers',
				main: './index.ts',
				compatibility_date: '2026-10-23',
				containers: [{ class_name: 'App', image: './containers/app/Dockerfile' }],
				durable_objects: { bindings: [{ name: 'APP', class_name: 'App' }] },
				migrations: [{ tag: 'v1', new_sqlite_classes: ['App'] }],
			}));

			const config = createOutputConfig(resolveWorker(root, {}));
			expect(config.containers?.[0]?.image).toBe('../../containers/app/Dockerfile');
			expect(config.containers?.[0]?.image_build_context).toBe('../../containers/app');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('refuses an output directory inside the public assets directory', () => {
		expect(() => resolveWorker(basicFixture, { outputDir: 'build/worker' })).toThrow(/publicly served/);
	});
});
