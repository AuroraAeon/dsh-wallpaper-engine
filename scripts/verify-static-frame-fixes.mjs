/**
 * verify-static-frame-fixes.mjs — 静态帧两处根因的回归测试。
 *
 * 覆盖（均为自包含合成夹具；真实壁纸存在时才追加探测）：
 *   A. decodePngPayload 的 RGB (PNG color-type 2) 反滤修复：
 *      旧实现拿 4B/px 的 RGBA 输出缓冲当源行扫，ct=2 载荷下每行只写 w*3 字节、
 *      行尾 25% 恒 0（黑竖带）+ 像素横向串道。这里断言 ct=2 解码 = 原图、
 *      alpha 全 255、末列非黑；ct=6 逐像素不变（零回归）。
 *   B. puppet 图集可平铺性分类（lib/we-renderer/puppet-atlas.js）：
 *      1:1 图集（含 20B 静态布局）→ aligned；共用图集子矩形 / 非仿射散件 →
 *      scattered；无法识别 → unknown。
 *   C. 拼合策略（lib/pkg-extract.js tryCompositeSceneLayers）：
 *      全组 puppet 图层都 1:1 才整组进入拼合；只要有一个散件图集整组跳过
 *      （退回单纹理路径）。3022080536 静态帧「只剩宣纸、人物消失」的回归点。
 *
 * Usage:  node scripts/verify-static-frame-fixes.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgExtract = await import(pathToFileURL(resolve(root, 'lib', 'pkg-extract.js')).href);
const atlas = await import(pathToFileURL(resolve(root, 'lib', 'we-renderer', 'puppet-atlas.js')).href);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
}

// ── fixtures ────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Encode a PNG with an explicit per-row filter type (filters[i]). */
function encodePng({ width, height, pixels, colorType }) {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filters(y);
    const base = y * (width * channels + 1);
    raw[base] = f;
    const src = y * width * channels;
    for (let i = 0; i < width * channels; i++) {
      const a = i >= channels ? pixels[src + i - channels] : 0;
      const b = y > 0 ? pixels[src - width * channels + i] : 0;
      const c = y > 0 && i >= channels ? pixels[src - width * channels + i - channels] : 0;
      const x = pixels[src + i];
      let v = x;
      if (f === 1) v = (x - a) & 255;
      else if (f === 2) v = (x - b) & 255;
      else if (f === 3) v = (x - ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (x - pred) & 255;
      }
      raw[base + 1 + i] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function gradientPixels(width, height, channels) {
  const px = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      px[o] = 10 + x * 20;            // red ramp (unique per column)
      px[o + 1] = 200 - y * 15;       // green ramp (unique per row)
      px[o + 2] = 30 + ((x * 7 + y * 11) % 90);
      if (channels === 4) px[o + 3] = 40 + ((x * 13 + y * 5) % 200);
    }
  }
  return px;
}
let filters = () => 0;

// Synthetic MDL: [9B 段头][u32 vertexBytes][顶点...][u32 indexBytes][索引...]
// 顶点块从 offset 9 起（扫描器读 offset+4 的字节数域、offset+8 的顶点区）。
function buildMdl({ vertices, indices, stride, uvOff }) {
  const vb = Buffer.alloc(vertices.length * stride);
  vertices.forEach((v, i) => {
    const o = i * stride;
    vb.writeFloatLE(v.x, o);
    vb.writeFloatLE(v.y, o + 4);
    vb.writeFloatLE(v.z || 0, o + 8);
    if (stride === 80) {
      vb.writeFloatLE(0, o + 12); vb.writeFloatLE(0, o + 16); vb.writeFloatLE(1, o + 20);
      for (let k = 0; k < 4; k++) vb.writeUInt32LE(0, o + 40 + k * 4);
      for (let k = 0; k < 4; k++) vb.writeFloatLE(k === 0 ? 1 : 0, o + 56 + k * 4);
    } else if (stride === 52) {
      for (let k = 0; k < 4; k++) vb.writeUInt32LE(0, o + 12 + k * 4);
      for (let k = 0; k < 4; k++) vb.writeFloatLE(k === 0 ? 1 : 0, o + 28 + k * 4);
    }
    vb.writeFloatLE(v.u, o + uvOff);
    vb.writeFloatLE(v.v, o + uvOff + 4);
  });
  const ib = Buffer.alloc(indices.length * 2);
  indices.forEach((n, i) => ib.writeUInt16LE(n, i * 2));
  const head = Buffer.alloc(17);
  head.writeUInt32LE(vb.length, 13);
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(ib.length, 0);
  return Buffer.concat([head, vb, tail, ib]);
}
/** A 2×2 grid mesh over the uv rect [u0,u1]×[v0,v1] scaled into a rect of w×h. */
function gridMesh({ u0 = 0, u1 = 1, v0 = 0, v1 = 1, w, h, z = 0 }) {
  const vs = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const fu = gx / 2, fv = gy / 2;
      vs.push({
        x: -w / 2 + fu * w,
        y: h / 2 - fv * h,
        z,
        u: u0 + fu * (u1 - u0),
        v: v0 + fv * (v1 - v0),
      });
    }
  }
  const idx = [];
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const a = gy * 3 + gx, b = a + 1, c = a + 3, d = a + 4;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { vertices: vs, indices: idx };
}

// Synthetic TEX (RGBA8888 raw mip) — same layout as scripts/verify-scene.mjs.
function buildTexRgba(width, height, rgbaBytes) {
  const mip = Buffer.alloc(20 + rgbaBytes.length);
  mip.writeInt32LE(width, 0);
  mip.writeInt32LE(height, 4);
  mip.writeInt32LE(0, 8);
  mip.writeInt32LE(0, 12);
  mip.writeInt32LE(rgbaBytes.length, 16);
  rgbaBytes.copy(mip, 20);
  const header = Buffer.alloc(9 + 9 + 4 * 8 + 9 + 4 * 2);
  let p = 0;
  header.write('TEXV0005\0', p, 'ascii'); p += 9;
  header.write('TEXI0001\0', p, 'ascii'); p += 9;
  header.writeInt32LE(0, p); p += 4;
  header.writeInt32LE(0, p); p += 4;
  header.writeInt32LE(width, p); p += 4;
  header.writeInt32LE(height, p); p += 4;
  header.writeInt32LE(width, p); p += 4;
  header.writeInt32LE(height, p); p += 4;
  header.writeInt32LE(0, p); p += 4;
  header.write('TEXB0002\0', p, 'ascii'); p += 9;
  header.writeInt32LE(1, p); p += 4;
  header.writeInt32LE(1, p); p += 4;
  return Buffer.concat([header.subarray(0, p), mip]);
}
function checkerRgba(width, height, a, b) {
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const first = ((x >> 3) + (y >> 3)) % 2 === 0;
      const c = first ? a : b;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  return px;
}

const WORK = join(root, '.test-cache', 'static-frame-fixes');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ── Level A: PNG payload decode (color type 2 vs 6) ────────────────────────
console.log('Level A — decodePngPayload (ct=2 / ct=6)');
{
  const W = 16, H = 6;
  const ctl = [0, 1, 2, 3, 4];
  filters = (y) => ctl[y % ctl.length];
  const px3 = gradientPixels(W, H, 3);
  const png3 = encodePng({ width: W, height: H, pixels: px3, colorType: 2 });
  const dec3 = pkgExtract.decodePngPayload(png3);
  check('ct=2 载荷可解码', !!dec3 && dec3.width === W && dec3.height === H);
  if (dec3) {
    let mismatch = 0, alphaBad = 0, lastQuarterBlack = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, s = (y * W + x) * 3;
        if (dec3.rgba[o] !== px3[s] || dec3.rgba[o + 1] !== px3[s + 1] || dec3.rgba[o + 2] !== px3[s + 2]) mismatch++;
        if (dec3.rgba[o + 3] !== 255) alphaBad++;
        if (x >= W * 0.75 && dec3.rgba[o] === 0 && dec3.rgba[o + 1] === 0 && dec3.rgba[o + 2] === 0) lastQuarterBlack++;
      }
    }
    check('ct=2 逐像素 = 原图（无串道）', mismatch === 0, 'mismatch=' + mismatch);
    check('ct=2 alpha 全 255', alphaBad === 0, 'badAlpha=' + alphaBad);
    check('ct=2 末 25% 不是黑带', lastQuarterBlack === 0, 'blackPixels=' + lastQuarterBlack);
  }
  // 只用一个滤波类型也过一遍（滤波无关性）
  filters = () => 0;
  const png3b = encodePng({ width: W, height: H, pixels: px3, colorType: 2 });
  const dec3b = pkgExtract.decodePngPayload(png3b);
  let same = !!dec3b;
  if (dec3b) for (let i = 0; i < px3.length; i++) if (dec3b.rgba[((i / 3) | 0) * 4 + (i % 3)] !== px3[i]) same = false;
  check('ct=2 全 filter-none 行同样精确', same);

  // ct=6（RGBA）零回归：带真实 alpha 逐像素一致
  filters = (y) => ctl[(y + 2) % ctl.length];
  const px4 = gradientPixels(W, H, 4);
  const png6 = encodePng({ width: W, height: H, pixels: px4, colorType: 6 });
  const dec6 = pkgExtract.decodePngPayload(png6);
  let mismatch6 = 0;
  if (dec6) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        for (let k = 0; k < 4; k++) if (dec6.rgba[o + k] !== px4[o + k]) mismatch6++;
      }
    }
  }
  check('ct=6 (RGBA) 逐像素 = 原图（含 alpha）', !!dec6 && mismatch6 === 0, 'mismatch=' + mismatch6);

  // 拒绝路径不变：隔行 / 调色板 / 非 PNG
  const interlaced = Buffer.from(encodePng({ width: W, height: H, pixels: px3, colorType: 2 }));
  interlaced[28] = 1;
  check('隔行 PNG 仍拒绝', pkgExtract.decodePngPayload(interlaced) === null);
  const pal = Buffer.from(encodePng({ width: W, height: H, pixels: px3, colorType: 2 }));
  pal[25] = 3;
  check('调色板 (ct=3) 仍拒绝', pkgExtract.decodePngPayload(pal) === null);
  check('非 PNG 拒绝', pkgExtract.decodePngPayload(Buffer.from('not a png at all')) === null);
}

// ── Level B: puppet 图集可平铺性分类 ───────────────────────────────────────
console.log('Level B — classifyPuppetAtlas');
{
  const aligned80 = buildMdl({ ...gridMesh({ w: 200, h: 100 }), stride: 80, uvOff: 72 });
  const v1 = atlas.classifyPuppetAtlas(aligned80, 200, 100);
  check('80B 1:1 图集 → aligned', v1.verdict === 'aligned', JSON.stringify(v1));

  const aligned52 = buildMdl({ ...gridMesh({ w: 300, h: 150 }), stride: 52, uvOff: 44 });
  const v2 = atlas.classifyPuppetAtlas(aligned52, 300, 150);
  check('52B 1:1 图集 → aligned', v2.verdict === 'aligned', JSON.stringify(v2));

  const static20 = buildMdl({ ...gridMesh({ w: 620, h: 352 }), stride: 20, uvOff: 12 });
  const v3 = atlas.classifyPuppetAtlas(static20, 620, 352);
  check('20B 静态布局 1:1 → aligned', v3.verdict === 'aligned' && v3.layout === '20B', JSON.stringify(v3));

  // 共用图集子矩形（零件只采 sheet 的一小块）→ 整图平铺会画出别人的零件
  const sheetPart = buildMdl({ ...gridMesh({ u0: 0.1, u1: 0.4, v0: 0.55, v1: 0.8, w: 200, h: 100 }), stride: 80, uvOff: 72 });
  const v4 = atlas.classifyPuppetAtlas(sheetPart, 200, 100);
  check('共用图集子矩形 → scattered', v4.verdict === 'scattered', JSON.stringify(v4));

  // 非仿射（散件按各自位置摆放）→ scattered
  const scattered = gridMesh({ w: 200, h: 100 });
  scattered.vertices = scattered.vertices.map((p, i) => (i === 4 ? { ...p, x: p.x + 60, y: p.y - 40 } : p));
  const spread = buildMdl({ ...scattered, stride: 80, uvOff: 72 });
  const v5 = atlas.classifyPuppetAtlas(spread, 200, 100);
  check('非仿射网格 → scattered', v5.verdict === 'scattered', JSON.stringify(v5));

  // 网格 bbox 与对象 rect 不符（例如 rect 用了 declared size 而网格只覆盖局部）
  const v6 = atlas.classifyPuppetAtlas(aligned80, 400, 200);
  check('图集 1:1 但 rect 不符 → scattered', v6.verdict === 'scattered', JSON.stringify(v6));

  check('垃圾字节 → unknown', atlas.classifyPuppetAtlas(Buffer.alloc(64, 7), 100, 100).verdict === 'unknown');
  check('空 MDL → unknown', atlas.classifyPuppetAtlas(Buffer.alloc(0), 100, 100).verdict === 'unknown');
}

// ── Level C: 拼合策略（全有或全无） ────────────────────────────────────────
console.log('Level C — tryCompositeSceneLayers puppet 策略');
{
  const sceneDir = join(WORK, 'scene');
  const writeScene = (scene, files) => {
    rmSync(sceneDir, { recursive: true, force: true });
    mkdirSync(join(sceneDir, 'models'), { recursive: true });
    mkdirSync(join(sceneDir, 'materials'), { recursive: true });
    writeFileSync(join(sceneDir, 'scene.json'), JSON.stringify(scene));
    for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(sceneDir, rel), bytes);
  };
  const bgTex = buildTexRgba(64, 64, checkerRgba(64, 64, [240, 230, 210], [200, 190, 170]));
  const fgTex = buildTexRgba(64, 64, checkerRgba(64, 64, [20, 40, 200], [200, 40, 20]));
  const plainModel = Buffer.from(JSON.stringify({ material: 'materials/plain.json' }));
  const puppetModel = Buffer.from(JSON.stringify({ material: 'materials/fg.json', puppet: 'models/fg_puppet.mdl' }));
  const files = {
    'materials/bg.tex': bgTex,
    'materials/fg.tex': fgTex,
    'materials/plain.json': Buffer.from(JSON.stringify({ passes: [{ textures: ['bg.tex'] }] })),
    'materials/fg.json': Buffer.from(JSON.stringify({ passes: [{ textures: ['fg.tex'] }] })),
    'models/plain.json': plainModel,
    'models/fg.json': puppetModel,
  };
  const scene = (puppetIsSheet) => ({
    version: 1,
    general: { orthogonalprojection: { width: 200, height: 200 }, clearenabled: true, clearcolor: '0.7 0.7 0.7' },
    objects: [
      {
        name: '背景', image: 'models/plain.json', origin: '100.00000 100.00000 0.00000',
        size: '200.00000 200.00000', scale: '1.00000 1.00000 1.00000', angles: '0 0 0',
        alignment: 'center', alpha: 1, visible: true,
      },
      {
        name: '人物', image: 'models/fg.json', origin: '100.00000 100.00000 0.00000',
        size: '100.00000 100.00000', scale: '1.00000 1.00000 1.00000', angles: '0 0 0',
        alignment: 'center', alpha: 1, visible: true,
      },
    ],
  });

  // C1: puppet 网格 1:1 → 两层都进拼合
  writeScene(scene(false), {
    ...files,
    'models/fg_puppet.mdl': buildMdl({ ...gridMesh({ w: 100, h: 100 }), stride: 80, uvOff: 72 }),
  });
  const r1 = pkgExtract.extractSceneMainImageFromDir(sceneDir);
  check('C1 全 1:1 木偶 → 参与拼合', /^composite\(2 layers\)$/.test(r1.texturePath), r1.texturePath + ' ' + r1.width + 'x' + r1.height);

  // C2: puppet 网格是共用图集的小块 → 整组跳过 → 单层 → 退回单纹理
  writeScene(scene(true), {
    ...files,
    'models/fg_puppet.mdl': buildMdl({ ...gridMesh({ u0: 0.12, u1: 0.4, v0: 0.5, v1: 0.78, w: 100, h: 100 }), stride: 80, uvOff: 72 }),
  });
  const r2 = pkgExtract.extractSceneMainImageFromDir(sceneDir);
  check('C2 散件图集 → 不拼合', !/^composite/.test(r2.texturePath), r2.texturePath);

  // C3: 两层普通图 + 1:1 木偶 + 散件木偶 → 全有或全无：木偶整组跳过，普通层仍拼
  writeScene(scene(false), {
    ...files,
    'models/plain_fg.json': Buffer.from(JSON.stringify({ material: 'materials/fg.json' })),
    'models/fg_puppet.mdl': buildMdl({ ...gridMesh({ w: 100, h: 100 }), stride: 80, uvOff: 72 }),
    'models/fg2.json': Buffer.from(JSON.stringify({ material: 'materials/fg.json', puppet: 'models/fg2_puppet.mdl' })),
    'models/fg2_puppet.mdl': buildMdl({ ...gridMesh({ u0: 0.1, u1: 0.5, v0: 0.1, v1: 0.5, w: 100, h: 100 }), stride: 80, uvOff: 72 }),
  });
  const sceneC3 = scene(false);
  sceneC3.objects.push({
    name: '底色块', image: 'models/plain_fg.json', origin: '50.00000 50.00000 0.00000',
    size: '100.00000 100.00000', scale: '1.00000 1.00000 1.00000', angles: '0 0 0',
    alignment: 'center', alpha: 1, visible: true,
  });
  sceneC3.objects.push({
    name: '人物2', image: 'models/fg2.json', origin: '100.00000 100.00000 0.00000',
    size: '100.00000 100.00000', scale: '1.00000 1.00000 1.00000', angles: '0 0 0',
    alignment: 'center', alpha: 1, visible: true,
  });
  writeFileSync(join(sceneDir, 'scene.json'), JSON.stringify(sceneC3));
  const r3 = pkgExtract.extractSceneMainImageFromDir(sceneDir);
  check('C3 混合（1:1 + 散件）→ 木偶整组跳过、普通层保留', /^composite\(2 layers\)$/.test(r3.texturePath), r3.texturePath);
}

// ── Level D: 真实壁纸（存在才跑，且只做只读断言） ─────────────────────────
console.log('Level D — real fixture probes');
{
  const weRoot = process.env.DSH_WE_TEXTURE_ROOT || join(process.env.HOME || '', 'Pictures', 'WallpaperEngine');
  const probe = (id) => join(weRoot, id, 'scene.pkg');
  const has = (id) => existsSync(probe(id));
  if (!has('3022080536')) {
    console.log('  · 跳过：未找到 ' + probe('3022080536'));
  } else {
    const access = pkgExtract.pkgSceneAccess(new Uint8Array(readFileSync(probe('3022080536'))));
    const scene = access.readJson('scene.json');
    const verdicts = scene.objects
      .filter((o) => o.visible !== false && typeof o.image === 'string' && o.image.endsWith('.json'))
      .map((o) => {
        const mj = access.readJson(o.image);
        if (!mj || !mj.puppet) return null;
        const size = typeof o.size === 'string' ? o.size.split(/\s+/).map(parseFloat) : [0, 0];
        return { name: o.name, verdict: atlas.classifyPuppetModel(access, mj, size[0], size[1]) };
      })
      .filter(Boolean);
    check('D1 3022080536 背景/主体 均判定 1:1', verdicts.length >= 2 && verdicts.every((v) => v.verdict.verdict === 'aligned'),
      verdicts.map((v) => v.name + '=' + v.verdict.verdict + (v.verdict.layout ? '/' + v.verdict.layout : '')).join(' '));
    check('D2 背景_puppet.mdl 走 20B 静态布局', verdicts.some((v) => v.verdict.layout === '20B'),
      verdicts.map((v) => v.name + ':' + v.verdict.layout).join(' '));
    const frame = pkgExtract.extractSceneMainImage(new Uint8Array(readFileSync(probe('3022080536'))));
    check('D3 静态帧 = 多层拼合（不再只剩单纹理）', /^composite\(/.test(frame.texturePath), frame.texturePath);
    if (/^composite\(/.test(frame.texturePath)) {
      const png = Buffer.from(frame.bytes);
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      // 解码出 RGBA 才能采样；直接断言「末 25% 不是黑带」需要像素 —
      // 用 PNG 体积/尺寸做弱断言，像素级断言见 Level A。
      check('D4 拼合帧尺寸 = 投影尺寸', w === 6208 && h === 3520, w + 'x' + h);
    }
  }
  if (has('3784528825')) {
    const access = pkgExtract.pkgSceneAccess(new Uint8Array(readFileSync(probe('3784528825'))));
    const scene = access.readJson('scene.json');
    const verdicts = scene.objects
      .filter((o) => o.visible !== false && typeof o.image === 'string' && o.image.endsWith('.json'))
      .map((o) => {
        const mj = access.readJson(o.image);
        if (!mj || !mj.puppet) return null;
        const size = typeof o.size === 'string' ? o.size.split(/\s+/).map(parseFloat) : [0, 0];
        return { name: o.name, verdict: atlas.classifyPuppetModel(access, mj, size[0], size[1]) };
      })
      .filter(Boolean);
    check('D5 3784528825 散件图集仍判定 scattered',
      verdicts.length >= 1 && verdicts.every((v) => v.verdict.verdict === 'scattered'),
      verdicts.map((v) => v.name + '=' + v.verdict.verdict).join(' '));
  } else {
    console.log('  · 跳过：未找到 ' + probe('3784528825'));
  }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
