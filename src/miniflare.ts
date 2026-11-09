import { createRequire } from 'node:module';

// wrangler's Miniflare options target its own Miniflare build, so load that copy rather than whichever one is hoisted
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));

export const miniflare = wranglerRequire('miniflare') as typeof import('miniflare');
