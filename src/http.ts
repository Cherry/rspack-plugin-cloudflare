import { Readable } from 'node:stream';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';

export function getRequestUrl(req: IncomingMessage) {
	const forwardedProto = req.headers['x-forwarded-proto'];
	let protocol = 'http:';
	if (typeof forwardedProto === 'string') {
		protocol = `${forwardedProto.split(',', 1)[0]?.trim()}:`;
	} else if ((req.socket as TLSSocket).encrypted) {
		protocol = 'https:';
	}
	const host = req.headers[':authority'] ?? req.headers.host ?? 'localhost';
	return new URL(req.url ?? '/', `${protocol}//${String(host)}`);
}

export function getRequestHeaders(req: IncomingMessage) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		// HTTP/2 pseudo-headers can't be set on a fetch Headers object
		if (value === undefined || name.startsWith(':')) {
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(name, item);
			}
		} else {
			headers.set(name, value);
		}
	}
	return headers;
}

export function createRequestInit(req: IncomingMessage, res: ServerResponse) {
	const controller = new AbortController();
	res.on('close', () => controller.abort());
	const headers = getRequestHeaders(req);
	// responses come back through undici, which decodes compressed bodies but keeps Content-Encoding; asking for identity avoids a mismatch
	headers.set('accept-encoding', 'identity');
	const method = req.method ?? 'GET';
	const hasBody = method !== 'GET' && method !== 'HEAD';
	return {
		method,
		// entries rather than a Headers object, since Miniflare's undici has its own Headers class
		headers: [...headers],
		body: hasBody ? Readable.toWeb(req) as ReadableStream : undefined,
		duplex: 'half' as const,
		redirect: 'manual' as const,
		signal: controller.signal,
	};
}

function escapeHtml(text: string) {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Responds with the error's (source-mapped) stack, as a page for browsers and plain text for everything else. */
export function sendErrorPage(res: ServerResponse, error: unknown) {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	if (res.req.headers.accept?.includes('text/html')) {
		res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(`<!doctype html><title>Worker error</title><body style="font-family:system-ui;margin:2rem"><h1>Worker error</h1><pre style="white-space:pre-wrap">${escapeHtml(message)}</pre></body>`);
		return;
	}
	res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end(message);
}

/** The parts of a fetch Response we forward, so Miniflare's own undici Response fits as well as the global one. */
interface ForwardableResponse {
	status: number;
	headers: Iterable<[string, string]> & { getSetCookie: () => string[]; };
	body: import('node:stream/web').ReadableStream | null;
}

export function sendResponse(res: ServerResponse, response: ForwardableResponse) {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of response.headers) {
		if (name === 'set-cookie') {
			continue;
		}
		headers[name] = value;
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) {
		headers['set-cookie'] = cookies;
	}
	res.writeHead(response.status, headers);
	if (!response.body || res.req.method === 'HEAD') {
		res.end();
		return;
	}
	const body = Readable.fromWeb(response.body);
	res.on('close', () => body.destroy());
	body.pipe(res);
}
