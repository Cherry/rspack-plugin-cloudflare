import fs from 'node:fs';
import path from 'node:path';

import { unstable_readConfig } from 'wrangler';

import type {
	AuxiliaryWorkerOptions,
	CloudflarePluginOptions,
	WorkerConfig,
	WorkerConfigCustomizer,
} from './options.js';

const CONFIG_FILE_NAMES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

export interface ResolvedWorker {
	config: WorkerConfig;
	configPath: string;
	environment: string | undefined;
	name: string;
	/** Undefined for assets-only projects, which deploy static files without a Worker. */
	main: string | undefined;
	/** Directory holding the Wrangler config; relative paths in the config resolve against it. */
	rootDir: string;
	assets: {
		directory: string;
		binding: string | undefined;
	} | undefined;
	outputDir: string;
}

function findConfigPath(context: string, configPath: string | undefined) {
	if (configPath) {
		return path.resolve(context, configPath);
	}
	// projects often point rspack's context at a source folder, so walk up like wrangler does
	let directory = context;
	while (true) {
		for (const fileName of CONFIG_FILE_NAMES) {
			const candidate = path.join(directory, fileName);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		const parent = path.dirname(directory);
		if (parent === directory) {
			throw new Error(`No Wrangler config found in ${context} or its parents. Looked for ${CONFIG_FILE_NAMES.join(', ')}.`);
		}
		directory = parent;
	}
}

function isInside(parent: string, child: string) {
	const relative = path.relative(parent, child);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merges plain objects so an override like `{ vars: { A: '1' } }` keeps the other vars; arrays are replaced. */
function mergeConfig(target: WorkerConfig | Record<string, unknown>, overrides: Partial<WorkerConfig> | Record<string, unknown>) {
	for (const [key, value] of Object.entries(overrides)) {
		const existing: unknown = Reflect.get(target, key);
		if (isPlainObject(existing) && isPlainObject(value)) {
			mergeConfig(existing, value);
		} else {
			Reflect.set(target, key, value);
		}
	}
}

function applyCustomizer(config: WorkerConfig, customizer: WorkerConfigCustomizer | undefined) {
	if (!customizer) {
		return;
	}
	const overrides = typeof customizer === 'function' ? customizer(config) : customizer;
	if (overrides) {
		mergeConfig(config, overrides);
	}
}

export function resolveWorker(context: string, options: CloudflarePluginOptions): ResolvedWorker {
	const configPath = findConfigPath(context, options.configPath);
	const environment = options.environment ?? process.env.CLOUDFLARE_ENV;
	// an explicit path skips wrangler's .wrangler/deploy redirect, which would otherwise point dev at our own build output
	const config = unstable_readConfig({ config: configPath, env: environment }, { preserveOriginalMain: true });
	applyCustomizer(config, options.config);
	const rootDir = path.dirname(configPath);

	if (!config.main && !config.assets?.directory) {
		throw new Error(`${configPath} needs a \`main\` Worker entry, or an \`assets.directory\` for an assets-only project.`);
	}
	if (!config.name) {
		throw new Error(`${configPath} has no \`name\`.`);
	}

	const assets = config.assets?.directory
		? { directory: path.resolve(rootDir, config.assets.directory), binding: config.assets.binding }
		: undefined;
	const outputDir = path.resolve(rootDir, options.outputDir ?? path.join('dist', config.name));

	// anything in the assets directory is publicly served, so the Worker bundle can't live there
	if (assets && isInside(assets.directory, outputDir)) {
		throw new Error(`outputDir (${outputDir}) is inside the assets directory (${assets.directory}); the Worker bundle would be publicly served.`);
	}

	return {
		config,
		configPath,
		environment,
		name: config.name,
		main: config.main ? path.resolve(rootDir, config.main) : undefined,
		rootDir,
		assets,
		outputDir,
	};
}

/** Resolves an auxiliary Worker, which only the entry Worker's service bindings reach, so it can't serve assets. */
function resolveAuxiliaryWorker(context: string, options: CloudflarePluginOptions, auxiliary: AuxiliaryWorkerOptions) {
	const worker = resolveWorker(context, { ...auxiliary, environment: options.environment });
	if (!worker.main) {
		throw new Error(`Auxiliary Worker config ${worker.configPath} needs a \`main\` entry.`);
	}
	if (worker.assets) {
		throw new Error(`Auxiliary Worker "${worker.name}" has \`assets\`, which only the entry Worker supports.`);
	}
	return worker;
}

/** A resolver per Worker, entry first, so a config change can re-read just the Worker it belongs to. */
export function getWorkerResolvers(context: string, options: CloudflarePluginOptions): (() => ResolvedWorker)[] {
	return [
		() => resolveWorker(context, options),
		...(options.auxiliaryWorkers ?? []).map(auxiliary => () => resolveAuxiliaryWorker(context, options, auxiliary)),
	];
}
