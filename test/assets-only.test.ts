import fs from 'node:fs/promises';
import path from 'node:path';

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import {
	assetsOnlyFixture,
	rspackBin,
	run,
	startDevServer,
	wranglerBin,
} from './helpers.js';

describe('assets-only projects', () => {
	describe('rspack serve', () => {
		let server: Awaited<ReturnType<typeof startDevServer>>;

		beforeAll(async () => {
			server = await startDevServer(assetsOnlyFixture, '/');
		});

		afterAll(() => {
			server?.stop();
		});

		it('serves html with the default auto-trailing-slash handling', async () => {
			expect(await server.getText('/')).toContain('<title>assets-only</title>');
			expect(await server.getText('/docs')).toContain('<title>docs</title>');
		});

		it('falls back to index.html for single-page-application routing', async () => {
			const response = await fetch(`${server.origin}/some/client/route`);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain('<title>assets-only</title>');
		});

		it('serves the in-memory client build', async () => {
			expect(await server.getText('/main.js')).toContain('hot/dev-server');
		});
	});

	describe('rspack build', () => {
		beforeAll(async () => {
			const result = await run(rspackBin, ['build'], assetsOnlyFixture);
			expect(result.code, result.output).toBe(0);
		});

		it('writes a config without a Worker that wrangler deploy accepts', async () => {
			const config = JSON.parse(await fs.readFile(path.join(assetsOnlyFixture, 'dist/assets-fixture/wrangler.json'), 'utf8')) as Record<string, unknown>;
			expect(config.main).toBeUndefined();
			expect(config.assets).toMatchObject({ directory: '../../build', not_found_handling: 'single-page-application' });

			const result = await run(wranglerBin, ['deploy', '--dry-run'], assetsOnlyFixture);
			expect(result.code, result.output).toBe(0);
			expect(result.output).toContain('Using redirected Wrangler configuration');
		});
	});
});
