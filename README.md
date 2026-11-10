# rspack-plugin-cloudflare

[![npm version](https://img.shields.io/npm/v/rspack-plugin-cloudflare)](https://www.npmjs.com/package/rspack-plugin-cloudflare)
[![CI](https://github.com/Cherry/rspack-plugin-cloudflare/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Cherry/rspack-plugin-cloudflare/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/rspack-plugin-cloudflare)](./LICENSE)

Run Cloudflare Workers in workerd while developing with `rspack serve`, with hot module replacement inside the Worker, and build them alongside the client with `rspack build`. It's the rspack counterpart to `@cloudflare/vite-plugin`, and it reads the same Wrangler config.

> [!NOTE]
> **Heads-up:** this project was primarily AI-authored. The plugin, its tests, and this README were written by AI coding agents in interactive sessions, with a human operator directing the work, reviewing output, and validating it against real rspack and Wrangler projects. Read the code before trusting it in production.

## Install

```sh
npm install --save-dev rspack-plugin-cloudflare @rspack/core @rspack/cli @rspack/dev-server wrangler
```

Requires Node.js 24.10 or later.

## Usage

```js
// rspack.config.js
import { cloudflare } from 'rspack-plugin-cloudflare';

export default {
	entry: './client/index.js',
	output: { path: 'build/assets', publicPath: '/assets/' },
	plugins: [cloudflare()],
};
```

The Worker is configured in your existing `wrangler.toml` / `wrangler.json(c)`, found by walking up from rspack's `context`.

| Command | What happens |
| --- | --- |
| `rspack serve` | The client gets the usual dev server and HMR. Each Worker is bundled by its own rspack compiler and runs in workerd through Miniflare, with HMR of its own. |
| `rspack build` | Each Worker is bundled into `dist/<worker name>/` with a generated `wrangler.json`, and `.wrangler/deploy/config.json` points at them. |
| `wrangler deploy` | Deploys the build, following that redirect, without bundling again. |
| `wrangler dev` | Previews the build the same way, with the `.dev.vars` copied beside it. |

Set `CLOUDFLARE_ENV` to pick a Wrangler environment for dev and build, as with the Vite plugin.

### Options

| Option | Default | |
| --- | --- | --- |
| `configPath` | nearest wrangler config | Wrangler config, relative to `context` |
| `config` | | Overrides merged into the Wrangler config, or a function that edits it |
| `environment` | `CLOUDFLARE_ENV` | Wrangler environment, like `--env` |
| `auxiliaryWorkers` | | `[{ configPath, config?, outputDir? }]`, more Workers the entry Worker reaches through service bindings |
| `worker` | | `(config, { name }) => config` to adjust a Worker's rspack config |
| `outputDir` | `dist/<worker name>` | Build output for the Worker, relative to its Wrangler config |
| `persistState` | `.wrangler/state` | Local binding state; `false` keeps it in memory |
| `inspectorPort` | 9229, or the next free port | workerd inspector; `false` turns it off |
| `remoteBindings` | `true` | Connects bindings marked `remote: true` to the real resources; `false` keeps everything local |
| `tunnel` | `false` | `true` or `{ name?, allowedMail? }` shares the dev server through a Cloudflare Tunnel |

## How dev works

Requests hit the rspack dev server first. A middleware in front of `dev-middleware` passes each one to Cloudflare's router and asset Workers, built from the same release of Cloudflare's code as `wrangler dev` runs:

- `assets.run_worker_first`, `html_handling`, `not_found_handling`, `_headers` and `_redirects` behave as they do when deployed. Editing `_headers` or `_redirects` restarts the Workers to apply it.
- Assets come from the client compiler's in-memory output, falling back to the assets directory on disk, so they're always the latest build. Their `ETag` and `Cache-Control` headers are dropped, so the browser never reuses a stale dev file.
- The Worker's `ASSETS` binding goes to the same asset Worker, so it sees dev builds too.
- WebSocket upgrades go to the Worker, except the dev server's own HMR socket.
- `/cdn-cgi/local/scheduled` and the other Miniflare trigger endpoints (and their older `/cdn-cgi/handler/*` paths) reach the Worker directly.
- `/__debug` opens DevTools for every Worker.

Bindings, vars, `.dev.vars` / `.env`, Durable Objects and compatibility settings all come from wrangler, so they match `wrangler dev`. Workers also join wrangler's dev registry, so service bindings reach Workers running in other local dev sessions.

### Hot module replacement in the Worker

The dev bundle includes rspack's HMR runtime. After a rebuild, the plugin asks the running Worker to apply the update before letting requests through, the way the Vite plugin's module runner does:

- Changed modules and their importers re-evaluate in place. Other modules keep their state, and Durable Objects keep their storage.
- Exports are wrapped so workerd's startup bindings (default handlers, Durable Objects, named entrypoints, Workflows) always call the current code.
- The Worker restarts instead when its exports change, its `.wasm`/`.bin` modules change, its Wrangler config or local secrets change, or an update can't be applied.

Uncaught errors come back as a page with a source-mapped stack, and Worker build errors show in the dev server's overlay.

### Node.js compatibility

With `nodejs_compat`, modules workerd provides stay external, and Cloudflare's unenv preset polyfills the rest and injects globals like `process` for older compatibility dates, the same as wrangler.

### Non-JavaScript modules

`.wasm` and `.bin` imports ship beside the bundle as their own modules. Text modules (`.txt`, `.html`, `.sql` and any `Text` rules) are inlined. Custom `rules` in the Wrangler config apply.

### Static assets imported by the Worker

When the Worker has an assets directory, importing an image, font, video or other static file (or any file with `?url`) gives its URL, like in Vite:

```ts
import logoUrl from './logo.svg';

export default {
	fetch(request, env) {
		return env.ASSETS.fetch(new URL(logoUrl, request.url));
	},
};
```

Files are named `assets/<name>.<hash><ext>`. Dev serves them alongside the client build, and `rspack build` copies them into the assets directory after the client build emits.

### Containers

Container-backed Durable Objects run locally like `wrangler dev`, using the same Cloudflare packages as wrangler and the Vite plugin: dev builds each Dockerfile (or pulls each registry image) before starting the Workers, then removes the containers when it exits. It needs a running Docker daemon, and like wrangler it doesn't support Windows outside WSL. Set `dev.enable_containers` to `false` in the Wrangler config to skip it. Images are built once per dev session, so restart dev after changing a Dockerfile.

### Sharing with a tunnel

`tunnel: true` starts a Quick Tunnel on a random `trycloudflare.com` URL once the dev server is listening, with no account needed. `tunnel: { name }` runs an existing named tunnel instead, after checking it has a route to the dev server. `allowedMail` makes Quick Tunnel visitors sign in with a matching email. wrangler runs the tunnel, so it downloads `cloudflared` when needed, and the tunnel's hostnames are added to the dev server's `allowedHosts`.

Anyone with the URL reaches the dev server, including the Worker's local bindings and secrets, so only turn this on while you're sharing.

## Contributing

```sh
git submodule update --init
npm ci
node --run test
```

`node --run test` lints, type checks, builds and runs the test suite, which starts real `rspack serve` and `rspack build` runs against the fixtures in `test/fixtures`.

Cloudflare's router and asset Workers and their `_headers` and `_redirects` parsers come from `@cloudflare/workers-shared`, which isn't published. The `workers-sdk` submodule is pinned to the commit of the wrangler release we depend on, and `node --run build` bundles that code into `dist`. The weekly Sync upstream workflow moves wrangler, Miniflare, the packages wrangler pins and the submodule to the latest wrangler release together, runs the tests and opens a pull request. To do the same locally, run `node scripts/sync-upstream.ts [version]`.

Releases are automated. Merging to `main` runs [semantic-release](https://github.com/semantic-release/semantic-release), which picks the version from the [conventional commit](https://www.conventionalcommits.org/) titles since the last release and publishes to npm through trusted publishing, with provenance. Pull requests are squash merged, so the pull request title is the commit that counts.

## License

MIT
