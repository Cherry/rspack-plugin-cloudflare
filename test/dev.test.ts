import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';
import WebSocket from 'ws';

import { basicFixture, startDevServer, waitFor } from './helpers.js';

const greetingPath = path.join(basicFixture, 'worker/greeting.ts');

function openHmrSocket(origin: string) {
	const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { origin } });
	const messages: { type: string; data?: unknown; }[] = [];
	socket.on('message', (data) => {
		messages.push(JSON.parse(String(data)) as { type: string; data?: unknown; });
	});
	return { socket, messages };
}

describe('rspack serve', () => {
	let server: Awaited<ReturnType<typeof startDevServer>>;
	let originalGreeting = '';

	beforeAll(async () => {
		originalGreeting = await fs.readFile(greetingPath, 'utf8');
		// stale KV from an earlier run could make the scheduled handler test pass without the handler running
		await fs.rm(path.join(basicFixture, '.wrangler/state'), { recursive: true, force: true });
		server = await startDevServer(basicFixture, '/api/hello');
	});

	afterAll(async () => {
		server?.stop();
		await fs.writeFile(greetingPath, originalGreeting);
	});

	it('serves Worker routes with the request URL the browser used', async () => {
		expect(await server.getJson('/api/hello')).toEqual({ message: 'hello from the worker', url: `${server.origin}/api/hello` });
	});

	it('runs Durable Objects and KV from the Wrangler config', async () => {
		const first = await server.getJson<{ count: number; }>('/api/counter');
		const second = await server.getJson<{ count: number; }>('/api/counter');
		expect(second.count).toBe(first.count + 1);
		expect(await server.getText('/api/kv')).toBe('stored');
	});

	it('loads secrets from .env like wrangler dev', async () => {
		expect(await server.getText('/api/secret')).toBe('from-dotenv');
	});

	it('serves rules excluded from run_worker_first straight from the client build', async () => {
		const response = await fetch(`${server.origin}/assets/main.js`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('javascript');
		// only the in-memory dev build includes the HMR client, which proves this didn't come from disk
		expect(await response.text()).toContain('hot/dev-server');
	});

	it('applies _headers and _redirects from the build, like the deployed asset Worker', async () => {
		const robots = await fetch(`${server.origin}/robots.txt`);
		expect(robots.headers.get('x-fixture')).toBe('from-headers');
		// dev files keep their names across rebuilds, so nothing may tell the browser to reuse them
		expect(robots.headers.get('etag')).toBeNull();

		const redirect = await fetch(`${server.origin}/assets/old.js`, { redirect: 'manual' });
		expect(redirect.status).toBe(301);
		expect(redirect.headers.get('location')).toBe('/assets/main.js');
	});

	it('never serves the rules files themselves, since Cloudflare doesn\'t upload them', async () => {
		const response = await fetch(`${server.origin}/api/asset?path=/_headers`);
		expect(response.status).toBe(404);
	});

	it('gives the Worker an ASSETS binding backed by the dev build', async () => {
		expect(await server.getText('/api/asset')).toContain('User-agent');
	});

	it('resolves node: builtins in workerd', async () => {
		expect(await server.getText('/api/node')).toBe(Buffer.from('node').toString('base64'));
	});

	it('loads imported .wasm and .bin files as their own modules', async () => {
		expect(await server.getJson('/api/modules')).toEqual({ wasm: 5, dataBytes: 5 });
	});

	it('serves assets imported by Worker code at the URL the import returns', async () => {
		const logo = await server.getJson<{ url: string; status: number; body: string; }>('/api/logo');
		expect(logo.url).toMatch(/^\/assets\/logo\.[\da-f]{8}\.svg$/);
		expect(logo).toMatchObject({ status: 200, body: expect.stringContaining('fixture logo') as unknown });
		const response = await fetch(`${server.origin}${logo.url}`);
		expect(response.headers.get('content-type')).toBe('image/svg+xml');
	});

	it('forwards WebSocket upgrades to the Worker', async () => {
		const socket = new WebSocket(`${server.origin.replace('http', 'ws')}/socket`);
		const reply = await new Promise<string>((resolve, reject) => {
			socket.on('open', () => socket.send('ping'));
			socket.on('message', data => resolve(String(data)));
			socket.on('error', reject);
		});
		socket.close();
		expect(reply).toBe('echo:ping');
	});

	it('shows uncaught Worker errors with a source-mapped stack', async () => {
		const response = await fetch(`${server.origin}/api/throw`, { headers: { accept: 'text/html' } });
		expect(response.status).toBe(500);
		const page = await response.text();
		expect(page).toContain('thrown in the fixture Worker');
		expect(page).toMatch(/worker[/\\]index\.ts:\d+/);
	});

	it('runs scheduled handlers through /cdn-cgi/handler/scheduled', async () => {
		const response = await fetch(`${server.origin}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
		expect(response.status).toBe(200);
		expect(await server.getText('/api/scheduled')).toBe('* * * * *');
	});

	it('links /__debug to DevTools for the Worker', async () => {
		const page = await server.getText('/__debug');
		expect(page).toContain('devtools.devprod.cloudflare.dev');
		expect(page).toContain('%2Ffixture');
	});

	it('hot updates edited modules in place, keeping other modules\' state and Durable Object storage', async () => {
		const countBefore = await server.getJson<{ count: number; }>('/api/counter');
		const hitsBefore = await server.getJson<{ hits: number; }>('/api/hits');
		await fs.writeFile(greetingPath, originalGreeting.replace('from the worker', 'from the edited worker'));
		const message = await waitFor(async () => {
			const { message: current } = await server.getJson<{ message: string; }>('/api/hello');
			return current.includes('edited') ? current : undefined;
		});
		expect(message).toBe('hello from the edited worker');
		expect(server.output).toContain('Worker "fixture" hot updated');

		// a restart would have reset this module-level counter to 1
		const hitsAfter = await server.getJson<{ hits: number; }>('/api/hits');
		expect(hitsAfter.hits, server.output).toBe(hitsBefore.hits + 1);
		// the Durable Object runs the re-evaluated class against the same storage
		const countAfter = await server.getJson<{ count: number; }>('/api/counter');
		expect(countAfter.count, server.output).toBe(countBefore.count + 1);
	});

	it('restarts the Worker when its exports change, since workerd binds them at startup', async () => {
		const indexPath = path.join(basicFixture, 'worker/index.ts');
		const originalIndex = await fs.readFile(indexPath, 'utf8');
		try {
			// workerd only accepts handler-shaped exports from the main module, so add a real entrypoint
			const addedEntrypoint = 'import { WorkerEntrypoint } from \'cloudflare:workers\';\nexport class Added extends WorkerEntrypoint {}\n';
			await fs.writeFile(indexPath, `${originalIndex}\n${addedEntrypoint}`);
			await waitFor(async () => (server.output.includes('Worker "fixture" restarted: its exports changed') ? true : undefined));
			expect(await server.getJson('/api/hello')).toMatchObject({ message: expect.stringContaining('hello') });
			expect(server.output).not.toContain('Incorrect type for map entry');
		} finally {
			await fs.writeFile(indexPath, originalIndex);
		}
	});

	it('reports Worker build errors to the browser overlay and clears them once fixed', async () => {
		const { socket, messages } = openHmrSocket(server.origin);
		await once(socket, 'open');
		try {
			await fs.writeFile(greetingPath, 'export const suffix = ;\n');
			const errors = await waitFor(async () => messages.find(message => message.type === 'errors'));
			expect(JSON.stringify(errors.data)).toContain(String.raw`Worker \"fixture\"`);

			await fs.writeFile(greetingPath, originalGreeting);
			await waitFor(async () => messages.find(message => message.type === 'still-ok'));
			expect(await server.getJson('/api/hello')).toMatchObject({ message: 'hello from the worker' });
		} finally {
			socket.close();
		}
	});

	it('picks up _headers edits, which the asset Worker only reads when it starts', async () => {
		const headersPath = path.join(basicFixture, 'public/_headers');
		const originalHeaders = await fs.readFile(headersPath, 'utf8');
		try {
			await fs.writeFile(headersPath, originalHeaders.replace('from-headers', 'edited-headers'));
			const value = await waitFor(async () => {
				const response = await fetch(`${server.origin}/robots.txt`);
				const header = response.headers.get('x-fixture');
				return header === 'edited-headers' ? header : undefined;
			});
			expect(value).toBe('edited-headers');
		} finally {
			await fs.writeFile(headersPath, originalHeaders);
		}
	});
});
