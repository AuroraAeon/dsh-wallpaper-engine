// puppet-atlas.js — 判定一个 puppet 图集能否用「平面 quad」等价拼合。
//
// 背景（用户报「3022080536 部件/背景错位」类问题的分类器）：
// WE 的 puppet 图层有两族图集语义 ——
//   ① **图集 1:1 拷贝**：网格顶点就是图集像素的搬运
//      （实测 `pos = (W·u − W/2, H/2 − H·v)`，残差 ≤ 0.0004 场景单位），
//      即「绑定姿势 = 图集排版姿势」→ 把整张图集当 quad 铺在对象 rect 上
//      与网格渲染**像素等价**（3022080536 背景/主体、2686862510 本体、
//      3735447194 全部 16 个部件…）。
//   ② **散件图集 (sheet)**：零件在图上散排，靠网格 UV 拾取 → 铺整图必然
//      「四肢飘带散一屏」（3784528825 两个 mesh 残差 697/988、3463520581
//      asuna body / kirito face 残差 72~308）。
//
// 静态帧提取器（lib/pkg-extract.js tryCompositeSceneLayers）用本模块区分两族：
// 只有 ① 允许按 quad 拼合，② 必须跳过（CPU 拼合不重建木偶姿态）。
//
// 为什么自带一个最小 MDL 顶点块扫描器（而不是复用 puppet.js `_parseMdl`）：
// 本模块只做**分类**（读 pos / uv / 索引，不建蒙皮、不产 payload），且必须在
// 两条基线（0.8.9 只认 80B 主布局 / 0.8.14 认 80B+52B）上都能分类 ——
// 复用 `_parseMdl` 会让 20B 静态布局（3022080536 背景_puppet.mdl）在旧基线
// 上落成 unknown，进而把整张背景踢出拼合。三重布局的知识点与
// `lib/we-renderer/puppet.js` 的 `_scanVertexBlock` 保持同步维护：
// 新增/修改布局时两处一起改（此处只多一条 20B 静态族，见 LAYOUTS）。
//
// 20B 静态族（本次新增，实测 3022080536 `models/背景_puppet.mdl`，7152B）：
//   [pos f32×3][uv f32×2] = 20B/顶点，228 顶点 / 1266 索引，z 恒 0、无蒙皮段
//   （文件里没有 MDLS/MDLA —— 静态网格，故没有 blend/weights 字段）。
//   识别判据比另两族更严：z 恒 0 + uv ∈ [−0.05,1.05]，且**最后**尝试（80/20
//   与 52/20 是整数倍关系，宽松匹配会在 80B 文件上误命中）。

/** 顶点块布局候选（顺序 = 识别优先级，先严后宽；20B 最后）。 */
const LAYOUTS = [
  { name: '80B', stride: 80, uv: 72, blend: 40, weight: 56, family: 'new' },
  { name: '52B', stride: 52, uv: 44, blend: 12, weight: 28, family: 'legacy' },
  { name: '20B', stride: 20, uv: 12, blend: -1, weight: -1, family: 'static' },
];

/** 逐行扫描候选顶点块：结构 + 顶点合理性 + 索引范围 + 布局专属判据。 */
function scanVertexBlock(dv, buf, mdlsOffset, L) {
  const isStatic = L.family === 'static';
  for (let offset = 9; offset + 12 < mdlsOffset; offset++) {
    const vertexBytes = dv.getUint32(offset + 4, true);
    if (vertexBytes === 0 || vertexBytes % L.stride !== 0) continue;
    const verticesOffset = offset + 8;
    const indexLenOffset = verticesOffset + vertexBytes;
    if (indexLenOffset + 4 > mdlsOffset) continue;
    const indexBytes = dv.getUint32(indexLenOffset, true);
    const indicesOffset = indexLenOffset + 4;
    if (indexBytes === 0 || indexBytes % 2 !== 0 || indicesOffset + indexBytes > mdlsOffset) continue;
    const vc = vertexBytes / L.stride;
    if (vc < 3) continue;
    const sample = Math.min(vc, 64);
    let sane = 0;
    for (let i = 0; i < sample; i++) {
      const vo = verticesOffset + i * L.stride;
      let ok = true;
      for (let k = 0; k < 3; k++) {
        const v = dv.getFloat32(vo + k * 4, true);
        if (!isFinite(v) || Math.abs(v) > 1e6) { ok = false; break; }
      }
      if (ok && isStatic && dv.getFloat32(vo + 8, true) !== 0) ok = false; // 静态族 z 恒 0
      if (ok) {
        const u = dv.getFloat32(vo + L.uv, true);
        const v = dv.getFloat32(vo + L.uv + 4, true);
        const lim = isStatic ? 1.05 : 5;
        if (!isFinite(u) || !isFinite(v) || Math.abs(u) > lim || Math.abs(v) > lim) ok = false;
      }
      if (ok) sane++;
    }
    if (sane < sample * 0.9) continue;
    // 52B 紧凑族额外校验蒙皮权重（4 项 0..1 且和 = 1）—— 与 puppet.js
    // `_scanVertexBlock` 的紧凑回退判据一致，防止噪声块被当成顶点块。
    if (L.family === 'legacy') {
      let wOk = 0;
      for (let i = 0; i < sample; i++) {
        const vo = verticesOffset + i * L.stride;
        let sum = 0, good = true;
        for (let k = 0; k < 4; k++) {
          const w = dv.getFloat32(vo + L.weight + k * 4, true);
          if (!isFinite(w) || w < -0.01 || w > 1.01) { good = false; break; }
          sum += w;
        }
        if (good && Math.abs(sum - 1) <= 0.02) wOk++;
      }
      if (wOk < sample * 0.9) continue;
    }
    const ic = indexBytes / 2;
    let idxOk = 0;
    for (let k = 0; k < Math.min(ic, 400); k++) if (dv.getUint16(indicesOffset + k * 2, true) < vc) idxOk++;
    if (idxOk < Math.min(ic, 400) * 0.98) continue;
    return { verticesOffset, vertexCount: vc, indicesOffset, indexCount: ic, layout: L };
  }
  return null;
}

/** 解析 MDL 的顶点块（不建蒙皮）：{vertices:[{x,y,u,v}], layout} | null。 */
function readVertexBlock(raw) {
  if (!raw || raw.length < 32) return null;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // MDLS 段起点 = 顶点/索引块的硬上界（块的字节数域必须落在它之前）
  let mdlsOffset = buf.length;
  for (let i = 9; i + 4 < buf.length; i++) {
    if (buf[i] === 0x4d && buf[i + 1] === 0x44 && buf[i + 2] === 0x4c && buf[i + 3] === 0x53) { mdlsOffset = i; break; }
  }
  for (const L of LAYOUTS) {
    const found = scanVertexBlock(dv, buf, mdlsOffset, L);
    if (!found) continue;
    const vertices = new Array(found.vertexCount);
    for (let i = 0; i < found.vertexCount; i++) {
      const vo = found.verticesOffset + i * L.stride;
      vertices[i] = {
        x: dv.getFloat32(vo, true),
        y: dv.getFloat32(vo + 4, true),
        u: dv.getFloat32(vo + L.uv, true),
        v: dv.getFloat32(vo + L.uv + 4, true),
      };
    }
    return { vertices, layout: L.name, indexCount: found.indexCount };
  }
  return null;
}

/** 最小二乘拟合 q ≈ A·p + B，返回 {A, B, maxResidual}。 */
function affineFit(p, q) {
  const n = p.length;
  let sp = 0, sq = 0, spp = 0, spq = 0;
  for (let i = 0; i < n; i++) { sp += p[i]; sq += q[i]; spp += p[i] * p[i]; spq += p[i] * q[i]; }
  const den = n * spp - sp * sp;
  if (!den) return { A: 0, B: 0, maxResidual: Infinity };
  const A = (n * spq - sp * sq) / den;
  const B = (sq - A * sp) / n;
  let maxResidual = 0;
  for (let i = 0; i < n; i++) maxResidual = Math.max(maxResidual, Math.abs(A * p[i] + B - q[i]));
  return { A, B, maxResidual };
}

/**
 * 分类一个 puppet 图集相对其对象 rect 的可平铺性。
 *
 * @param {Buffer|Uint8Array} raw      puppet MDL 字节
 * @param {number} expectedW           对象 rect 宽 (场景单位, 已含对象 scale)
 * @param {number} expectedH           对象 rect 高
 * @returns {{verdict:'aligned'|'scattered'|'unknown', layout?:string, residualX?:number,
 *            residualY?:number, vertexCount?:number, reason?:string}}
 *   aligned   = 图集 1:1 拷贝: uv→pos 仿射残差 ~0、pos bbox 与对象 rect 重合、
 *               uv 覆盖 [0,1] → 整图当 quad 铺该 rect 与网格渲染像素等价。
 *   scattered = 解析成功但非 1:1（散件图集）→ 拼合必然部件乱叠。
 *   unknown   = 顶点块无法识别 / 顶点过少 → 无从判定, 调用方按 scattered 处理。
 */
export function classifyPuppetAtlas(raw, expectedW, expectedH) {
  const block = readVertexBlock(raw);
  if (!block) return { verdict: 'unknown', reason: 'vertex-block-not-found' };
  const vs = block.vertices;
  if (vs.length < 3) return { verdict: 'unknown', layout: block.layout, vertexCount: vs.length, reason: 'too-few-vertices' };
  const us = vs.map((v) => v.u), vv = vs.map((v) => v.v);
  const xs = vs.map((v) => v.x), ys = vs.map((v) => v.y);
  const fx = affineFit(us, xs);
  const fy = affineFit(vv, ys);
  const span = Math.max(Math.abs(expectedW) || 0, Math.abs(expectedH) || 0, 1);
  const resTol = Math.max(0.5, span * 0.002);
  const aligned = {
    verdict: 'aligned', layout: block.layout, vertexCount: vs.length,
    residualX: fx.maxResidual, residualY: fy.maxResidual,
  };
  if (!(fx.maxResidual <= resTol) || !(fy.maxResidual <= resTol)) {
    return { ...aligned, verdict: 'scattered', reason: 'uv-to-pos not affine' };
  }
  // ① 图集覆盖: 网格必须吃到整张图集。**共用图集 (sprite sheet)** 的零件只采
  //    一个子矩形 (3735447194 的 16 个泡泡/腿/手共用 sheet, 每个 uv 只占一小块)
  //    → 铺整图会把 sheet 上别人家的零件一起画出来。留白边距不算问题: 3022080536
  //    主体网格 uv 从 0.017/0.022 起 (图集有 1~5% 未用边距), 故阈值取 90% 覆盖
  //    而不是贴边 [0,1]。
  const texCov = (arr) => (Math.max(...arr) - Math.min(...arr)) >= 0.9
    && Math.min(...arr) >= -0.05 && Math.max(...arr) <= 1.05;
  if (!texCov(us) || !texCov(vv)) return { ...aligned, verdict: 'scattered', reason: 'uv does not cover the atlas' };
  // ② rect 覆盖: 网格 bbox 必须与对象 rect 重合 (网格顶点是对象局部坐标, 原点
  //    居中)。子矩形放大铺 (A > W) 或只铺局部都会在这里落网。
  const halfW = Math.abs(expectedW) / 2, halfH = Math.abs(expectedH) / 2;
  if (!(halfW > 0) || !(halfH > 0)) return { ...aligned, verdict: 'unknown', reason: 'no-object-rect' };
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const cover = (lo, hi, half) => (hi - lo) >= 1.8 * half
    && (hi - lo) <= 2.1 * half && Math.abs((hi + lo) / 2) <= 0.1 * half;
  if (!cover(xMin, xMax, halfW) || !cover(yMin, yMax, halfH)) {
    return { ...aligned, verdict: 'scattered', reason: 'mesh bbox != object rect' };
  }
  return aligned;
}

/** access ({readFile(p)→{bytes}|null}) + 模型 json → 分类结果（缺 MDL 记 unknown）。 */
export function classifyPuppetModel(access, modelJson, expectedW, expectedH) {
  if (!modelJson || typeof modelJson.puppet !== 'string' || !modelJson.puppet) {
    return { verdict: 'unknown', reason: 'no-puppet-field' };
  }
  const f = access.readFile(modelJson.puppet);
  if (!f || !f.bytes) return { verdict: 'unknown', reason: 'mdl-unreadable' };
  try {
    return classifyPuppetAtlas(f.bytes, expectedW, expectedH);
  } catch (e) {
    return { verdict: 'unknown', reason: 'classify-threw:' + (e && e.message ? e.message : e) };
  }
}
