// 生成醍醐托盘图标动画帧（嘴部开合）
// 纯 Node 实现：逐像素绘制 -> 手写 PNG 编码（zlib deflate + CRC32）
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src-tauri", "icons", "tray");

const SIZE = 48; // 48x48，Windows 托盘在高分屏下更清晰
const FRAME_COUNT = 16;

// ---------- PNG 编码 ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = y * stride + 1 + x * 4;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
      raw[d + 3] = rgba[s + 3];
    }
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
const OUTLINE = [14, 26, 44]; // 深色描边
const HEAD = [241, 246, 252]; // 头部白色
const BEAK_GOLD = [255, 200, 97]; // 上喙金色（与主界面 --gold 一致）
const POUCH = [255, 156, 58]; // 下喙/喉囊橙色（与主界面 #ff9c3a 一致）
const INK = [18, 18, 28]; // 眼睛
const GLINT = [255, 255, 255]; // 眼睛高光

function makeCanvas(w, h) {
  return new Uint8Array(w * h * 4);
}

function blend(px, i, r, g, b, alpha) {
  if (alpha <= 0) return;
  const curA = px[i + 3] / 255;
  const sa = alpha;
  const oa = sa + curA * (1 - sa);
  if (oa <= 0) return;
  px[i] = Math.round((r * sa + px[i] * curA * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * curA * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * curA * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

function setPixel(px, w, h, x, y, color, alpha = 1) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
  blend(px, (yi * w + xi) * 4, color[0], color[1], color[2], alpha);
}

function distToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// 平滑边缘的实心圆
function fillCircle(px, w, h, cx, cy, r, color) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const delta = d - r;
      if (delta > 0.6) continue;
      const alpha = delta > -0.6 ? 0.6 - delta : 1;
      setPixel(px, w, h, x, y, color, Math.max(0, Math.min(1, alpha)));
    }
  }
}

// 平滑边缘的粗线段
function strokeLine(px, w, h, x0, y0, x1, y1, thickness, color) {
  const r = thickness / 2;
  const minX = Math.floor(Math.min(x0, x1) - r - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + r + 1);
  const minY = Math.floor(Math.min(y0, y1) - r - 1);
  const maxY = Math.ceil(Math.max(y0, y1) + r + 1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = distToSegment(x + 0.5, y + 0.5, x0, y0, x1, y1);
      const delta = d - r;
      if (delta > 0.6) continue;
      const alpha = delta > -0.6 ? 0.6 - delta : 1;
      setPixel(px, w, h, x, y, color, Math.max(0, Math.min(1, alpha)));
    }
  }
}

// ---------- 贝塞尔曲线采样 + 多边形填充（复刻主界面嘴型）----------

// 三次贝塞尔采样
function cubicSample(p0, p1, p2, p3, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    pts.push([
      mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0],
      mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

function rotatePt(p, cx, cy, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

// 点是否在多边形内（射线法）
function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 填充多边形（带 2x2 子采样抗锯齿）
function fillPolygon(px, w, h, poly, color) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const x0 = Math.max(0, Math.floor(minX - 1));
  const x1 = Math.min(w - 1, Math.ceil(maxX + 1));
  const y0 = Math.max(0, Math.floor(minY - 1));
  const y1 = Math.min(h - 1, Math.ceil(maxY + 1));
  const samples = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hits = 0;
      for (const [sx, sy] of samples) {
        if (insidePolygon(x + sx, y + sy, poly)) hits++;
      }
      if (hits > 0) setPixel(px, w, h, x, y, color, hits / 4);
    }
  }
}

// 以形心放大多边形（用于描边）
function dilatePoly(poly, f) {
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p[0];
    cy += p[1];
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map((p) => [cx + (p[0] - cx) * f, cy + (p[1] - cy) * f]);
}

// 主界面醍醐嘴部的原始路径（viewBox 100x100）：
//  上喙：M 58 10 C 72 2, 88 8, 86 15 C 80 17, 70 14, 58 14 Z
//  下喙/喉囊：M 57.55 15.05 C 65.2 16.15, 74.6 17.05, 80.25 18.55 C 72.8 21.25, 63.4 20.65, 58.3 18.45 C 57.7 17.25, 57.35 16.05, 57.55 15.05 Z
const UPPER_POLY_RAW = [
  ...cubicSample([58, 10], [72, 2], [88, 8], [86, 15], 24),
  ...cubicSample([86, 15], [80, 17], [70, 14], [58, 14], 16),
];
const LOWER_POLY_RAW = [
  ...cubicSample([57.55, 15.05], [65.2, 16.15], [74.6, 17.05], [80.25, 18.55], 16),
  ...cubicSample([80.25, 18.55], [72.8, 21.25], [63.4, 20.65], [58.3, 18.45], 16),
  ...cubicSample([58.3, 18.45], [57.7, 17.25], [57.35, 16.05], [57.55, 15.05], 10),
];

const ROT = Math.PI / 180;

// 嘴根旋转中心 + fit 参数（把 viewBox 100 坐标映射到 SIZE 画布）
const UP_HINGE = [58, 12];
const LOW_HINGE = [58, 17];
const SCALE = SIZE / 31; // 原嘴宽约 31
const OFFSET_X = (SIZE - 31 * SCALE) / 2;
const OFFSET_Y = (SIZE - 20 * SCALE) / 2 + 1;

function fitPoint(p) {
  return [OFFSET_X + (p[0] - 57) * SCALE, OFFSET_Y + (p[1] - 2.5) * SCALE];
}

// 绘制单帧：open 0..1（嘴张开程度）
// 满格特写：复刻主界面醍醐的弯月上喙 + 袋状喉囊，占满图标
function drawFrame(open) {
  const w = SIZE;
  const h = SIZE;
  const px = makeCanvas(w, h);

  // 开合角度：上喙上抬、下喙下压（与主界面一致），另加整体 5° 上倾
  const tilt = -5 * ROT;
  const upperAngle = tilt + (-9 * open) * ROT;
  const lowerAngle = tilt + (11 * open) * ROT;

  const upperPoly = UPPER_POLY_RAW.map((p) =>
    fitPoint(rotatePt(p, UP_HINGE[0], UP_HINGE[1], upperAngle))
  );
  const lowerPoly = LOWER_POLY_RAW.map((p) =>
    fitPoint(rotatePt(p, LOW_HINGE[0], LOW_HINGE[1], lowerAngle))
  );

  // 下喙（先画在底层）
  fillPolygon(px, w, h, dilatePoly(lowerPoly, 1.12), OUTLINE);
  fillPolygon(px, w, h, lowerPoly, POUCH);
  // 上喙（覆盖在上面）
  fillPolygon(px, w, h, dilatePoly(upperPoly, 1.12), OUTLINE);
  fillPolygon(px, w, h, upperPoly, BEAK_GOLD);

  return px;
}

// ---------- 生成全部帧 ----------
mkdirSync(OUT_DIR, { recursive: true });

for (let i = 0; i < FRAME_COUNT; i++) {
  // sin 曲线：0 -> 1 -> 0（张开再闭合，像喘气）
  const open = (1 - Math.cos((i / FRAME_COUNT) * Math.PI * 2)) / 2;
  const px = drawFrame(open);
  const png = encodePNG(SIZE, SIZE, px);
  const name = `pelican-${String(i).padStart(2, "0")}.png`;
  writeFileSync(join(OUT_DIR, name), png);
  // 同时输出 RGBA 裸数据，供 Rust include_bytes 直接使用（无需解码）
  writeFileSync(join(OUT_DIR, `pelican-${String(i).padStart(2, "0")}.raw`), Buffer.from(px));
}

console.log(`生成 ${FRAME_COUNT} 帧托盘图标 -> ${OUT_DIR}`);