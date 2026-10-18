import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../lib/settings-schema.js';
import { stripExportBlocks } from './tools/js-text.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const source = file => baseline
  ? execFileSync('git', ['-C', root, 'show', '5f87e698:' + file], { encoding: 'utf8' })
  : readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const runtime = ['src/effects.js', 'src/glass.js', 'src/glass-extra.js'].map(file => stripExportBlocks(source(file))).join('\n');
const values = new Map(), attrs = new Map();
const style = { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) };
const body = { style, setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key) };
const document = { body, querySelector: () => null, getElementById: () => null };
const selection = structuredClone(DEFAULTS);
const api = new Function('document', 'selection', 'removeFontStyles', 'clearUnderlayColor', 'syncSceneAudio', 'SCRIM_ID',
  runtime + '\nreturn { applyGlass, clearEffects };')(document, selection, () => {}, () => {}, () => {}, 'unused');
api.applyGlass(selection, style);
const inherited = values.get('--we-sidebar-blur');
selection.glassMode = { sidebar: 'custom', thinkingTrigger: 'custom' };
selection.sidebarBlur = 31; selection.thinkingTriggerBlur = 27;
api.applyGlass(selection, style);
assert.equal(values.get('--we-sidebar-blur'), '31px');
assert.equal(values.get('--we-thinking-trigger-blur'), '27px');
selection.glassMode = {}; api.applyGlass(selection, style);
assert.equal(values.get('--we-sidebar-blur'), inherited);
style.setProperty('--foreign-color', '#123456');
api.clearEffects();
assert.deepEqual([...values.keys()].filter(key => key.startsWith('--we-')), [],
  'clearEffects must remove every applyGlass variable');
assert.equal(attrs.size, 0, 'all glass gates must be removed');
assert.equal(values.get('--foreign-color'), '#123456');
api.clearEffects();
console.log('PASS glass custom/inherit rewrites, complete cleanup, foreign-style preservation and idempotent dispose');
