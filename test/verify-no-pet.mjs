#!/usr/bin/env node
/** Six-package release boundary. Read-only, offline, and never skips missing inputs. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPackages } from './tools/packages.mjs';
import { listFace } from './tools/repo-face.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_PACKAGES = [
  'packages/about-notice', 'packages/fonts', 'packages/fx',
  'packages/mascot-avatar', 'packages/media-bridge', 'packages/parallax',
];
const EXPECTED_ARTIFACTS = [
  'lib/client.js', 'packages/fonts/lib/client.fonts.js',
  'packages/fx/lib/client.fx.js', 'packages/parallax/lib/client.parallax.js',
];
const REQUIRED_FILES = [
  'package.json', 'package-lock.json', 'cordis.patch.yml', 'scripts/build-client.mjs',
  'lib/subpackage-boot.js', 'src/client.js', 'src/extension-registry.js',
  ...EXPECTED_PACKAGES.map(dir => dir + '/package.json'),
  ...EXPECTED_ARTIFACTS,
];
const RETIRED = /pet[-_]?link|dsh[-_]pet|petOfficialMode|__DSH_PET|DSHPet|\bPET_[A-Z0-9_]+/i;
const sameSet = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());

// Production and every mutation use this one predicate; fixtures never write to the repository.
function boundaryViolations({ files, packageDirs, artifacts }) {
  const bad = [];
  if (!sameSet(packageDirs, EXPECTED_PACKAGES)) bad.push('packages: expected exactly six retained subpackages; got ' + packageDirs.join(', '));
  if (!sameSet(artifacts, EXPECTED_ARTIFACTS)) bad.push('artifacts: expected exactly four client bundles; got ' + artifacts.join(', '));
  for (const rel of REQUIRED_FILES) {
    if (!files.has(rel) || !String(files.get(rel)).trim()) bad.push('required: missing or empty ' + rel);
  }
  for (const [rel, text] of files) {
    if (RETIRED.test(rel)) bad.push('retired path: ' + rel);
    const at = String(text).search(RETIRED);
    if (at >= 0) bad.push('retired wiring: ' + rel + ':' + (String(text).slice(0, at).split('\n').length));
  }
  return bad;
}

let failed = 0;
function check(name, ok, detail = '') {
  console.log((ok ? 'PASS | ' : 'FAIL | ') + name + (detail ? ' | ' + detail : ''));
  if (!ok) failed++;
}

const files = new Map();
for (const abs of listFace(ROOT, { exts: ['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.html', '.css'] })) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  if (/^(?:src|lib|scripts|packages)\//.test(rel)) files.set(rel, readFileSync(abs, 'utf8'));
}
for (const rel of REQUIRED_FILES) {
  if (existsSync(join(ROOT, rel))) files.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
}
const packageDirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => 'packages/' + entry.name).sort();
const model = discoverPackages(ROOT);
const artifacts = model.clientPackages.map(pkg => pkg.clientArtifact);
const actual = { files, packageDirs, artifacts };
check('source scan is nonempty in every product tree', ['src', 'lib', 'scripts', 'packages']
  .every(dir => [...files.keys()].some(rel => rel.startsWith(dir + '/'))), files.size + ' files scanned');
const bad = boundaryViolations(actual);
check('build, patch, manifests, source and bundles contain no retired takeover wiring', bad.length === 0,
  bad.length ? bad.slice(0, 15).join(' | ') + (bad.length > 15 ? ' | total=' + bad.length : '')
    : 'six subpackages, four bundles, no retired paths or identifiers');

const baseline = {
  files: new Map(REQUIRED_FILES.map(rel => [rel, 'baseline'])),
  packageDirs: EXPECTED_PACKAGES,
  artifacts: EXPECTED_ARTIFACTS,
};
check('positive control: clean six-package input passes', boundaryViolations(baseline).length === 0);
for (const [name, rel, text, tag] of [
  ['build recipe', 'scripts/build-client.mjs', "inline.push({ file: 'packages/pet-link/src/client.js' });", 'retired wiring:'],
  ['patch row', 'cordis.patch.yml', "- id: wallpaper-engine-pet-link\n  name: dsh-plugin-wallpaper-engine-pet-link", 'retired wiring:'],
  ['dependency', 'package.json', '{"devDependencies":{"dsh-plugin-wallpaper-engine-pet-link":"file:packages/pet-link"}}', 'retired wiring:'],
  ['lockfile', 'package-lock.json', '{"packages":{"packages/pet-link":{}}}', 'retired wiring:'],
  ['automatic takeover', 'src/client.js', 'petLink.warmup(); petLink.mascot.tap();', 'retired wiring:'],
  ['service registry', 'src/extension-registry.js', 'const wePetLinkApi = null;', 'retired wiring:'],
  ['official sidebar takeover', 'src/client.js', 'const petOfficialMode = true;', 'retired wiring:'],
  ['host key table', 'lib/subpackage-boot.js', "const keys = { 'pet-link': {} };", 'retired wiring:'],
  ['stale generated bundle', 'lib/client.js', 'const WE_I18N_EN_PET_LINK = {};', 'retired wiring:'],
  ['unregistered source', 'src/pet-link.js', 'export {};', 'retired path:'],
]) {
  const mutated = { ...baseline, files: new Map(baseline.files).set(rel, text) };
  check('negative control: ' + name + ' fails the same predicate',
    boundaryViolations(mutated).some(msg => msg.startsWith(tag) && msg.includes(rel)));
}
check('negative control: extra package fails', boundaryViolations({
  ...baseline, packageDirs: [...EXPECTED_PACKAGES, 'packages/pet-link'],
}).some(msg => msg.startsWith('packages:')));
check('negative control: missing retained package fails', boundaryViolations({
  ...baseline, packageDirs: EXPECTED_PACKAGES.slice(1),
}).some(msg => msg.startsWith('packages:')));
check('negative control: extra client artifact fails', boundaryViolations({
  ...baseline, artifacts: [...EXPECTED_ARTIFACTS, 'packages/pet-link/lib/client.pet-link.js'],
}).some(msg => msg.startsWith('artifacts:')));
check('negative control: missing or empty boundary input fails', REQUIRED_FILES.every(rel => {
  const missing = new Map(baseline.files);
  missing.delete(rel);
  const empty = new Map(baseline.files).set(rel, '');
  return boundaryViolations({ ...baseline, files: missing }).some(msg => msg === 'required: missing or empty ' + rel)
    && boundaryViolations({ ...baseline, files: empty }).some(msg => msg === 'required: missing or empty ' + rel);
}));
assert.equal(failed, 0, 'no-pet boundary checks failed: ' + failed);
console.log('NO-PET BOUNDARY CHECKS PASSED');
