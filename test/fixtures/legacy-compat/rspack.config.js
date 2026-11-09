import path from 'node:path';

import { cloudflare } from '../../../dist/index.js';

// no client of its own; the Worker is built alongside an empty entry
export default {
	context: import.meta.dirname,
	entry: { main: 'data:text/javascript,' },
	output: { path: path.resolve(import.meta.dirname, 'build'), clean: true },
	plugins: [cloudflare()],
};
