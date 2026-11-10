import fs from 'node:fs';
import path from 'node:path';

import { convertToWranglerConfig, loadAndParseConfig } from '@cloudflare/config';
import { normalizeAndValidateConfig } from '@cloudflare/workers-utils';
import { unstable_readConfig } from 'wrangler';

import type {
	AuxiliaryWorkerOptions,
	CloudflarePluginOptions,
	WorkerConfig,
	WorkerConfigCustomizer,
} from './options.js';

const CLOUDFLARE_CONFIG_FILE_NAME = 'cloudflare.config.ts';
const WRANGLER_CONFIG_FILE_NAMES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

export interface ResolvedWorker {
	config: WorkerConfig;
	configPath: string;
	/** The config file and every local file it imports, any of which changing means the config must be read again. */
	configFiles: string[];
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
		const cloudflareConfigPath = path.join(directory, CLOUDFLARE_CONFIG_FILE_NAME);
		const wranglerConfigPath = WRANGLER_CONFIG_FILE_NAMES.map(fileName => path.join(directory, fileName)).find(candidate => fs.existsSync(candidate));
		if (fs.existsSync(cloudflareConfigPath)) {
			// mid-migration projects can have both, and quietly picking one would leave the other's edits ignored
			if (wranglerConfigPath) {
				throw new Error(`Found both ${cloudflareConfigPath} and ${wranglerConfigPath}. Remove one, or choose one with the \`configPath\` option.`);
			}
			return cloudflareConfigPath;
		}
		if (wranglerConfigPath) {
			return wranglerConfigPath;
		}
		const parent = path.dirname(directory);
		if (parent === directory) {
			throw new Error(`No Cloudflare config found in ${context} or its parents. Looked for ${[CLOUDFLARE_CONFIG_FILE_NAME, ...WRANGLER_CONFIG_FILE_NAMES].join(', ')}.`);
		}
		directory = parent;
	}
}

/** Loads `cloudflare.config.ts` into the same Config wrangler reads from its own files, the way `wrangler --experimental-new-config` does. */
async function readCloudflareConfig(configPath: string, mode: string | undefined, clientOutputPath: string | undefined) {
	const { result, dependencies } = await loadAndParseConfig(configPath, { isPreview: false, mode });
	if (!result.success) {
		const issues = result.error.issues.map(issue => `  - ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
		throw new Error(`Invalid ${configPath}:\n${issues.join('\n')}`);
	}
	if (!result.data.worker) {
		throw new Error(`${configPath} must define a Worker using the \`worker\` property.`);
	}
	const rawConfig = convertToWranglerConfig(result.data);
	// cloudflare.config.ts leaves the assets directory to the bundler, which Vite fills with its client build output
	if (rawConfig.assets && clientOutputPath) {
		rawConfig.assets.directory = clientOutputPath;
	}
	const { config, diagnostics } = normalizeAndValidateConfig(rawConfig, configPath, configPath, {}, true);
	if (diagnostics.hasErrors()) {
		throw new Error(diagnostics.renderErrors());
	}
	if (diagnostics.hasWarnings()) {
		console.warn(diagnostics.renderWarnings());
	}
	return { config, configFiles: [...new Set([configPath, ...dependencies])] };
}

async function readConfig(configPath: string, environment: string | undefined, clientOutputPath: string | undefined) {
	if (path.basename(configPath) === CLOUDFLARE_CONFIG_FILE_NAME) {
		// cloudflare.config.ts has no Wrangler environments; it reads the environment as its mode instead
		return readCloudflareConfig(configPath, environment, clientOutputPath);
	}
	// an explicit path skips wrangler's .wrangler/deploy redirect, which would otherwise point dev at our own build output
	const config = unstable_readConfig({ config: configPath, env: environment }, { preserveOriginalMain: true });
	return { config, configFiles: [configPath] };
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

/** Reads a Worker's config, with `clientOutputPath` (rspack's `output.path`) serving as the assets directory `cloudflare.config.ts` can't name. */
export async function resolveWorker(context: string, options: CloudflarePluginOptions, clientOutputPath?: string): Promise<ResolvedWorker> {
	const configPath = findConfigPath(context, options.configPath);
	const environment = options.environment ?? process.env.CLOUDFLARE_ENV;
	const { config, configFiles } = await readConfig(configPath, environment, clientOutputPath);
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
		configFiles,
		environment,
		name: config.name,
		main: config.main ? path.resolve(rootDir, config.main) : undefined,
		rootDir,
		assets,
		outputDir,
	};
}

/** Resolves an auxiliary Worker, which only the entry Worker's service bindings reach, so it can't serve assets. */
async function resolveAuxiliaryWorker(context: string, options: CloudflarePluginOptions, auxiliary: AuxiliaryWorkerOptions, clientOutputPath: string | undefined) {
	const worker = await resolveWorker(context, { ...auxiliary, environment: options.environment }, clientOutputPath);
	if (!worker.main) {
		throw new Error(`Auxiliary Worker config ${worker.configPath} needs a \`main\` entry.`);
	}
	if (worker.assets) {
		throw new Error(`Auxiliary Worker "${worker.name}" has \`assets\`, which only the entry Worker supports.`);
	}
	return worker;
}

/** A resolver per Worker, entry first, so a config change can re-read just the Worker it belongs to. */
export function getWorkerResolvers(context: string, options: CloudflarePluginOptions, clientOutputPath: string | undefined): (() => Promise<ResolvedWorker>)[] {
	return [
		() => resolveWorker(context, options, clientOutputPath),
		...(options.auxiliaryWorkers ?? []).map(auxiliary => () => resolveAuxiliaryWorker(context, options, auxiliary, clientOutputPath)),
	];
}
