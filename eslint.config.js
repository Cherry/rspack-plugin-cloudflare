import nodecraft from '@nodecraft/eslint-config';

const jsonIgnore = ['**/*.json'];
function withJsonIgnore(configs) {
	return configs.map((config) => {
		return { ...config, ignores: [...(config.ignores || []), ...jsonIgnore] };
	});
}

// the typescript config repeats base; keep only its TypeScript additions so they layer over the node config
const base = new Set(nodecraft.configs.base);
const typescript = nodecraft.configs.typescript
	.filter(config => !base.has(config))
	.map((config) => {
		return { ...config, files: config.files ?? ['**/*.ts'] };
	});

export default [
	{
		ignores: [
			'**/dist/**',
			'**/build/**',
			'**/.wrangler/**',
			'workers-sdk/**',
		],
	},

	...withJsonIgnore(nodecraft.configs.base),
	...withJsonIgnore(nodecraft.configs.node),
	...typescript,
	...nodecraft.configs.json,

	{
		files: ['runtime/**'],
		rules: {
			// the runtime is bundled into the Worker, where workerd provides cloudflare: modules Node can't resolve
			'n/no-missing-import': 'off',
		},
	},
	{
		files: ['test/fixtures/**'],
		rules: {
			// fixtures resolve rspack through this package's own node_modules, not a dependency of their own
			'n/no-extraneous-import': 'off',
			// fixtures load the built plugin from dist/, which doesn't exist until a build, so lint can't depend on it
			'n/no-missing-import': 'off',
		},
	},
];
