import { createRequire } from 'node:module';

import type * as Miniflare from 'miniflare';

// wrangler (a peer dependency) builds the Miniflare options, so run them with the Miniflare that version of wrangler ships
const requireFromWrangler = createRequire(import.meta.resolve('wrangler'));

export const miniflare = requireFromWrangler('miniflare') as typeof Miniflare;
