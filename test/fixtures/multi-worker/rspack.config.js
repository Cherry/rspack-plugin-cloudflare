import path from 'node:path';

import { cloudflare } from '../../../dist/index.js';

// no client of its own; the Workers are built alongside an empty entry
export default {
	context: import.meta.dirname,
	entry: { main: 'data:text/javascript,' },
	output: { path: path.resolve(import.meta.dirname, 'build'), clean: true },
	plugins: [cloudflare({ auxiliaryWorkers: [{ configPath: './auxiliary/wrangler.jsonc' }] })],
	devServer: { hot: true, client: { overlay: false } },
};
