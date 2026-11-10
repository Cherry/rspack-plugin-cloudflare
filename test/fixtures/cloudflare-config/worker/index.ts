interface Env {
	ASSETS: Fetcher;
	GREETING: string;
	MODE: string;
	KV: KVNamespace;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/api/config') {
			await env.KV.put('key', 'stored');
			return Response.json({ greeting: env.GREETING, mode: env.MODE, kv: await env.KV.get('key') });
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
