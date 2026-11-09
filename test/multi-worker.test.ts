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
	rspackBin,
	run,
	startDevServer,
	waitFor,
} from './helpers.js';

const fixture = path.resolve(import.meta.dirname, 'fixtures/multi-worker');
const messagePath = path.join(fixture, 'auxiliary/message.ts');
const configPath = path.join(fixture, 'wrangler.jsonc');

describe('auxiliary Workers', () => {
	describe('rspack serve', () => {
		let server: Awaited<ReturnType<typeof startDevServer>>;
		let originalMessage = '';
		let originalConfig = '';

		beforeAll(async () => {
			originalMessage = await fs.readFile(messagePath, 'utf8');
			originalConfig = await fs.readFile(configPath, 'utf8');
			server = await startDevServer(fixture, '/');
		});

		afterAll(async () => {
			server?.stop();
			await fs.writeFile(messagePath, originalMessage);
			await fs.writeFile(configPath, originalConfig);
		});

		it('reaches the auxiliary Worker through fetch and RPC service bindings', async () => {
			expect(await server.getText('/')).toBe('first: from aux');
			expect(await server.getText('/rpc')).toBe('first from aux over rpc');
		});

		it('hot updates the auxiliary Worker, including its named entrypoints', async () => {
			await fs.writeFile(messagePath, originalMessage.replace('from aux', 'from edited aux'));
			await waitFor(async () => {
				const body = await server.getText('/');
				return body.includes('edited') ? body : undefined;
			});
			expect(server.output).toContain('Worker "aux-worker" hot updated');
			expect(await server.getText('/rpc')).toBe('first from edited aux over rpc');
		});

		it('rebuilds a Worker when its Wrangler config changes', async () => {
			await fs.writeFile(configPath, originalConfig.replace('"first"', '"second"'));
			const text = await waitFor(async () => {
				const body = await server.getText('/');
				return body.startsWith('second') ? body : undefined;
			});
			expect(text).toMatch(/^second: /);
			expect(server.output).toContain('Worker "entry-worker" config changed');
		});
	});

	describe('rspack build', () => {
		beforeAll(async () => {
			const result = await run(rspackBin, ['build'], fixture);
			expect(result.code, result.output).toBe(0);
		});

		it('builds every Worker and points the deploy redirect at all of them', async () => {
			const deployConfig = JSON.parse(await fs.readFile(path.join(fixture, '.wrangler/deploy/config.json'), 'utf8')) as unknown;
			expect(deployConfig).toEqual({
				configPath: '../../dist/entry-worker/wrangler.json',
				auxiliaryWorkers: [{ configPath: '../../auxiliary/dist/aux-worker/wrangler.json' }],
			});
			const auxConfig = JSON.parse(await fs.readFile(path.join(fixture, 'auxiliary/dist/aux-worker/wrangler.json'), 'utf8')) as Record<string, unknown>;
			expect(auxConfig).toMatchObject({ name: 'aux-worker', main: 'index.js', no_bundle: true });
		});
	});
});
