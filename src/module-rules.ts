import path from 'node:path';

import { DEFAULT_MODULE_RULES } from '@cloudflare/workers-utils';

import type { ResolvedWorker } from './config.js';

export type ModuleType = 'CompiledWasm' | 'Data' | 'Text';

const MODULE_TYPES: readonly string[] = ['CompiledWasm', 'Data', 'Text'] satisfies ModuleType[];

function isModuleType(type: string): type is ModuleType {
	return MODULE_TYPES.includes(type);
}

/** Maps file extensions to the non-JS module type wrangler would give them, with config rules taking precedence. */
export function getModuleTypes(worker: ResolvedWorker) {
	const types = new Map<string, ModuleType>();
	// wrangler's defaults apply after any rules in the config
	for (const rule of [...worker.config.rules, ...DEFAULT_MODULE_RULES]) {
		if (!isModuleType(rule.type)) {
			continue;
		}
		for (const glob of rule.globs) {
			// wrangler's module rules use `**/*.ext` style globs, so the extension is all that matters
			const extension = path.extname(glob.replace(/\?.*$/, ''));
			if (extension && !types.has(extension)) {
				types.set(extension, rule.type);
			}
		}
	}
	return types;
}
