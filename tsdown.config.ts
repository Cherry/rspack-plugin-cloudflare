import { defineConfig } from 'tsdown';

import type { UserConfig } from 'tsdown';

// the internal Workers run as single modules, with workers-shared bundled in from the workers-sdk submodule
function worker(name: string): UserConfig {
	return {
		entry: { index: `src/workers/${name}/index.ts` },
		outDir: `dist/workers/${name}`,
		platform: 'neutral',
		tsconfig: 'src/workers/tsconfig.json',
		deps: { neverBundle: ['cloudflare:workers'] },
		// the neutral platform has no default, so packages like toucan-js wouldn't resolve
		inputOptions: { resolve: { mainFields: ['module', 'main'] } },
		fixedExtension: false,
		sourcemap: true,
		dts: false,
	};
}

export default defineConfig([
	{
		entry: { index: 'src/index.ts' },
		outDir: 'dist',
		platform: 'node',
		fixedExtension: false,
		sourcemap: true,
		dts: true,
	},
	worker('asset-worker'),
	worker('router-worker'),
]);
