import { describe, expect, it } from 'vitest';

import { parseStaticRouting, routeRequest } from '../src/routing.js';

describe('routeRequest', () => {
	it('lets negative rules win over a catch-all, like Cloudflare\'s router', () => {
		const routing = parseStaticRouting(['/*', '!/assets/*']);
		expect(routeRequest(routing, '/assets/js/app.js', true)).toBe('asset');
		expect(routeRequest(routing, '/dashboard', true)).toBe('worker');
	});

	it('matches wildcards across path segments', () => {
		const routing = parseStaticRouting(['/api/*']);
		expect(routeRequest(routing, '/api/v1/users', true)).toBe('worker');
		expect(routeRequest(routing, '/apix', true)).toBe('asset-then-worker');
	});

	it('treats regex characters in rules literally', () => {
		const routing = parseStaticRouting(['/file.txt']);
		expect(routeRequest(routing, '/file.txt', true)).toBe('worker');
		expect(routeRequest(routing, '/fileXtxt', true)).toBe('asset-then-worker');
	});

	it('sends everything to the Worker when run_worker_first is true', () => {
		expect(routeRequest(parseStaticRouting(true), '/assets/app.js', true)).toBe('worker');
	});

	it('checks assets before the Worker when there are no rules', () => {
		expect(routeRequest(parseStaticRouting(undefined), '/', true)).toBe('asset-then-worker');
	});

	it('sends everything to the Worker when there are no assets', () => {
		expect(routeRequest(parseStaticRouting(['/*', '!/assets/*']), '/assets/app.js', false)).toBe('worker');
	});

	it('rejects rules that do not start with a slash', () => {
		expect(() => parseStaticRouting(['api/*'])).toThrow(/must start with/);
	});
});
