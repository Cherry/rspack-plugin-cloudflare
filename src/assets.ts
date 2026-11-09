import fs from 'node:fs';
import path from 'node:path';

import { lookup } from 'mrmime';

import type { IncomingMessage, ServerResponse } from 'node:http';

/** The slice of rspack's output filesystem we read from; the dev server swaps in an in-memory one. */
export interface ReadableFileSystem {
	readFile: (filePath: string, callback: (error: NodeJS.ErrnoException | null, data?: Buffer | string) => void) => void;
	stat: (filePath: string, callback: (error: NodeJS.ErrnoException | null, stats?: { isFile: () => boolean; }) => void) => void;
}

interface AssetsConfig {
	html_handling?: string;
	not_found_handling?: string;
}

export interface AssetServer {
	/** Whether a request path matches a file, applying the configured html_handling. */
	exists: (pathname: string) => Promise<boolean>;
	/** Serves a request from the assets directory, applying not_found_handling when nothing matches. */
	handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

function statFile(fileSystem: ReadableFileSystem, filePath: string) {
	return new Promise<boolean>((resolve) => {
		fileSystem.stat(filePath, (error, stats) => {
			resolve(!error && Boolean(stats?.isFile()));
		});
	});
}

function readFile(fileSystem: ReadableFileSystem, filePath: string) {
	return new Promise<Buffer>((resolve, reject) => {
		fileSystem.readFile(filePath, (error, data) => {
			if (error || data === undefined) {
				reject(error ?? new Error(`Could not read ${filePath}`));
				return;
			}
			resolve(Buffer.from(data));
		});
	});
}

function htmlCandidates(pathname: string, htmlHandling: string | undefined) {
	if (htmlHandling === 'none') {
		return [pathname];
	}
	if (pathname.endsWith('/')) {
		return [`${pathname}index.html`];
	}
	return [pathname, `${pathname}.html`, `${pathname}/index.html`];
}

/**
 * Serves the Worker's assets directory the way the asset Worker does, reading the compiler's output filesystem first so
 * files only emitted in memory by the dev server are visible.
 */
export function createAssetServer(options: {
	directory: string;
	config: AssetsConfig | undefined;
	getOutputFileSystem: () => ReadableFileSystem | undefined;
	waitUntilValid: () => Promise<void>;
	/** More directories served at the root, checked after `directory`. */
	extraDirectories?: string[];
}): AssetServer {
	const { directory, config } = options;
	const roots = [directory, ...options.extraDirectories ?? []];

	async function findFile(filePath: string) {
		const outputFileSystem = options.getOutputFileSystem();
		if (outputFileSystem && await statFile(outputFileSystem, filePath)) {
			return { fileSystem: outputFileSystem, filePath };
		}
		if (await statFile(fs, filePath)) {
			return { fileSystem: fs, filePath };
		}
	}

	function toFilePath(root: string, pathname: string) {
		const filePath = path.join(root, decodeURIComponent(pathname));
		// path.join normalizes `..`, so anything still escaping the directory is a traversal attempt
		if (filePath !== root && !filePath.startsWith(root + path.sep)) {
			return;
		}
		return filePath;
	}

	async function resolveFile(pathname: string) {
		await options.waitUntilValid();
		for (const candidate of htmlCandidates(pathname, config?.html_handling)) {
			for (const root of roots) {
				const filePath = toFilePath(root, candidate);
				const found = filePath && await findFile(filePath);
				if (found) {
					return found;
				}
			}
		}
	}

	async function resolveNotFound(pathname: string) {
		if (config?.not_found_handling === 'single-page-application') {
			return { status: 200, file: await resolveFile('/index.html') };
		}
		if (config?.not_found_handling === '404-page') {
			// the nearest 404.html walking up from the requested path
			const segments = pathname.split('/').slice(0, -1);
			while (segments.length > 0) {
				const file = await resolveFile(`${segments.join('/')}/404.html`);
				if (file) {
					return { status: 404, file };
				}
				segments.pop();
			}
		}
		return { status: 404, file: undefined };
	}

	return {
		async exists(pathname) {
			const file = await resolveFile(pathname);
			return file !== undefined;
		},
		async handle(req, res) {
			const { pathname } = new URL(req.url ?? '/', 'http://localhost');
			let status = 200;
			let file = await resolveFile(pathname);
			if (!file) {
				({ status, file } = await resolveNotFound(pathname));
			}
			if (!file) {
				res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Not Found');
				return;
			}
			const body = await readFile(file.fileSystem, file.filePath);
			res.writeHead(status, {
				'Content-Type': lookup(file.filePath) ?? 'application/octet-stream',
				'Content-Length': body.length,
				// dev output changes on every rebuild, so never let the browser reuse it without asking
				'Cache-Control': 'no-cache',
			});
			res.end(req.method === 'HEAD' ? undefined : body);
		},
	};
}
