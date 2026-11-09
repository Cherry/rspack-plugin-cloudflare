import net from 'node:net';

export const DEBUG_PATH = '/__debug';
const DEFAULT_INSPECTOR_PORT = 9229;

function isPortFree(port: number) {
	return new Promise<boolean>((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.listen(port, '127.0.0.1', () => {
			server.close(() => resolve(true));
		});
	});
}

/** Resolves the inspector port: the configured one, or 9229 falling back to the next free port like the Vite plugin. */
export async function resolveInspectorPort(option: number | false | undefined) {
	if (option === false) {
		return;
	}
	if (option !== undefined) {
		return option;
	}
	for (let port = DEFAULT_INSPECTOR_PORT; port < 65535; port++) {
		if (await isPortFree(port)) {
			return port;
		}
	}
}

/** A page that sends the browser to Cloudflare's hosted DevTools, connected to each Worker through Miniflare's inspector proxy. */
export function getDebugPageHtml(workerNames: string[], inspectorPort: number) {
	const urls = workerNames.map((name) => {
		const params = new URLSearchParams({ theme: 'systemPreferred', debugger: 'true', ws: `localhost:${inspectorPort}/${name}`, domain: name });
		return `https://devtools.devprod.cloudflare.dev/js_app?${params.toString()}`;
	});
	return `<!doctype html><script>
const [first, ...rest] = ${JSON.stringify(urls)};
for (const url of rest) {
	window.open(url);
}
window.location.replace(first);
</script>`;
}
