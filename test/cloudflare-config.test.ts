import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';

import {
	cloudflareConfigFixture,
	rspackBin,
	run,
	startDevServer,
	waitFor,
	wranglerBin,
} from './helpers.js';
import { resolveWorker } from '../src/config.js';

const greetingPath = path.join(cloudflareConfigFixture, 'greeting.ts');
const clientOutputPath = path.join(cloudflareConfigFixture, 'build');

describe('cloudflare.config.ts', () => {
	describe('resolveWorker', () => {
		it('passes the environment to the config as its mode', async () => {
			const worker = await resolveWorker(cloudflareConfigFixture, { environment: 'staging' }, clientOutputPath);
			expect(worker.config.vars).toMatchObject({ GREETING: 'hello from cloudflare.config.ts', MODE: 'staging' });
		});

		it('serves the client build as assets, since cloudflare.config.ts leaves the directory to the bundler', async () => {
			const worker = await resolveWorker(cloudflareConfigFixture, {}, clientOutputPath);
			expect(worker.assets).toEqual({ directory: clientOutputPath, binding: 'ASSETS' });
		});

		it('tracks files the config imports, so editing them reloads the config', async () => {
			const worker = await resolveWorker(cloudflareConfigFixture, {}, clientOutputPath);
			expect(worker.configFiles).toContain(greetingPath);
		});

		describe('in a project with other configs', () => {
			let root = '';

			beforeEach(async () => {
				root = await fs.mkdtemp(path.join(os.tmpdir(), 'rspack-plugin-cloudflare-'));
			});

			afterEach(async () => {
				await fs.rm(root, { recursive: true, force: true });
			});

			it('refuses to guess between cloudflare.config.ts and a Wrangler config', async () => {
				await fs.writeFile(path.join(root, 'cloudflare.config.ts'), 'export default {};\n');
				await fs.writeFile(path.join(root, 'wrangler.jsonc'), '{}');
				await expect(resolveWorker(root, {})).rejects.toThrow(/Found both/);
			});

			it('reports invalid config fields by path', async () => {
				await fs.writeFile(path.join(root, 'cloudflare.config.ts'), 'export default { worker: { name: 1, compatibilityDate: "2026-10-23" } };\n');
				await expect(resolveWorker(root, {})).rejects.toThrow(/worker\.name/);
			});
		});
	});

	describe('rspack build', () => {
		beforeAll(async () => {
			await fs.rm(path.join(cloudflareConfigFixture, 'dist'), { recursive: true, force: true });
			await fs.rm(path.join(cloudflareConfigFixture, '.wrangler'), { recursive: true, force: true });
			const result = await run(rspackBin, ['build'], cloudflareConfigFixture);
			expect(result.code, result.output).toBe(0);
		});

		it('writes a deploy config that plain wrangler deploy accepts', async () => {
			const result = await run(wranglerBin, ['deploy', '--dry-run'], cloudflareConfigFixture);
			expect(result.code, result.output).toBe(0);
			expect(result.output).toContain('Using redirected Wrangler configuration');
			expect(result.output).toContain('env.KV (fixture-kv)');
			expect(result.output).toMatch(/assets directory .*fixtures[/\\]cloudflare-config[/\\]build/);
		});
	});

	describe('rspack serve', () => {
		let server: Awaited<ReturnType<typeof startDevServer>>;
		let originalGreeting = '';

		beforeAll(async () => {
			originalGreeting = await fs.readFile(greetingPath, 'utf8');
			server = await startDevServer(cloudflareConfigFixture, '/api/config');
		});

		afterAll(async () => {
			server?.stop();
			await fs.writeFile(greetingPath, originalGreeting);
		});

		it('runs the Worker with the bindings and assets from cloudflare.config.ts', async () => {
			expect(await server.getJson('/api/config')).toEqual({ greeting: 'hello from cloudflare.config.ts', mode: 'none', kv: 'stored' });
			expect(await server.getText('/')).toContain('<title>cloudflare-config</title>');
		});

		it('reloads the config when a file it imports changes', async () => {
			await fs.writeFile(greetingPath, originalGreeting.replace('hello', 'howdy'));
			const config = await waitFor(async () => {
				const result = await server.getJson<{ greeting: string; }>('/api/config');
				return result.greeting.startsWith('howdy') ? result : undefined;
			});
			expect(config.greeting).toBe('howdy from cloudflare.config.ts');
		});

		it('keeps serving the previous config while an edit leaves it broken', async () => {
			await fs.writeFile(greetingPath, 'export const greeting = ;\n');
			await waitFor(async () => (server.output.includes('failed to reload its config') ? true : undefined));
			expect(await server.getJson('/api/config')).toMatchObject({ greeting: 'howdy from cloudflare.config.ts' });
		});
	});
});
