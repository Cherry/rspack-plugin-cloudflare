interface StaticRouting {
	/** Paths that always go to the Worker. */
	userWorker: RegExp[];
	/** Paths that always skip the Worker, from `!/` rules. */
	assetWorker: RegExp[];
}

function ruleToRegExp(rule: string) {
	const escaped = rule.split('*').map(part => part.replaceAll(/[$()+.?[\\\]^{|}]/g, String.raw`\$&`));
	return new RegExp(`^${escaped.join('.*')}$`);
}

/** Mirrors `assets.run_worker_first`, where `true` sends everything to the Worker and an array holds `/` and `!/` glob rules. */
export function parseStaticRouting(runWorkerFirst: boolean | string[] | undefined): StaticRouting {
	if (runWorkerFirst === true) {
		return { userWorker: [/^\/.*$/], assetWorker: [] };
	}
	const routing: StaticRouting = { userWorker: [], assetWorker: [] };
	if (!Array.isArray(runWorkerFirst)) {
		return routing;
	}
	for (const rule of runWorkerFirst) {
		if (rule.startsWith('!/')) {
			routing.assetWorker.push(ruleToRegExp(rule.slice(1)));
		} else if (rule.startsWith('/')) {
			routing.userWorker.push(ruleToRegExp(rule));
		} else {
			throw new Error(`Invalid \`run_worker_first\` rule '${rule}': rules must start with '/' or '!/'.`);
		}
	}
	return routing;
}

type Route = 'worker' | 'asset' | 'asset-then-worker';

/** Negative rules win over positive ones, matching Cloudflare's router. */
export function routeRequest(routing: StaticRouting, pathname: string, hasAssets: boolean): Route {
	if (!hasAssets) {
		return 'worker';
	}
	if (routing.assetWorker.some(rule => rule.test(pathname))) {
		return 'asset';
	}
	if (routing.userWorker.some(rule => rule.test(pathname))) {
		return 'worker';
	}
	return 'asset-then-worker';
}
