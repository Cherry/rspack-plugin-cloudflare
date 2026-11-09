import path from 'node:path';

import { CopyRspackPlugin } from '@rspack/core';

import { cloudflare } from '../../../dist/index.js';

export default {
	context: import.meta.dirname,
	entry: { main: './client/index.js' },
	output: {
		path: path.resolve(import.meta.dirname, 'build/assets'),
		publicPath: '/assets/',
		filename: '[name].js',
		clean: true,
	},
	plugins: [
		new CopyRspackPlugin({ patterns: [{ from: 'public', to: path.resolve(import.meta.dirname, 'build') }] }),
		cloudflare(),
	],
	devServer: {
		port: Number(process.env.PORT ?? 8787),
		hot: true,
		client: { overlay: false },
	},
};
