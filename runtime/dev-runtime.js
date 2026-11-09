// Bundled into the Worker in dev only. workerd binds handlers and Durable Object classes once at startup, so every
// export here is a stable wrapper that looks up the user's current code on each call, letting rspack HMR swap it in place.
import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers';

const HMR_RUNNER_BINDING = '__RSPACK_HMR_RUNNER__';
const HMR_TOKEN_BINDING = '__RSPACK_HMR_TOKEN__';
const HMR_HEADER = 'x-rspack-plugin-cloudflare-hmr';
const HANDLER_KEYS = ['fetch', 'scheduled', 'queue', 'email', 'tail', 'tailStream', 'trace', 'test', 'connect'];
const DURABLE_OBJECT_KEYS = ['fetch', 'alarm', 'connect', 'webSocketMessage', 'webSocketClose', 'webSocketError'];
// properties workerd probes on RPC targets that must not be treated as RPC methods
const IGNORED_KEYS = new Set(['then', 'self', 'constructor']);

let getWorker = () => {
	return {};
};
let initialShape = '';

function stripEnv(env) {
	const userEnv = { ...env };
	delete userEnv[HMR_RUNNER_BINDING];
	delete userEnv[HMR_TOKEN_BINDING];
	return userEnv;
}

function sortNames(names) {
	return names.toSorted((left, right) => left.localeCompare(right));
}

// Node asks for updates through a fetch, since Miniflare's Node-side RPC into the runner can't load modules
function isHmrRequest(request, env) {
	const token = env[HMR_TOKEN_BINDING];
	return Boolean(token) && request.headers.get(HMR_HEADER) === token;
}

async function applyHotUpdate(env) {
	return new Response(await env[HMR_RUNNER_BINDING].get('runner').apply());
}

function prototypeKeys(ctor) {
	const keys = new Set();
	for (let proto = ctor.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		for (const key of Object.getOwnPropertyNames(proto)) {
			keys.add(key);
		}
	}
	return sortNames([...keys]);
}

function kindOf(value) {
	if (typeof value === 'function') {
		if (value.prototype instanceof DurableObject) {
			return `DurableObject(${prototypeKeys(value).join(',')})`;
		}
		if (value.prototype instanceof WorkflowEntrypoint) {
			return 'Workflow';
		}
		if (value.prototype instanceof WorkerEntrypoint) {
			return `WorkerEntrypoint(${prototypeKeys(value).join(',')})`;
		}
		return 'function';
	}
	if (value && typeof value === 'object') {
		return `handlers(${HANDLER_KEYS.filter(key => typeof value[key] === 'function').join(',')})`;
	}
	return typeof value;
}

/** Fingerprints what workerd saw at startup; when an update changes it, only a restart can rebind the exports. */
function describeExports(worker) {
	return JSON.stringify(sortNames(Object.keys(worker)).map(name => [name, kindOf(worker[name])]));
}

export function initialize(getter) {
	getWorker = getter;
	initialShape = describeExports(getter());
}

function reduceError(error) {
	return {
		name: error?.name,
		message: error?.message ?? String(error),
		stack: error?.stack,
		cause: error?.cause === undefined ? undefined : reduceError(error.cause),
	};
}

// Miniflare revives this response into a source-mapped Error on the Node side, the same trick `wrangler dev` uses
async function captureFetchError(run) {
	try {
		return await run();
	} catch (error) {
		return Response.json(reduceError(error), { status: 500, headers: { 'MF-Experimental-Error-Stack': 'true' } });
	}
}

/** Makes an RPC property usable both awaited (`await stub.prop`) and called (`stub.method()`), like workerd's own stubs. */
function rpcProperty(key, valuePromise) {
	const call = async (...args) => {
		const value = await valuePromise;
		if (typeof value !== 'function') {
			throw new TypeError(`"${key}" is not a function.`);
		}
		return value(...args);
	};
	// a thenable on purpose, so `await stub.prop` works the way it does on a real workerd stub
	// eslint-disable-next-line unicorn/no-thenable, unicorn/prefer-then-catch
	call.then = (onFulfilled, onRejected) => valuePromise.then(onFulfilled, onRejected);
	// a property probed but never used shouldn't surface as an unhandled rejection; real use still sees the error
	valuePromise.catch(() => {});
	return call;
}

function proxyRpc(wrapper, getInstance) {
	return new Proxy(wrapper, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (value !== undefined || typeof key === 'symbol' || IGNORED_KEYS.has(key)) {
				return value;
			}
			return rpcProperty(key, Promise.try(() => {
				const instance = getInstance(receiver);
				const property = instance[key];
				return typeof property === 'function' ? property.bind(instance) : property;
			}));
		},
	});
}

// the default export always gets a fetch handler so hot updates can reach the Worker; this keeps workerd's own error otherwise
function missingFetch() {
	throw new Error('Handler does not export a fetch() function.');
}

function createEntrypointWrapper(name, initial) {
	const instanceFor = wrapper => new (getWorker()[name])(wrapper.ctx, stripEnv(wrapper.env));
	class EntrypointWrapper extends WorkerEntrypoint {
		constructor(ctx, env) {
			super(ctx, env);
			return proxyRpc(this, instanceFor);
		}
	}
	for (const key of HANDLER_KEYS) {
		const hasHandler = typeof initial.prototype[key] === 'function';
		if (key === 'fetch' && name === 'default') {
			EntrypointWrapper.prototype.fetch = function(request) {
				if (isHmrRequest(request, this.env)) {
					return applyHotUpdate(this.env);
				}
				return captureFetchError(() => (hasHandler ? instanceFor(this).fetch(request) : missingFetch()));
			};
		} else if (hasHandler) {
			EntrypointWrapper.prototype[key] = function(arg) {
				const call = () => instanceFor(this)[key](arg);
				return key === 'fetch' ? captureFetchError(call) : call();
			};
		}
	}
	return EntrypointWrapper;
}

function createDurableObjectWrapper(name, initial) {
	const states = new WeakMap();
	// rebuilt when HMR swaps the class; storage survives, in-memory state starts over like the Vite plugin
	const instanceFor = (wrapper) => {
		const state = states.get(wrapper);
		const ctor = getWorker()[name];
		if (state.ctor !== ctor) {
			state.ctor = ctor;
			state.instance = new ctor(state.ctx, stripEnv(state.env));
		}
		return state.instance;
	};
	class DurableObjectWrapper extends DurableObject {
		constructor(ctx, env) {
			super(ctx, env);
			const proxy = proxyRpc(this, instanceFor);
			states.set(proxy, { ctx, env, ctor: undefined, instance: undefined });
			return proxy;
		}
	}
	for (const key of DURABLE_OBJECT_KEYS) {
		if (typeof initial.prototype[key] === 'function') {
			DurableObjectWrapper.prototype[key] = function(...args) {
				return instanceFor(this)[key](...args);
			};
		}
	}
	return DurableObjectWrapper;
}

function createWorkflowWrapper(name) {
	return class WorkflowWrapper extends WorkflowEntrypoint {
		run(event, step) {
			return new (getWorker()[name])(this.ctx, stripEnv(this.env)).run(event, step);
		}
	};
}

function createHandlerWrapper(initial) {
	const handlers = {
		fetch(request, env, ctx) {
			if (isHmrRequest(request, env)) {
				return applyHotUpdate(env);
			}
			return captureFetchError(() => {
				const current = getWorker().default;
				return typeof current?.fetch === 'function' ? current.fetch(request, stripEnv(env), ctx) : missingFetch();
			});
		},
	};
	for (const key of HANDLER_KEYS) {
		if (key === 'fetch' || typeof initial?.[key] !== 'function') {
			continue;
		}
		handlers[key] = (arg, env, ctx) => getWorker().default[key](arg, stripEnv(env), ctx);
	}
	return handlers;
}

/** Wraps one export of the user's Worker so it keeps working across hot updates. */
export function wrapExport(name) {
	const initial = getWorker()[name];
	if (typeof initial === 'function') {
		if (initial.prototype instanceof DurableObject) {
			return createDurableObjectWrapper(name, initial);
		}
		if (initial.prototype instanceof WorkflowEntrypoint) {
			return createWorkflowWrapper(name);
		}
		if (initial.prototype instanceof WorkerEntrypoint) {
			return createEntrypointWrapper(name, initial);
		}
	}
	if (name === 'default') {
		return createHandlerWrapper(initial);
	}
	return initial;
}

/**
 * Applies pending rspack hot updates. It runs in a Durable Object so modules re-evaluate in an I/O context that outlives
 * the request that triggered the update, which matters for promises they create at the top level.
 */
export class RspackHmrRunner extends DurableObject {
	async #apply() {
		const hot = import.meta.webpackHot;
		if (!hot) {
			return { reload: true, reason: 'hot module replacement is not enabled' };
		}
		try {
			await hot.check(true);
		} catch (error) {
			return { reload: true, reason: error?.message ?? String(error) };
		}
		if (describeExports(getWorker()) !== initialShape) {
			return { reload: true, reason: 'the Worker\'s exports changed' };
		}
		return { reload: false };
	}

	// serialized here since it becomes the body of the response Node reads
	async apply() {
		return JSON.stringify(await this.#apply());
	}
}
