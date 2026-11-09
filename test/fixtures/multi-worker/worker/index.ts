import type { AuxRpc } from '../auxiliary/index.js';

interface Env {
	LABEL: string;
	AUX: Fetcher;
	AUX_RPC: Service<AuxRpc>;
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === '/rpc') {
			return new Response(await env.AUX_RPC.greet(env.LABEL));
		}
		const aux = await env.AUX.fetch(request);
		return new Response(`${env.LABEL}: ${await aux.text()}`);
	},
} satisfies ExportedHandler<Env>;
