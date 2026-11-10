import { fileURLToPath } from 'node:url';

import { getCloudflarePreset } from '@cloudflare/unenv-preset';
import * as miniflare from 'miniflare';
import { defineEnv } from 'unenv';

import type { ResolvedWorker } from './config.js';

export interface NodeJsCompat {
	/** Builtin specifiers workerd provides natively, mapped to the specifier to import at runtime. */
	externals: Map<string, string>;
	/** Builtin specifiers workerd lacks, mapped to the unenv polyfill file that replaces them. */
	polyfills: Map<string, string>;
	/** A module that sets up injected globals like `process` and runs polyfills, when the preset needs any. */
	injectSource: string | undefined;
}

function resolvePolyfill(specifier: string) {
	// polyfills are this package's dependencies, which the user's project can't necessarily resolve
	return fileURLToPath(import.meta.resolve(specifier));
}

function createInjectSource(inject: Record<string, string | readonly string[]>, polyfills: readonly string[]) {
	const lines: string[] = [];
	for (const [index, [globalName, specifier]] of Object.entries(inject).entries()) {
		const [moduleSpecifier, exportName] = typeof specifier === 'string' ? [specifier, 'default'] : specifier;
		if (!moduleSpecifier || !exportName) {
			continue;
		}
		lines.push(
			`import { ${exportName} as inject${index} } from ${JSON.stringify(resolvePolyfill(moduleSpecifier))};`,
			`globalThis.${globalName} = inject${index};`,
		);
	}
	for (const polyfill of polyfills) {
		lines.push(`import ${JSON.stringify(resolvePolyfill(polyfill))};`);
	}
	return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Applies Cloudflare's unenv preset, as wrangler and the Vite plugin do: modules workerd has natively stay external,
 * the rest are polyfilled, and globals like `process` are injected for older compatibility dates.
 */
export function getNodeJsCompat(worker: ResolvedWorker): NodeJsCompat | undefined {
	const { compatibility_date: compatibilityDate, compatibility_flags: compatibilityFlags } = worker.config;
	if (!miniflare.getNodeCompat(compatibilityDate, compatibilityFlags).isNodejsCompatEnabled) {
		return undefined;
	}
	const { env } = defineEnv({ presets: [getCloudflarePreset({ compatibilityDate, compatibilityFlags })] });
	const nativeModules = new Set(env.external);
	const externals = new Map<string, string>();
	const polyfills = new Map<string, string>();
	for (const [specifier, target] of Object.entries(env.alias)) {
		if (nativeModules.has(target)) {
			externals.set(specifier, target);
		} else {
			polyfills.set(specifier, resolvePolyfill(target));
		}
	}
	return { externals, polyfills, injectSource: createInjectSource(env.inject, env.polyfill) };
}
