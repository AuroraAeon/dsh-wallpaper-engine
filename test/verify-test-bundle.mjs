#!/usr/bin/env node
// Integration guard: inspect real archives, then install them outside this checkout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { packTestBundle, runNpm, testSubpackages } from '../scripts/pack-test-bundle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const posix = (path) => path.split(sep).join('/');
const normalize = (path) => String(path).replace(/^\.\//, '');
const failures = [];
const checks = [];
function check(name, test) {
  try { test(); checks.push({ name, ok: true }); console.log('PASS | ' + name); return true; }
  catch (error) {
    failures.push(error.message);
    checks.push({ name, ok: false, error: error.message });
    console.log('FAIL | ' + name + ' | ' + error.message);
    return false;
  }
}
function command(exe, args, options = {}) {
  const result = spawnSync(exe, args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}
function allFiles(dir, out = []) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, item.name);
    if (item.isDirectory()) allFiles(abs, out);
    else out.push(abs);
  }
  return out;
}
function exportTargets(value) {
  if (typeof value === 'string') return value.includes('*') ? [] : [normalize(value)];
  return Object.values(value || {}).flatMap(exportTargets);
}

const option = process.argv.indexOf('--bundle');
const bundle = option < 0 ? packTestBundle() : resolve(process.argv[option + 1]);
const manifest = json(join(bundle, 'bundle.json'));
const rootBefore = readFileSync(join(ROOT, 'package.json'), 'utf8');
const lockBefore = readFileSync(join(ROOT, 'package-lock.json'), 'utf8');
const pkg = JSON.parse(rootBefore);
const subs = testSubpackages();
const expectedNames = [pkg.name, ...subs.map((s) => s.name)];
const scratch = mkdtempSync(join(tmpdir(), 'dsh-test-bundle-'));
const report = { bundle, localOnly: true, hostPeerValidation: false, dshHostBoot: false,
  checks, archives: [], install: null };

try {
  check('exactly the main package and six non-pet archives', () => {
    assert.equal(manifest.format, 1);
    assert.equal(manifest.localOnly, true);
    assert.deepEqual(manifest.packages.map((p) => p.name), expectedNames);
    assert.deepEqual(readdirSync(bundle).filter((f) => f.endsWith('.tgz')).sort(),
      manifest.packages.map((p) => p.filename).sort());
  });

  for (const [index, packed] of manifest.packages.entries()) {
    check(packed.name + ': real tarball file list, entries, and payload', () => {
      assert.equal(packed.filename, packed.name + '-' + pkg.version + '.tgz');
      const archive = join(bundle, packed.filename);
      assert.equal('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64'),
        packed.integrity, 'archive integrity differs from npm pack output');
      const entries = command('tar', ['-tzf', packed.filename], { cwd: bundle }).split(/\r?\n/).filter(Boolean);
      assert(entries.length > 0);
      assert(entries.every((e) => e.startsWith('package/')
        && !e.includes('/../') && !e.includes(String.fromCharCode(92))), 'unsafe tar path');
      const files = entries.filter((e) => !e.endsWith('/')).map((e) => e.slice(8)).sort();
      assert.deepEqual(files, packed.files.map((f) => f.path).sort(),
        'actual tar contents differ from npm pack JSON');
      assert(!files.some((f) => /^(?:src|scripts|test|tests|docs|packages|node_modules|\.artifacts|\.npm-cache)\//.test(f)),
        'development files leaked into archive');
      assert(!files.some((f) => /(?:^|\/)pet-link(?:[/.]|$)|pet(?:Link|Wiring)/.test(f)),
        'pet payload in archive');

      const unpack = join(scratch, 'unpack', String(index));
      mkdirSync(unpack, { recursive: true });
      cpSync(archive, join(unpack, 'archive.tgz'));
      command('tar', ['-xzf', 'archive.tgz'], { cwd: unpack });
      const actual = json(join(unpack, 'package', 'package.json'));
      assert.equal(actual.name, packed.name);
      assert.equal(actual.version, pkg.version);
      const sourceRoot = index === 0 ? ROOT : subs[index - 1].target;
      assert.equal(readFileSync(join(unpack, 'package', 'package.json'), 'utf8'),
        readFileSync(join(sourceRoot, 'package.json'), 'utf8'), 'tarball manifest was rewritten');
      for (const entry of [actual.main, actual.types, actual.icon,
        actual.dsh?.bundle?.patch, ...exportTargets(actual.exports)].filter(Boolean)) {
        assert(files.includes(normalize(entry)), 'entry missing from tarball: ' + entry);
      }
      const runtimeFiles = allFiles(join(sourceRoot, 'lib'));
      for (const abs of runtimeFiles) {
        const rel = posix(relative(sourceRoot, abs));
        assert(files.includes(rel), 'runtime file missing from archive: ' + rel);
        assert(readFileSync(abs).equals(readFileSync(join(unpack, 'package', rel))),
          'runtime bytes differ: ' + rel);
      }
      assert(runtimeFiles.length > 0);
      if (actual.exports?.['./client']) {
        const target = typeof actual.exports['./client'] === 'string'
          ? actual.exports['./client'] : actual.exports['./client'].default;
        const client = readFileSync(join(unpack, 'package', target), 'utf8');
        assert(client.startsWith('window.__ModuleLoader__.load({'));
        assert(client.includes('id: ' + JSON.stringify(packed.name)));
        new Script(client);
      }
      report.archives.push({ name: packed.name, filename: packed.filename, files,
        integrity: packed.integrity, runtimeFiles: runtimeFiles.length });
    });
  }
  const sourceProfile = join(bundle, 'dsh-home', 'profiles', 'test');
  const profile = join(scratch, 'dsh-home', 'profiles', 'test');
  mkdirSync(dirname(profile), { recursive: true });
  cpSync(sourceProfile, profile, { recursive: true });
  for (const packed of manifest.packages) {
    cpSync(join(bundle, packed.filename), join(scratch, packed.filename));
  }
  const env = { ...process.env,
    DSH_HOME: join(scratch, 'dsh-home'),
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
    DSH_WE_DATA_DIR: join(scratch, 'data'), DSH_WE_UPLOAD_DIR: join(scratch, 'uploads'),
    DSH_WE_CACHE_DIR: join(scratch, 'cache'), DSH_WE_STEAM_ROOT: join(scratch, 'steam'),
    npm_config_cache: join(ROOT, '.npm-cache'),
    npm_config_registry: 'http://127.0.0.1:9',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NODE_PATH: '', NODE_OPTIONS: '', DSH_WE_SKIP_HOST_CHECK: '',
  };
  check('staging profile has seven explicit local tarballs and only one bundle layer', () => {
    const stage = json(join(profile, 'package.json'));
    assert.equal(stage.private, true);
    assert.deepEqual(Object.keys(stage.dependencies), expectedNames);
    for (const packed of manifest.packages) {
      assert.equal(stage.dependencies[packed.name], 'file:../../../' + packed.filename);
      assert(existsSync(resolve(profile, stage.dependencies[packed.name].slice(5))));
    }
    assert.deepEqual(stage.dsh.profile.bundles, [pkg.name]);
  });
  const installed = check('offline install of actual archives into a disposable profile', () => {
    const args = ['--prefix', profile, 'ci', '--offline', '--legacy-peer-deps', '--ignore-scripts',
      '--no-audit', '--no-fund'];
    report.installCommand = ['npm', ...args];
    report.install = runNpm(args, { cwd: scratch, env }).trim();
    const lock = json(join(profile, 'package-lock.json'));
    for (const name of expectedNames) {
      const item = lock.packages['node_modules/' + name];
      assert(item && !item.link && item.resolved.startsWith('file:'), 'not a tarball install: ' + name);
      assert(!lstatSync(join(profile, 'node_modules', name)).isSymbolicLink());
    }
  });

  if (installed) {
    const probe = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { readFileSync, realpathSync } from 'node:fs';
      import { join, resolve, sep } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const names = ${JSON.stringify(expectedNames)};
      const profile = process.cwd();
      const req = createRequire(join(profile, 'cordis.yml'));
      const mod = await import(pathToFileURL(req.resolve(names[0] + '/subpackage-boot.js')).href);
      const root = req.resolve(names[0] + '/package.json');
      const patch = readFileSync(join(root, '..', 'cordis.patch.yml'), 'utf8');
      const rows = mod.subpackageSpecifiers(patch, names[0]);
      assert.deepEqual([...rows].sort(), names.slice(1).sort());
      const ownReq = createRequire(root);
      if (process.env.BUNDLE_NEGATIVE) {
        assert.throws(() => mod.assertSubpackagesResolvable(rows, (n) => req.resolve(n)),
          (error) => error.message.includes(process.env.BUNDLE_NEGATIVE));
        assert.throws(() => mod.assertSubpackagesResolvableInHost(rows, { mainName: names[0] }),
          (error) => error.message.includes(process.env.BUNDLE_NEGATIVE) && error.message.includes('test'));
      } else {
        for (const name of names) {
          const entry = realpathSync(req.resolve(name));
          assert(entry.startsWith(resolve(profile, 'node_modules', name) + sep), 'escaped staging profile');
          assert.equal(ownReq.resolve(name), req.resolve(name));
          const host = await import(pathToFileURL(entry).href);
          assert.equal(typeof host.apply, 'function', name + ' host export');
        }
        assert.equal(mod.assertSubpackagesResolvable(rows, (n) => req.resolve(n)), 6);
        assert.equal(mod.assertSubpackagesResolvableInHost(rows, { mainName: names[0] }).length, 1);
      }
      console.log('OK: ' + (process.env.BUNDLE_NEGATIVE || names.join(', ')));
    `;
    check('host resolves and imports all seven true package names beside profile/cordis.yml', () => {
      command(process.execPath, ['--input-type=module', '-e', probe], { cwd: profile, env });
    });
    check('negative control: missing installed child fails both startup checks', () => {
      const missing = pkg.name + '-parallax';
      const installed = join(profile, 'node_modules', missing);
      const hidden = join(scratch, 'hidden-parallax');
      renameSync(installed, hidden);
      try {
        command(process.execPath, ['--input-type=module', '-e', probe], {
          cwd: profile, env: { ...env, BUNDLE_NEGATIVE: missing },
        });
      } finally { renameSync(hidden, installed); }
    });
    check('main-only archive cannot resolve children or import its host entry', () => {
      const hidden = join(scratch, 'hidden-children');
      mkdirSync(hidden);
      const moved = [];
      try {
        for (const name of expectedNames.slice(1)) {
          renameSync(join(profile, 'node_modules', name), join(hidden, name));
          moved.push(name);
        }
        command(process.execPath, ['--input-type=module', '-e', `
          import assert from 'node:assert/strict';
          import { createRequire } from 'node:module';
          import { join } from 'node:path';
          import { pathToFileURL } from 'node:url';
          const req = createRequire(join(process.cwd(), 'cordis.yml'));
          for (const name of ${JSON.stringify(expectedNames.slice(1))}) {
            assert.throws(() => req.resolve(name), { code: 'MODULE_NOT_FOUND' });
          }
          await assert.rejects(import(pathToFileURL(req.resolve(${JSON.stringify(pkg.name)})).href),
            { code: 'ERR_MODULE_NOT_FOUND' });
        `], { cwd: profile, env });
      } finally {
        for (const name of moved) renameSync(join(hidden, name), join(profile, 'node_modules', name));
      }
    });
  }
  check('root manifest and lockfile unchanged by local test packing/install', () => {
    assert.equal(readFileSync(join(ROOT, 'package.json'), 'utf8'), rootBefore);
    assert.equal(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'), lockBefore);
  });
} catch (error) {
  check('bundle verification completed without an unexpected error', () => { throw error; });
} finally {
  rmSync(scratch, { recursive: true, force: true });
  report.ok = failures.length === 0;
  report.temporaryInstallRemoved = !existsSync(scratch);
  writeFileSync(join(bundle, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log('Verification report: ' + join(bundle, 'verification.json'));
if (failures.length) process.exitCode = 1;
