import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { WorkerConfig } from './options.js';

/** One image a Container-backed Durable Object runs, under the tag wrangler's Miniflare options expect. */
export interface ContainerImage {
	tag: string;
	dockerfile?: string;
	buildContext?: string;
	buildArgs?: Record<string, string>;
	/** A registry image to pull instead of building. */
	uri?: string;
}

// the egress sidecar workerd runs beside each container; we name it explicitly so the image we pull is the one Miniflare uses
const EGRESS_IMAGE = process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE ?? 'cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `WRANGLER_DOCKER_BIN`, like wrangler, so both find the same Docker. */
export function getDockerPath() {
	return process.env.WRANGLER_DOCKER_BIN ?? 'docker';
}

function getContainerClassName(container: NonNullable<WorkerConfig['containers']>[number], exports: unknown) {
	if (container.class_name) {
		return container.class_name;
	}
	if (!isPlainObject(exports)) {
		return;
	}
	for (const [className, entry] of Object.entries(exports)) {
		if (isPlainObject(entry) && entry.container === container.name) {
			return className;
		}
	}
}

/** The runtime container settings wrangler put on each Durable Object, keyed by class name. */
function getContainerRuntimeOptions(durableObjects: unknown) {
	const runtimeOptions = new Map<string, Record<string, unknown>>();
	if (!isPlainObject(durableObjects)) {
		return runtimeOptions;
	}
	for (const durableObject of Object.values(durableObjects)) {
		if (isPlainObject(durableObject) && typeof durableObject.className === 'string' && isPlainObject(durableObject.container)) {
			runtimeOptions.set(durableObject.className, durableObject.container);
		}
	}
	return runtimeOptions;
}

function findNamedImageTag(runtime: Record<string, unknown>, imageName: string) {
	if (!Array.isArray(runtime.images)) {
		return;
	}
	for (const image of runtime.images as unknown[]) {
		if (isPlainObject(image) && image.name === imageName && typeof image.image === 'string') {
			return image.image;
		}
	}
}

/**
 * The images to build or pull before workerd can start these containers. Tags come from the Durable Object options
 * wrangler generated, so they always match what workerd will ask Docker for.
 */
export function getContainerImages(config: WorkerConfig, durableObjects: unknown): ContainerImage[] {
	const runtimeOptions = getContainerRuntimeOptions(durableObjects);
	const configDir = path.dirname(config.configPath ?? path.resolve('wrangler.json'));
	const images: ContainerImage[] = [];
	for (const container of config.containers ?? []) {
		const className = getContainerClassName(container, config.exports);
		const runtime = className === undefined ? undefined : runtimeOptions.get(className);
		if (!runtime) {
			continue;
		}
		for (const [imageName, image] of Object.entries(container.images ?? {})) {
			const tag = findNamedImageTag(runtime, imageName);
			if (tag === undefined) {
				continue;
			}
			if (image.dockerfile === undefined) {
				images.push({ tag, uri: image.image });
			} else {
				const dockerfile = path.resolve(configDir, image.dockerfile);
				const buildContext = image.build_context === undefined ? path.dirname(dockerfile) : path.resolve(configDir, image.build_context);
				images.push({ tag, dockerfile, buildContext, buildArgs: image.build_vars });
			}
		}
		if (container.image === undefined || typeof runtime.imageName !== 'string') {
			continue;
		}
		// readConfig resolves Dockerfile paths against the config, leaving registry references as they were
		if (path.isAbsolute(container.image) && fs.existsSync(container.image)) {
			const buildContext = container.image_build_context ?? path.dirname(container.image);
			images.push({ tag: runtime.imageName, dockerfile: container.image, buildContext, buildArgs: container.image_vars });
		} else {
			images.push({ tag: runtime.imageName, uri: container.image });
		}
	}
	return images;
}

function runDocker(dockerPath: string, args: string[]) {
	return new Promise<void>((resolve, reject) => {
		// build and pull progress is worth seeing, since a first build can take minutes
		const child = spawn(dockerPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
		child.once('error', reject);
		child.once('exit', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`\`docker ${args[0] ?? ''}\` exited with code ${String(code)}`));
			}
		});
	});
}

/** The Docker socket workerd should talk to, found the same way wrangler finds it. */
export function resolveDockerHost(dockerPath: string) {
	const fromEnv = process.env.WRANGLER_DOCKER_HOST ?? process.env.DOCKER_HOST;
	if (fromEnv) {
		return fromEnv;
	}
	try {
		const contexts = execFileSync(dockerPath, ['context', 'ls', '--format', 'json'], { encoding: 'utf8' });
		for (const line of contexts.trim().split('\n')) {
			const context: unknown = JSON.parse(line);
			if (isPlainObject(context) && context.Current === true && typeof context.DockerEndpoint === 'string') {
				return context.DockerEndpoint;
			}
		}
	} catch {
		// an old Docker without JSON context output still answers on the default socket
	}
	return 'unix:///var/run/docker.sock';
}

/** Miniflare's `containerEngine`, naming the egress sidecar image we pulled. */
export function getContainerEngine(dockerPath: string) {
	return { localDocker: { socketPath: resolveDockerHost(dockerPath), containerEgressInterceptorImage: EGRESS_IMAGE } };
}

/** Builds or pulls each image, then the egress sidecar, so workerd can start containers without waiting on Docker. */
export async function prepareContainerImages(dockerPath: string, images: ContainerImage[]) {
	if (process.platform === 'win32') {
		throw new Error('Containers in dev are not supported on Windows, matching wrangler. Run dev in WSL, or set `dev.enable_containers` to false in the Wrangler config.');
	}
	try {
		execFileSync(dockerPath, ['info'], { stdio: 'ignore' });
	} catch (error) {
		throw new Error('Containers need a running Docker daemon to build their images. Start Docker, or set `dev.enable_containers` to false in the Wrangler config.', { cause: error });
	}
	for (const image of images) {
		if (image.dockerfile) {
			const buildArgs = Object.entries(image.buildArgs ?? {}).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]);
			await runDocker(dockerPath, ['build', '--platform', 'linux/amd64', '--tag', image.tag, '--file', image.dockerfile, ...buildArgs, image.buildContext ?? path.dirname(image.dockerfile)]);
		} else if (image.uri) {
			await runDocker(dockerPath, ['pull', '--platform', 'linux/amd64', image.uri]);
			await runDocker(dockerPath, ['tag', image.uri, image.tag]);
		}
	}
	await runDocker(dockerPath, ['pull', EGRESS_IMAGE]);
}

/** Force-removes containers started from these images; synchronous so it can also run while the process exits. */
export function removeContainers(dockerPath: string, tags: Iterable<string>) {
	for (const tag of tags) {
		try {
			const ids = execFileSync(dockerPath, ['ps', '--all', '--quiet', '--filter', `ancestor=${tag}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
			if (ids.length > 0) {
				execFileSync(dockerPath, ['rm', '--force', ...ids], { stdio: 'ignore' });
			}
		} catch {
			// best effort, since Docker may already have stopped by the time dev exits
		}
	}
}
