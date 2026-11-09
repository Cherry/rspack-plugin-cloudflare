import { WorkerEntrypoint } from 'cloudflare:workers';

import { message } from './message.js';

export class AuxRpc extends WorkerEntrypoint {
	greet(label: string) {
		return `${label} ${message} over rpc`;
	}
}

export default {
	fetch() {
		return new Response(message);
	},
} satisfies ExportedHandler;
