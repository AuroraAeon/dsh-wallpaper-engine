#!/usr/bin/env node
// Local test delivery only. The checkout's development manifest is never rewritten.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSubpackages } from './dev-link-subpackages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_SUBPACKAGE_DIRS = Object.freeze([
  'about-notice', 'fonts', 'fx', 'mascot-avatar', 'media-bridge', 'parallax',
]);

export function testSubpackages(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const subs = collectSubpackages(root);
  if (subs.map((s) => s.dir).join(',') !== TEST_SUBPACKAGE_DIRS.join(',')) {
    throw new Error('Test bundle requires exactly the six non-pet subpackages');
  }
  for (const sub of subs) {
    const manifest = JSON.parse(readFileSync(sub.manifest, 'utf8'));
    if (sub.name !== pkg.name + '-' + sub.dir || manifest.version !== pkg.version
      || pkg.devDependencies?.[sub.name] !== 'file:packages/' + sub.dir
      || Object.hasOwn(pkg.dependencies || {}, sub.name)) {
      throw new Error('Invalid development subpackage registration: ' + sub.dir);
    }
  }
  return subs;
}

// Match run-guards.mjs: invoke npm's JS entry on Windows, not the .cmd shim.
export function runNpm(args, { cwd = ROOT, env = process.env } = {}) {
  const cli = [env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ].find((p) => p && /\.m?js$/.test(p) && existsSync(p));
  if (!cli) throw new Error('Cannot find npm-cli.js; run this command through npm run');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...env, npm_config_cache: env.npm_config_cache || join(ROOT, '.npm-cache') },
  });
  if (result.error || result.status !== 0) {
    throw new Error('npm ' + args.join(' ') + ' failed\n'
      + (result.error?.message || '') + result.stdout + result.stderr);
  }
  return result.stdout;
}

export function packTestBundle() {
  const rootManifest = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const lockManifest = readFileSync(join(ROOT, 'package-lock.json'), 'utf8');
  const pkg = JSON.parse(rootManifest);
  const subs = testSubpackages();
  const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'prepare.mjs')], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (build.error || build.status !== 0) throw new Error('Test bundle build failed');

  const artifacts = join(ROOT, '.artifacts');
  mkdirSync(artifacts, { recursive: true });
  const bundleDir = mkdtempSync(join(artifacts, 'test-bundle-'));
  const sources = [{ name: pkg.name, target: ROOT }, ...subs];
  const packages = sources.map((p) => {
    const packed = JSON.parse(runNpm([
      'pack', '--json', '--offline', '--ignore-scripts', '--pack-destination', bundleDir,
    ], { cwd: p.target }));
    if (packed.length !== 1 || packed[0].name !== p.name) {
      throw new Error('Unexpected npm pack result for ' + p.name);
    }
    return packed[0];
  });

  const profile = join(bundleDir, 'dsh-home', 'profiles', 'test');
  mkdirSync(profile, { recursive: true });
  const profileManifest = {
    name: 'dsh-profile-wallpaper-test',
    private: true,
    dependencies: Object.fromEntries(packages.map((p) => [p.name, 'file:../../../' + p.filename])),
    dsh: { profile: { bundles: [pkg.name], patchReload: 'startup' } },
  };
  writeFileSync(join(profile, 'package.json'), JSON.stringify(profileManifest, null, 2) + '\n');
  // Retain the checkout's published runtime closure so offline ci needs no metadata lookup.
  const rootLock = JSON.parse(lockManifest);
  const locked = Object.fromEntries(Object.entries(rootLock.packages).filter(([name, item]) =>
    name.startsWith('node_modules/') && !item.dev && !item.peer && !item.link));
  for (const [i, packed] of packages.entries()) {
    const source = JSON.parse(readFileSync(join(sources[i].target, 'package.json'), 'utf8'));
    const fields = ['version', 'license', 'engines', 'dependencies', 'optionalDependencies',
      'peerDependencies', 'peerDependenciesMeta', 'os', 'cpu'];
    locked['node_modules/' + packed.name] = {
      ...Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
      resolved: profileManifest.dependencies[packed.name], integrity: packed.integrity,
    };
  }
  writeFileSync(join(profile, 'package-lock.json'), JSON.stringify({
    name: profileManifest.name, lockfileVersion: 3, requires: true,
    packages: { '': { name: profileManifest.name, dependencies: profileManifest.dependencies }, ...locked },
  }, null, 2) + '\n');
  writeFileSync(join(profile, 'cordis.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(profile, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
    format: 1,
    localOnly: true,
    mainName: pkg.name,
    profile: 'dsh-home/profiles/test',
    packages,
  }, null, 2) + '\n');
  writeFileSync(join(bundleDir, 'INSTALL.txt'), [
    'LOCAL TEST BUNDLE ONLY - NOT A PRODUCTION NPM RELEASE',
    '',
    'Keep all seven .tgz files together. Run these commands from this directory:',
    'npm --prefix "./dsh-home/profiles/test" ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund',
    '',
    'Only published runtime dependencies (webwallgl/x11 and their closure) may need the registry.',
    'The six unpublished subpackages are explicit top-level file: tarball dependencies.',
    'Add --offline --cache <prepared-cache> to forbid registry requests entirely.',
    'The included lock pins the published runtime closure from the development lockfile.',
    '--legacy-peer-deps skips host peer auto-resolution in this package-only template;',
    'it does NOT prove host peers are installed or compatible. DSH must supply them for live use.',
    '',
    'The profile directory is new and isolated. This command neither reads nor writes DSH_HOME.',
    'The template verifies package resolution; it does not include or start a complete DSH host.',
    'For live testing, use a separately initialized disposable DSH web profile with its own host',
    'packages/peers, retain all seven top-level file: dependencies, and register ONLY the main',
    'package as a dsh.profile.bundles entry (the main patch already owns all six child rows).',
    'Do not add the six children as separate bundles or copy this template over an existing profile.',
    '',
    'Plain npm pack of the main package intentionally does NOT install the six devDependencies.',
    'No production publishing transformation or registry release is implemented by this bundle.',
    'The repository manifest, version, lockfile, and existing profiles are not modified.',
    '',
    'Verify actual tarball files and offline installation from the checkout:',
    'Requires Node >=18, npm, tar on PATH, and the prepared npm cache for published dependencies.',
    'node scripts/pack-test-bundle.mjs',
    'node test/verify-test-bundle.mjs --bundle "' + bundleDir + '"',
    'The verifier writes verification.json here and removes its temporary installation.',
    '',
  ].join('\n'));
  if (readFileSync(join(ROOT, 'package.json'), 'utf8') !== rootManifest
    || readFileSync(join(ROOT, 'package-lock.json'), 'utf8') !== lockManifest) {
    throw new Error('Root manifest or lockfile changed during test packing');
  }
  console.log('Local test bundle: ' + bundleDir);
  return bundleDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { packTestBundle(); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
