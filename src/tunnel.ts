import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { unstable_resolveNamedTunnel } from 'wrangler';

import type { TunnelOptions, WorkerConfig } from './options.js';
import type { ChildProcess } from 'node:child_process';

const QUICK_TUNNEL_URL_RE = /https:\/\/[\da-z-]+\.trycloudflare\.com/;
// cloudflared logs this once the edge accepts the tunnel, which is when the public URL starts working
const CONNECTED_RE = /Registered tunnel connection/;
const STARTUP_TIMEOUT_MS = 30000;

export interface Tunnel {
	urls: string[];
	close: () => void;
}

function getWranglerBin() {
	const require = createRequire(import.meta.url);
	return path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

function stopProcessTree(child: ChildProcess) {
	if (child.exitCode !== null || child.pid === undefined) {
		return;
	}
	if (process.platform === 'win32') {
		// Windows has no SIGTERM for wrangler to forward, so cloudflared would outlive it without killing the whole tree
		spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
	} else {
		child.kill('SIGTERM');
	}
}

function waitUntilConnected(child: ChildProcess, isNamed: boolean) {
	return new Promise<string | undefined>((resolve, reject) => {
		let output = '';
		let quickUrl: string | undefined;
		let settled = false;
		function fail(error: Error) {
			if (!settled) {
				settled = true;
				stopProcessTree(child);
				reject(error);
			}
		}
		function onData(data: Buffer) {
			// only kept for the error message, so a long-running tunnel doesn't keep growing it
			if (output.length < 20000) {
				output += String(data);
			}
			quickUrl ??= QUICK_TUNNEL_URL_RE.exec(output)?.[0];
			if (!settled && CONNECTED_RE.test(output) && (isNamed || quickUrl)) {
				settled = true;
				resolve(quickUrl);
			}
		}
		AbortSignal.timeout(STARTUP_TIMEOUT_MS).addEventListener('abort', () => {
			fail(new Error(`The tunnel didn't connect within ${STARTUP_TIMEOUT_MS / 1000}s:\n${output}`));
		});
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.once('error', fail);
		child.once('exit', (code) => {
			fail(new Error(`wrangler tunnel exited with code ${String(code)}:\n${output}`));
		});
	});
}

/**
 * Shares the dev server through a Cloudflare Tunnel: a Quick Tunnel on a random trycloudflare.com URL, or a named
 * tunnel whose routes point at the dev server. wrangler runs it, so it downloads and updates cloudflared as needed.
 */
export async function startTunnel(options: { origin: URL; tunnel: TunnelOptions; config: WorkerConfig; cwd: string; }): Promise<Tunnel> {
	const { origin, tunnel, config } = options;
	const args = ['tunnel'];
	const env: NodeJS.ProcessEnv = { ...process.env };
	let urls: string[] = [];
	if (tunnel.name === undefined) {
		args.push('quick-start', origin.href, ...(tunnel.allowedMail ?? []).flatMap(mail => ['--allowed-mail', mail]));
		if (origin.protocol === 'https:') {
			// the dev server's certificate is for the developer's own hostname, never the loopback address cloudflared dials
			env.NO_TLS_VERIFY = 'true';
		}
	} else {
		if (tunnel.allowedMail?.length) {
			throw new Error('`tunnel.allowedMail` only works with Quick Tunnels; protect a named tunnel with Cloudflare Access instead.');
		}
		// also checks the tunnel has a route to this dev server, which is the usual setup mistake
		const { hostnames } = await unstable_resolveNamedTunnel(tunnel.name, origin, {
			accountId: config.account_id,
			complianceRegion: config.compliance_region,
		});
		urls = hostnames.map(hostname => `https://${hostname}`);
		args.push('run', tunnel.name);
	}

	const child = spawn(process.execPath, [getWranglerBin(), ...args], { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
	const quickUrl = await waitUntilConnected(child, tunnel.name !== undefined);
	if (quickUrl) {
		urls = [quickUrl];
	}
	return { urls, close: () => stopProcessTree(child) };
}
