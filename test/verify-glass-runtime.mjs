import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { cssBodyOf } from './tools/src-scope.mjs';
// 剥 CSS 注释走共享实现（此前这里是一行朴素正则 —— 模块布局守卫规则 ⑦ 的针眼）。
import { stripCssComments } from './tools/css-text.mjs';

const root = resolve('.');
const bundle = readFileSync(resolve(root, 'lib/client.js'), 'utf8');
const css = stripCssComments(cssBodyOf(bundle));
const left = css.match(/body\[data-we-glass-page\]\[data-we-left-sidebar\] div:has\(> \[data-slot="sidebar"\]\)[^{]*\{([^}]+)\}/)?.[1] || '';
assert.ok(left, '必须读取真实构建的左栏绘制规则');
assert.ok(!/(?:^|[;\s])z-index:\s*0\b/.test(left), '左栏不得为负层载体新增 z-index:0 围栏');
assert.ok(!/(?:^|[;\s])position:\s*relative\b/.test(left), '不得改变宿主 absolute 包含块');
assert.ok(!/(?:^|[;\s])backdrop-filter:\s*(?!none)[^;]+/.test(left), '共享内容祖先不得承载模糊');
const path = resolve(root, 'src/glass-surfaces.js');
assert.ok(existsSync(path), '统一表面解析器必须存在，不能仅删除旧围栏');
const { weResolveSurface } = await import(new URL('../src/glass-surfaces.js', import.meta.url));
const safe = { enabled: true, visible: true, safeRoot: true };
assert.equal(weResolveSurface('left-sidebar', {}, safe).mode, 'root');
assert.equal(weResolveSurface('left-sidebar', { glassSurfacePolicy: { 'left-sidebar': 'native' } }, safe).reason, 'policy-native');
assert.equal(weResolveSurface('left-sidebar', {}, { ...safe, preserve: true }).reason, 'preserve');
assert.equal(weResolveSurface('left-sidebar', {}, { ...safe, visible: false }).reason, 'hidden');
assert.equal(weResolveSurface('left-sidebar', {}, { ...safe, enabled: false }).reason, 'disabled');
assert.equal(weResolveSurface('left-sidebar', {}, { ...safe, safeRoot: false }).mode, 'native');
assert.equal(weResolveSurface('right-sidebar', {}, { ...safe, nativeBlur: true }).reason, 'native-blur');
assert.equal(weResolveSurface('extra', {}, { ...safe, safeLocal: false }).mode, 'native');
assert.equal(weResolveSurface('extra', {}, { ...safe, safeLocal: true }).mode, 'local');
assert.equal(weResolveSurface('extra', {}, { ...safe, safeLocal: true, occupied: true }).reason, 'carrier-busy');
assert.equal(weResolveSurface('left-sidebar', {}, { ...safe, software: true }).mode, 'plate');

// ── 亚像素裁剪容差（2026-10-20 用户报障）───────────────────────────────────────
// 右栏在 DPR 1.25 下永不接管：宿主 AppFrame 右边缘 1281.5999755859375、面板右边缘
// 1281.6000366210938，相差 0.000061px，而祖先裁剪判据用严格 `>` ⇒ safeRoot 恒假
// ⇒ 永不认领 ⇒ 右栏退回 --we-panel-color 实色。这条判据在**源码层**钉住容差必须
// 存在（浏览器腿在 verify-glass-runtime-browser 里用真实几何复现正/负两向）。读源码
// 而不是跑 DOM，才能在无头环境与 CI 上都守住。
const surfacesSrc = readFileSync(path, 'utf8');
// 精确定位**祖先裁剪**那一条（文件里有四处 safeRoot = false，不能用第一次出现）。
const clipIdx = surfacesSrc.search(/hidden\|clip\/\.test\(cs\.overflow/);
assert.ok(clipIdx > 0, '必须能定位祖先裁剪判据（否则下面的容差判据恒真）');
const clipWindow = surfacesSrc.slice(clipIdx, clipIdx + 500);
assert.ok(/safeRoot = false;/.test(clipWindow), '定位到的片段必须包含裁剪判据本体');
assert.ok(/CLIP_EPSILON/.test(clipWindow),
  '祖先裁剪判据必须带亚像素容差（DPR 1.25 下贴边盒子差 0.0001px，严格比较会让表面永不接管）');
assert.ok(/clip\.(left|right|top|bottom)\s*[-+]\s*CLIP_EPSILON/.test(clipWindow),
  '容差必须真的参与比较（只声明常量但不用等于没有容差）');
const epsDecl = surfacesSrc.match(/const CLIP_EPSILON = ([0-9.]+);/);
assert.ok(epsDecl && Number(epsDecl[1]) > 0 && Number(epsDecl[1]) < 1,
  '容差必须是 (0, 1) 之间的正数（0 = 没有容差；≥1 会掩盖真实的裁剪回退）');

console.log('PASS | 真实构建无侧栏祖先围栏，解析器遵守策略、保留、可见性与安全回退');
