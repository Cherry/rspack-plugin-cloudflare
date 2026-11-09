import path from 'node:path';

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import {
	rspackBin,
	run,
	startDevServer,
	wranglerBin,
} from './helpers.js';

const fixture = path.resolve(import.meta.dirname, 'fixtures/legacy-compat');

describe('Node.js compat on an older compatibility date', () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;

	beforeAll(async () => {
		const result = await run(rspackBin, ['build'], fixture);
		expect(result.code, result.output).toBe(0);
		// previewing the build with plain `wrangler dev`, which follows the deploy redirect to the bundled output
		server = await startDevServer(fixture, '/', port => [wranglerBin, 'dev', '--port', String(port)]);
	});

	afterAll(() => {
		server?.stop();
	});

	it('injects globals and polyfills what workerd lacks, leaving native modules external', async () => {
		expect(await server.getJson('/')).toEqual({ process: 'function', fsPromises: 'function', events: 'function' });
	});
});
