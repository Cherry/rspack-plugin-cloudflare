// Cloudflare's router Worker, unchanged; the outer entrypoint reaches the inner one through ctx.exports.
export {
	default,
	RouterInnerEntrypoint,
	RouterOuterEntrypoint,
} from '../../../workers-sdk/packages/workers-shared/router-worker/index.js';
