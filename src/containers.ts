import path from 'node:path';

import {
	cleanupContainers,
	createContainerDevPlan,
	prepareContainerImagesForDev,
	resolveDockerHost,
} from '@cloudflare/containers-shared';

import type { WorkerConfig } from './options.js';
import type { ContainerDevOptions, ViteLogger } from '@cloudflare/containers-shared';

export { generateContainerBuildId } from '@cloudflare/containers-shared';

/** `WRANGLER_DOCKER_BIN`, like wrangler, so both find the same Docker. */
export function getDockerPath() {
	return process.env.WRANGLER_DOCKER_BIN || 'docker';
}

/** The images a Worker's Containers need, tagged to match the Durable Object options wrangler generates with the same build id. */
export function getContainerOptions(config: WorkerConfig, containerBuildId: string): ContainerDevOptions[] {
	const plan = createContainerDevPlan({
		containers: config.containers,
		exports: config.exports,
		configPath: config.configPath,
		containerBuildId,
	});
	return plan?.containerOptions ?? [];
}

/** The Docker endpoint workerd starts containers through; Miniflare picks the egress sidecar image itself. */
export function getContainerEngine(config: WorkerConfig, dockerPath: string) {
	return config.dev.container_engine ?? resolveDockerHost(dockerPath);
}

/** Builds or pulls each image and the egress sidecar the way wrangler dev does, including its Windows and Docker checks. */
export async function prepareContainerImages(options: { config: WorkerConfig; dockerPath: string; containerOptions: ContainerDevOptions[]; logger: ViteLogger; }) {
	const { config } = options;
	await prepareContainerImagesForDev({
		dockerPath: options.dockerPath,
		containerOptions: options.containerOptions,
		onContainerImagePreparationStart: () => {},
		onContainerImagePreparationEnd: () => {},
		logger: options.logger,
		complianceConfig: config,
		configFileName: path.basename(config.configPath ?? 'wrangler.json'),
		registryConfigureCommand: 'wrangler containers registries configure',
	});
}

/** Force-removes containers started from these images; synchronous so it can also run while the process exits. */
export function removeContainers(dockerPath: string, tags: Set<string>) {
	if (tags.size > 0) {
		cleanupContainers(dockerPath, tags);
	}
}
