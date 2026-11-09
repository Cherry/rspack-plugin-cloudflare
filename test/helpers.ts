import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const basicFixture = path.resolve(import.meta.dirname, 'fixtures/basic');
export const assetsOnlyFixture = path.resolve(import.meta.dirname, 'fixtures/assets-only');
// both CLIs keep their bin out of package exports, so point at the files directly
const nodeModules = path.resolve(import.meta.dirname, '../node_modules');
export const rspackBin = path.join(nodeModules, '@rspack/cli/bin/rspack.js');
export const wranglerBin = path.join(nodeModules, 'wrangler/bin/wrangler.js');

export function getFreePort() {
	return new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, () => {
			const address = server.address();
			server.close(() => {
				if (address && typeof address === 'object') {
					resolve(address.port);
				} else {
					reject(new Error('Could not find a free port'));
				}
			});
		});
	});
}

export function run(bin: string, args: string[], cwd: string, env: Record<string, string> = {}) {
	return new Promise<{ code: number | null; output: string; }>((resolve) => {
		const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...env } });
		let output = '';
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on('close', code => resolve({ code, output }));
	});
}

/** Polls until `check` returns a value, since the dev server and Worker reload asynchronously. */
export async function waitFor<T>(check: () => Promise<T | undefined>, timeout = 30000) {
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const result = await check();
			if (result !== undefined) {
				return result;
			}
		} catch (error) {
			lastError = error;
		}
		await delay(200);
	}
	throw new Error(`Timed out waiting for condition${lastError ? `: ${String(lastError)}` : ''}`);
}

/** Starts `rspack serve` (or another server command) in a fixture and waits until `readyPath` answers. */
export async function startDevServer(fixture: string, readyPath: string, command = (port: number) => [rspackBin, 'serve', '--port', String(port)]) {
	const port = await getFreePort();
	const origin = `http://localhost:${port}`;
	const child = spawn(process.execPath, command(port), { cwd: fixture });
	const server = {
		origin,
		output: '',
		stop: () => child.kill(),
		async getText(pathname: string, init?: RequestInit) {
			const response = await fetch(`${origin}${pathname}`, init);
			return response.text();
		},
		async getJson<T>(pathname: string) {
			const response = await fetch(`${origin}${pathname}`);
			return await response.json() as T;
		},
	};
	child.stdout.on('data', (chunk: Buffer) => {
		server.output += chunk.toString();
	});
	child.stderr.on('data', (chunk: Buffer) => {
		server.output += chunk.toString();
	});
	try {
		await waitFor(async () => {
			const response = await fetch(`${origin}${readyPath}`);
			return response.ok ? true : undefined;
		});
	} catch (error) {
		// the caller never gets a handle to stop it, so don't leave the server (and its workerd) running
		child.kill();
		throw new Error(`Dev server never answered ${readyPath}:\n${server.output}`, { cause: error });
	}
	return server;
}
