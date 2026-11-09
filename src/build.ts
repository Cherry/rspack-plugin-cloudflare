import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { unstable_getVarsForDev } from 'wrangler';

import { IMPORTED_ASSETS_DIR, createWorkerConfig } from './worker-config.js';

import type { ResolvedWorker } from './config.js';
import type { CloudflarePluginOptions } from './options.js';
import type { Compiler, Stats } from '@rspack/core';

// readConfig bookkeeping and bundling settings that rspack has already applied, so deploy must not apply them again
const OMITTED_CONFIG_KEYS = new Set([
	'configPath',
	'userConfigPath',
	'topLevelName',
	'definedEnvironments',
	'targetEnvironment',
	'build',
	'define',
	'alias',
	'tsconfig',
	'find_additional_modules',
	'base_dir',
	'preserve_file_names',
]);

/** The Wrangler config `wrangler deploy` reads for the built Worker, with every path rebased onto the output directory. */
export function createOutputConfig(worker: ResolvedWorker) {
	const rebase = (filePath: string) => path.relative(worker.outputDir, path.resolve(worker.rootDir, filePath)).replaceAll('\\', '/') || '.';
	const config = Object.fromEntries(Object.entries(worker.config).filter(([key]) => !OMITTED_CONFIG_KEYS.has(key)));
	// readConfig always fills in `unsafe`, and wrangler warns about it being experimental even when empty
	if (worker.config.unsafe && Object.keys(worker.config.unsafe).length === 0) {
		delete config.unsafe;
	}

	// wrangler's defaults already cover .wasm and .bin beside the bundle; custom binary rules have to come along
	const binaryRules = worker.config.rules.filter(rule => rule.type === 'CompiledWasm' || rule.type === 'Data');
	const bundled = worker.main
		? { main: 'index.js', no_bundle: true, rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }, ...binaryRules] }
		: { main: undefined };

	return {
		...config,
		...bundled,
		assets: worker.assets ? { ...worker.config.assets, directory: rebase(worker.assets.directory) } : undefined,
		containers: worker.config.containers?.map((container) => {
			const rebased = { ...container };
			// image is either a Dockerfile path or a registry reference; readConfig makes paths absolute, so only those need rebasing
			if (container.image && path.isAbsolute(container.image)) {
				rebased.image = rebase(container.image);
			}
			if (container.image_build_context) {
				rebased.image_build_context = rebase(container.image_build_context);
			}
			return rebased;
		}),
		upload_source_maps: worker.config.upload_source_maps ?? true,
	};
}

async function runCompiler(compiler: Compiler) {
	try {
		return await new Promise<Stats>((resolve, reject) => {
			compiler.run((error, stats) => {
				if (error || !stats) {
					reject(error ?? new Error('Worker build produced no stats'));
				} else {
					resolve(stats);
				}
			});
		});
	} finally {
		await new Promise<void>((resolve) => {
			compiler.close(() => resolve());
		});
	}
}

/** The local secrets for this environment, written beside the build so `wrangler dev` can preview it like the Vite plugin's `vite preview`. */
function createDevVars(worker: ResolvedWorker) {
	const vars = unstable_getVarsForDev(worker.configPath, undefined, {}, worker.environment, true, worker.config.secrets);
	const lines = Object.entries(vars).map(([key, binding]) => `${key}=${JSON.stringify(String(binding.value))}`);
	return lines.length > 0 ? `${lines.join('\n')}\n` : undefined;
}

/** Bundles one Worker into its output directory beside the `wrangler.json` that deploys it, returning that config's path. */
async function buildWorker(compiler: Compiler, worker: ResolvedWorker, pluginOptions: CloudflarePluginOptions) {
	if (worker.main) {
		const { config } = createWorkerConfig({
			compiler,
			worker,
			pluginOptions,
			outputDir: worker.outputDir,
			entry: worker.main,
			mode: compiler.options.mode === 'production' ? 'production' : 'development',
		});
		const workerCompiler = compiler.rspack.rspack(config);
		const stats = await runCompiler(workerCompiler);
		if (stats.hasErrors()) {
			throw new Error(`Worker "${worker.name}" build failed:\n${stats.toString({ preset: 'errors-only', colors: false })}`);
		}
	} else {
		await fs.rm(worker.outputDir, { recursive: true, force: true });
		await fs.mkdir(worker.outputDir, { recursive: true });
	}

	const outputConfigPath = path.join(worker.outputDir, 'wrangler.json');
	await fs.writeFile(outputConfigPath, JSON.stringify(createOutputConfig(worker), null, '\t'));
	const devVars = createDevVars(worker);
	if (devVars) {
		await fs.writeFile(path.join(worker.outputDir, '.dev.vars'), devVars);
	}
	return outputConfigPath;
}

/** Moves assets the Worker imported into its assets directory, once the client build has emitted (and maybe cleaned) it. */
export async function copyImportedAssets(workers: ResolvedWorker[]) {
	for (const worker of workers) {
		const source = path.join(worker.outputDir, IMPORTED_ASSETS_DIR);
		if (!worker.assets || !existsSync(source)) {
			continue;
		}
		await fs.cp(source, worker.assets.directory, { recursive: true });
		await fs.rm(source, { recursive: true, force: true });
	}
}

/** Builds every Worker, entry first, and writes the redirect `wrangler deploy` follows to the built configs. */
export async function buildWorkers(options: { compiler: Compiler; workers: ResolvedWorker[]; pluginOptions: CloudflarePluginOptions; }) {
	const { compiler, workers, pluginOptions } = options;
	const [entry] = workers;
	if (!entry) {
		return;
	}
	const configPaths: string[] = [];
	for (const worker of workers) {
		configPaths.push(await buildWorker(compiler, worker, pluginOptions));
	}

	// the same redirect @cloudflare/vite-plugin writes, so a plain `wrangler deploy` next to the user config deploys the build
	const deployConfigPath = path.join(entry.rootDir, '.wrangler', 'deploy', 'config.json');
	const relativeToDeploy = (filePath: string) => path.relative(path.dirname(deployConfigPath), filePath).replaceAll('\\', '/');
	const [entryConfigPath, ...auxiliaryConfigPaths] = configPaths;
	await fs.mkdir(path.dirname(deployConfigPath), { recursive: true });
	await fs.writeFile(deployConfigPath, JSON.stringify({
		configPath: entryConfigPath && relativeToDeploy(entryConfigPath),
		auxiliaryWorkers: auxiliaryConfigPaths.map((configPath) => {
			return { configPath: relativeToDeploy(configPath) };
		}),
	}));
}
