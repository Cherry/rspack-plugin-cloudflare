import { Buffer } from 'node:buffer';

import { DurableObject } from 'cloudflare:workers';

import addModule from './add.wasm';
import data from './data.bin';
import { suffix } from './greeting.js';
import logoUrl from './logo.svg';
import { hit } from './state.js';

interface Env {
	GREETING: string;
	SECRET: string;
	ASSETS: Fetcher;
	KV: KVNamespace;
	COUNTER: DurableObjectNamespace<Counter>;
}

export class Counter extends DurableObject {
	increment() {
		const count = (this.ctx.storage.kv.get<number>('count') ?? 0) + 1;
		this.ctx.storage.kv.put('count', count);
		return count;
	}
}

function throwFromWorker(): never {
	throw new Error('thrown in the fixture Worker');
}

function echoSocket() {
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	server.addEventListener('message', (event) => {
		server.send(`echo:${String(event.data)}`);
	});
	// workerd accepts 101 for WebSocket upgrades, unlike the fetch spec the rule follows
	// eslint-disable-next-line unicorn/no-invalid-response-options
	return new Response(null, { status: 101, webSocket: client });
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		switch (url.pathname) {
			case '/': {
				return new Response('<!doctype html><script src="/assets/main.js"></script>', { headers: { 'Content-Type': 'text/html' } });
			}
			case '/api/hello': {
				return Response.json({ message: `${env.GREETING} ${suffix}`, url: request.url });
			}
			case '/api/counter': {
				return Response.json({ count: await env.COUNTER.getByName('fixture').increment() });
			}
			case '/api/kv': {
				await env.KV.put('key', 'stored');
				return new Response(await env.KV.get('key'));
			}
			case '/api/asset': {
				const asset = await env.ASSETS.fetch(new URL(url.searchParams.get('path') ?? '/robots.txt', request.url));
				return new Response(await asset.text(), { status: asset.status });
			}
			case '/api/logo': {
				const logo = await env.ASSETS.fetch(new URL(logoUrl, request.url));
				return Response.json({ url: logoUrl, status: logo.status, body: await logo.text() });
			}
			case '/api/node': {
				return new Response(Buffer.from('node').toString('base64'));
			}
			case '/socket': {
				return echoSocket();
			}
			case '/api/secret': {
				return new Response(env.SECRET);
			}
			case '/api/scheduled': {
				return new Response(await env.KV.get('scheduled'));
			}
			case '/api/hits': {
				return Response.json({ hits: hit() });
			}
			case '/api/modules': {
				const { exports } = new WebAssembly.Instance(addModule);
				const add = exports.add as (a: number, b: number) => number;
				return Response.json({ wasm: add(2, 3), dataBytes: data.byteLength });
			}
			case '/api/throw': {
				throwFromWorker();
				break;
			}
		}
		return new Response('worker 404', { status: 404 });
	},
	async scheduled(controller, env) {
		await env.KV.put('scheduled', controller.cron);
	},
} satisfies ExportedHandler<Env>;
