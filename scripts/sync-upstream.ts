// Moves the wrangler we test against, the packages it pins, and the workers-sdk submodule to one wrangler release, so the
// code bundled from workers-sdk stays current. Usage: node scripts/sync-upstream.ts [wrangler version or tag]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

interface PackageJson {
	version: string;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
}

function run(command: string, args: string[]) {
	// npm is a .cmd shim on Windows, which only starts through a shell
	execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
}

function readPackage(file: string) {
	return JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson;
}

const target = process.argv[2] ?? 'latest';
// npm honours min-release-age in .npmrc, so this never picks a release younger than the rest of the dependencies may be
// wrangler is a peer dependency, so this only moves the version tests run against, not the range users can install
run('npm', ['install', '--save-exact', '--save-dev', `wrangler@${target}`]);
const wrangler = readPackage('node_modules/wrangler/package.json');

const tag = `wrangler@${wrangler.version}`;
run('git', ['-C', 'workers-sdk', 'fetch', '--depth', '1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
run('git', ['-C', 'workers-sdk', 'checkout', '--detach', tag]);

const containersShared = readPackage('workers-sdk/packages/containers-shared/package.json');
const config = readPackage('workers-sdk/packages/config/package.json');
const workersUtils = readPackage('workers-sdk/packages/workers-utils/package.json');
const workersShared = readPackage('workers-sdk/packages/workers-shared/package.json');
run('npm', [
	'install',
	'--save-exact',
	`unenv@${wrangler.dependencies.unenv}`,
	`@cloudflare/unenv-preset@${wrangler.dependencies['@cloudflare/unenv-preset']}`,
	`@cloudflare/containers-shared@${containersShared.version}`,
	// loads cloudflare.config.ts the way wrangler does, so it has to read the same config schema
	`@cloudflare/config@${config.version}`,
	`@cloudflare/workers-utils@${workersUtils.version}`,
]);
// bundled into dist with workers-shared, so they stay on the versions workers-shared builds with
const bundled = ['toucan-js', 'mime', 'ignore'].map(name => `${name}@${workersShared.devDependencies[name]}`);
// Miniflare is only here for its types, since at runtime it loads through the user's wrangler
run('npm', ['install', '--save-exact', '--save-dev', `miniflare@${wrangler.dependencies.miniflare}`, ...bundled]);

if (process.env.GITHUB_OUTPUT) {
	fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${wrangler.version}\n`);
}
console.log(`Synced with ${tag}`);
