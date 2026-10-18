/*---------------------------------------------------------------------------------------------
 *  Derived from build/gulpfile.reh.ts (packageTask) of microsoft/vscode 1.142.0 (https://github.com/microsoft/vscode, MIT licence,
 *  Copyright (c) Microsoft Corporation; the licence text is core/vscode/LICENSE in the package). INV-G4: this notice names the source.
 *--------------------------------------------------------------------------------------------*/
// package-server.ts: assembles the VS Code Server for the web (reh-web) for linux-arm64 the way build/gulpfile.reh.ts's packageTask does,
// with VS Code's own helpers (production dependencies, .moduleignore, the ripgrep platform filter, inlineMeta), minus what apps/vscode
// does not ship. build.sh copies this file into the VS Code tree as build/vmapp-package-server.ts; compile-stage.sh runs it:
//
//   node --experimental-strip-types build/vmapp-package-server.ts <destination> <excluded extensions> <excluded modules>
//
// What differs from packageTask, and why (apps/vscode/CONVERSION.md, "Removed"):
//   * the extensions in <excluded extensions> (comma-separated names) are left out: the Copilot/Chat extension and the ones that cannot
//     work in a vmapp window (sign-in, webview-only features, port forwarding);
//   * the dependencies of remote/package.json named in <excluded modules> (comma-separated) are left out, with every package only they
//     needed: the Copilot runtime, the agent host's packages, and the packages that the server only lists so that it can serve them to
//     a browser (the window loads its own copies from ui/). packageTask's Copilot steps (ensureCopilotPlatformPackage,
//     prepareBuiltInCopilotRipgrepShim) need the Copilot extension and are not run;
//   * no Windows/macOS/Alpine branches and no remote CLI scripts (bin/): the server is started by apps/vscode/core/main.js.
import * as fs from 'fs';
import * as path from 'path';
import es from 'event-stream';
import vfs from 'vinyl-fs';
import glob from 'glob';
import { gulp, rename, filter, jsonEditor } from './lib/gulp/facade.ts';
import * as util from './lib/util.ts';
import { getProductionDependencies } from './lib/dependencies.ts';
import { inlineMeta } from './lib/inlineMeta.ts';
import { computeNLSMetadataHash } from './lib/nlsMetadata.ts';
import { readISODate } from './lib/date.ts';
import { getBootstrapEntryPointsForTarget } from './lib/esbuild.ts';
import { getRipgrepExcludeFilter } from './lib/copilot.ts';
import { getVersion } from './lib/getVersion.ts';

const REPO_ROOT = path.dirname(import.meta.dirname);
const REMOTE_FOLDER = path.join(REPO_ROOT, 'remote');
const [destination, excludedExtensionsArg = '', excludedModulesArg = ''] = process.argv.slice(2);
if (!destination) {
	console.error('usage: package-server.ts <destination> <excluded extensions> <excluded modules>');
	process.exit(2);
}
const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
const excludedExtensions = new Set(['vscode-api-tests', 'vscode-test-resolver', ...list(excludedExtensionsArg)]);
const excludedModules = list(excludedModulesArg);

const platform = 'linux';
const arch = 'arm64';
const sourceFolderName = 'out-vscode-reh-web-min';
const commit = getVersion(REPO_ROOT);
const product = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'product.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const npmrc = fs.readFileSync(path.join(REMOTE_FOLDER, '.npmrc'), 'utf8');
const nodeVersion = /^target="(.*)"$/m.exec(npmrc)![1];

const src = gulp.src(sourceFolderName + '/**', { base: '.' })
	.pipe(rename(function (p) { p.dirname = p.dirname!.replace(new RegExp('^' + sourceFolderName), 'out'); }))
	.pipe(util.setExecutableBit(['**/*.sh']))
	.pipe(filter(['**', '!**/*.{js,css}.map']));

// reh-web ships every extension of extensions/ (packageTask: "web: ship all extensions for now") and the marketplace built-ins
const localExtensions = glob.sync('extensions/*/package.json').map(p => path.basename(path.dirname(p)));
const marketplaceExtensions = (product.builtInExtensions as Array<{ name: string; platforms?: string[]; clientOnly?: boolean }>)
	.filter(entry => !entry.platforms || new Set(entry.platforms).has(platform))
	.filter(entry => !entry.clientOnly)
	.map(entry => entry.name);
const shippedExtensions = [...localExtensions, ...marketplaceExtensions].filter(name => !excludedExtensions.has(name));
const extensions = gulp.src(shippedExtensions.map(name => `.build/extensions/${name}/**`), { base: '.build', dot: true });
const extensionsCommonDependencies = gulp.src('.build/extensions/node_modules/**', { base: '.build', dot: true });
const sources = es.merge(src, extensions, extensionsCommonDependencies)
	.pipe(filter(['**', '!**/*.{js,css}.map'], { dot: true }));

const version = packageJson.version;
let packageJsonContents = '';
const packageJsonStream = gulp.src(['remote/package.json'], { base: 'remote' })
	.pipe(jsonEditor({ name: product.nameShort, version, dependencies: undefined, optionalDependencies: undefined, type: 'module' }))
	.pipe(es.through(function (file) {
		packageJsonContents = file.contents.toString();
		this.emit('data', file);
	}));

let productJsonContents = '';
const productJsonStream = gulp.src(['product.json'], { base: '.' })
	.pipe(jsonEditor((json: Record<string, unknown>) => {
		json.commit = commit;
		json.nlsMetadataHash = computeNLSMetadataHash(path.join(REPO_ROOT, sourceFolderName), commit);
		json.date = readISODate(sourceFolderName);
		json.version = version;
		return json;
	}))
	.pipe(es.through(function (file) {
		productJsonContents = file.contents.toString();
		this.emit('data', file);
	}));

const license = gulp.src(['LICENSE.txt'], { base: '.', allowEmpty: true }).pipe(rename('LICENSE'));
const thirdPartyNotices = gulp.src(['ThirdPartyNotices.txt'], { base: '.', allowEmpty: true });

// The packages the server needs: the dependency closure of remote/package.json's dependencies minus <excluded modules>, so that a package
// left out takes the packages only it needed with it. (packageTask ships every production dependency.)
function shippedPackageDirs(): Set<string> {
	const keep = new Set<string>();
	const resolve = (fromDir: string, name: string): string | undefined => {
		for (let dir = fromDir; dir.startsWith(REMOTE_FOLDER); dir = path.dirname(dir)) {
			const candidate = path.join(dir, 'node_modules', name);
			if (fs.existsSync(path.join(candidate, 'package.json'))) {
				return candidate;
			}
			if (dir === REMOTE_FOLDER) {
				break;
			}
		}
		return undefined;
	};
	const visit = (dir: string) => {
		if (keep.has(dir)) {
			return;
		}
		keep.add(dir);
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
		for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
			const child = resolve(dir, name);
			if (child) {
				visit(child);
			}
		}
	};
	const remotePackage = JSON.parse(fs.readFileSync(path.join(REMOTE_FOLDER, 'package.json'), 'utf8'));
	for (const name of Object.keys(remotePackage.dependencies)) {
		if (!excludedModules.includes(name)) {
			const dir = resolve(REMOTE_FOLDER, name);
			if (dir) {
				visit(dir);
			}
		}
	}
	return keep;
}
const shippedPackages = shippedPackageDirs();
const jsFilter = util.filter(data => !data.isDirectory() && /\.js$/.test(data.path));
const productionDependencies = getProductionDependencies(REMOTE_FOLDER).filter(d => shippedPackages.has(d));
const dependenciesSrc = productionDependencies.map(d => path.relative(REPO_ROOT, d)).map(d => [`${d}/**`, `!${d}/**/{test,tests}/**`, `!${d}/.bin/**`]).flat();
const deps = gulp.src(dependenciesSrc, { base: 'remote', dot: true })
	.pipe(filter(['**', '!**/package-lock.json', '!**/*.{js,css}.map']))
	.pipe(util.cleanNodeModules(path.join(import.meta.dirname, '.moduleignore')))
	.pipe(util.cleanNodeModules(path.join(import.meta.dirname, `.moduleignore.${platform}`)))
	.pipe(filter(getRipgrepExcludeFilter(platform, arch)))
	.pipe(jsFilter)
	.pipe(util.stripSourceMappingURL())
	.pipe(jsFilter.restore);

// the server's Node, fetched and checked against build/checksums/nodejs.txt by the gulp task node-linux-arm64
const nodePath = `.build/node/v${nodeVersion}/${platform}-${arch}`;
if (!fs.existsSync(path.join(REPO_ROOT, nodePath, 'node'))) {
	console.error(`missing ${nodePath}/node (run: gulp node-${platform}-${arch})`);
	process.exit(1);
}
const node = gulp.src(`${nodePath}/**`, { base: nodePath, dot: true });

let result = es.merge(packageJsonStream, productJsonStream, license, thirdPartyNotices, sources, deps, node)
	.pipe(util.skipDirectories());

result = inlineMeta(result, {
	targetPaths: getBootstrapEntryPointsForTarget('server-web').map(entry => `${entry}.js`),
	packageJsonFn: () => packageJsonContents,
	productJsonFn: () => productJsonContents
});

result.pipe(vfs.dest(destination)).on('finish', () => {
	console.log(`packaged the server into ${destination}: ${shippedExtensions.length} extensions, ${productionDependencies.length} dependencies (left out: extensions ${[...excludedExtensions].join(', ')}; modules ${excludedModules.join(', ') || 'none'})`);
}).on('error', (e: Error) => {
	console.error(e);
	process.exit(1);
});
