import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// the build and dev suites share the fixture's output directories
		fileParallelism: false,
		testTimeout: 60000,
		hookTimeout: 60000,
		env: {
			WRANGLER_SEND_METRICS: 'false',
		},
	},
});
