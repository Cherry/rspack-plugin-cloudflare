import path from 'node:path';

import type { ResolvedWorker } from './config.js';

export type ModuleType = 'CompiledWasm' | 'Data' | 'Text';

// wrangler's defaults, which apply after any rules in the config
const DEFAULT_RULES: { type: ModuleType; globs: string[]; }[] = [
	{ type: 'Text', globs: ['**/*.txt', '**/*.html', '**/*.sql'] },
	{ type: 'Data', globs: ['**/*.bin'] },
	{ type: 'CompiledWasm', globs: ['**/*.wasm', '**/*.wasm?module'] },
];

const MODULE_TYPES: readonly string[] = ['CompiledWasm', 'Data', 'Text'] satisfies ModuleType[];

function isModuleType(type: string): type is ModuleType {
	return MODULE_TYPES.includes(type);
}

/** Maps file extensions to the non-JS module type wrangler would give them, with config rules taking precedence. */
export function getModuleTypes(worker: ResolvedWorker) {
	const types = new Map<string, ModuleType>();
	for (const rule of [...worker.config.rules, ...DEFAULT_RULES]) {
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
