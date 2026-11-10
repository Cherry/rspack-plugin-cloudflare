// projects import these from `cf/config`, which re-exports this same package
import { bindings, defineConfig } from '@cloudflare/config/public';

import { greeting } from './greeting.ts';
import * as entrypoint from './worker/index.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => {
	return {
		worker: {
			name: 'cloudflare-config-fixture',
			entrypoint,
			compatibilityDate: '2026-10-23',
			assets: { runWorkerFirst: ['/api/*'] },
			env: {
				ASSETS: bindings.assets(),
				GREETING: bindings.text(greeting),
				MODE: bindings.text(mode ?? 'none'),
				KV: bindings.kv({ id: 'fixture-kv' }),
			},
		},
	};
});
