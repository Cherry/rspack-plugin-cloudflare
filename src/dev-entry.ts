import { fileURLToPath } from 'node:url';

import type { ResolvedWorker } from './config.js';

const RUNTIME_PATH = fileURLToPath(new URL('../runtime/dev-runtime.js', import.meta.url));

// these names are shared with runtime/dev-runtime.js
export const HMR_RUNNER_CLASS = '__RSPACK_HMR_RUNNER__';
export const HMR_TOKEN_BINDING = '__RSPACK_HMR_TOKEN__';
export const HMR_HEADER = 'x-rspack-plugin-cloudflare-hmr';

function toSpecifier(filePath: string) {
	return JSON.stringify(filePath.replaceAll('\\', '/'));
}

/** Export names we can know before building: `default` plus the Durable Object and Workflow classes this Worker owns. */
export function getConfiguredExports(worker: ResolvedWorker) {
	const names = new Set(['default']);
	for (const binding of worker.config.durable_objects.bindings) {
		if (!binding.script_name) {
			names.add(binding.class_name);
		}
	}
	for (const workflow of worker.config.workflows) {
		if (!workflow.script_name) {
			names.add(workflow.class_name);
		}
	}
	return [...names].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Source for the dev-only entry around `main`. It accepts hot updates to `main` so rspack re-evaluates the changed
 * modules in place, and re-exports each of the user's exports through a wrapper that always calls the current code.
 */
export function createDevEntrySource(main: string, exportNames: string[]) {
	const mainSpecifier = toSpecifier(main);
	const lines = [
		`import * as worker from ${mainSpecifier};`,
		`import { initialize, wrapExport, RspackHmrRunner } from ${toSpecifier(RUNTIME_PATH)};`,
		'initialize(() => worker);',
		`if (import.meta.webpackHot) import.meta.webpackHot.accept(${mainSpecifier});`,
		`export { RspackHmrRunner as ${HMR_RUNNER_CLASS} };`,
	];
	for (const [index, name] of exportNames.entries()) {
		// string export names cover anything the user exported, even names that aren't valid identifiers
		lines.push(`const export${index} = wrapExport(${JSON.stringify(name)});`, `export { export${index} as ${JSON.stringify(name)} };`);
	}
	return `${lines.join('\n')}\n`;
}
