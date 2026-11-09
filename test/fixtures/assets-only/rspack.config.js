import path from 'node:path';

import { CopyRspackPlugin } from '@rspack/core';

import { cloudflare } from '../../../dist/index.js';

export default {
	context: import.meta.dirname,
	entry: { main: './client/index.js' },
	output: {
		path: path.resolve(import.meta.dirname, 'build'),
		publicPath: '/',
		filename: '[name].js',
		clean: true,
	},
	plugins: [
		new CopyRspackPlugin({ patterns: [{ from: 'public' }] }),
		cloudflare(),
	],
	devServer: {
		port: Number(process.env.PORT ?? 8788),
		hot: true,
		client: { overlay: false },
	},
};
