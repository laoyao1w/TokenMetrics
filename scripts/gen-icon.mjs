// Generates a 1024x1024 app icon PNG from the design prototype
// `assets/new-app-icon-design.jpg`: preserves the design's card EXACTLY as-is
// (edges, corner arcs, light bevel, bottom flame glow) and makes everything
// OUTSIDE the card silhouette fully transparent.
//
// Steps, all dependency-free:
//   1. Convert the JPG to a lossless PNG via Windows System.Drawing
//      (PowerShell one-liner; only used because plain Node can't decode JPEG).
//   2. Load the PNG with a small custom decoder (all filter types).
//   3. Flood-fill the black/gray background from the four corners.
//      Anything reached is background -> gets alpha 0.
//   4. Flood-fill from the center over the remaining pixels to keep only the
//      card region (drops stray noise islands that are not connected to it).
//   5. 3x3 supersampled anti-aliasing along the silhouette, writing an RGBA
//      PNG (source colors preserved inside the card).
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const DESIGN_SRC = path.resolve(ROOT, "assets/new-icon-design-v4-mega.png");
const OUT_FILE = path.resolve(ROOT, "assets/app-icon.png");
const SIZE = 1024;

// ---------------------------------------------------------------- PNG decode
function decodePNG(buf) {
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      bitDepth = buf[off + 16];
      colorType = buf[off + 17];
    } else if (type === "IDAT") {
      idat.push(buf.subarray(off + 8, off + 8 + len));
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || !(colorType === 2 || colorType === 6)) {
    throw new Error(`Unsupported PNG: depth=${bitDepth} colorType=${colorType}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[src++];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src++];
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[row - stride + x - bpp] : 0;
      let val;
      switch (f) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
      }
      px[row + x] = val & 0xff;
    }
  }
  return { width, height, bpp, px };
}

// ------------------------------------------------------------ background check
// The new design is a crisp subject on pure black background.
function isBg(r, g, b) {
  // Pure black background.
  return r < 15 && g < 15 && b < 15;
}

// ---------------------------------------------------------------- PNG encode
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- PNG -> PNG (Resize)
function resizePng() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tokenhall-"));
  const tmpPs1 = path.join(tmpDir, "resize.ps1");
  const outPng = path.join(tmpDir, "resized.png");
  const ps = `\
Add-Type -AssemblyName System.Drawing
$src = $args[0]
$dst = $args[1]
$img = [System.Drawing.Image]::FromFile($src)
$bmp = New-Object System.Drawing.Bitmap 1024, 1024
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, 0, 0, 1024, 1024)
$bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $img.Dispose()
`;
  writeFileSync(tmpPs1, ps);
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmpPs1, DESIGN_SRC, outPng], { stdio: "pipe" });
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`PNG resize failed: ${e.message}`);
  }
  return { tmpDir, outPng };
}

// ---------------------------------------------------------------- main
const { tmpDir, outPng } = resizePng();
let src;
try {
  src = decodePNG(readFileSync(outPng));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
const { width, height, bpp, px } = src;
const colorAt = (x, y) => {
  const i = (y * width + x) * bpp;
  return [px[i], px[i + 1], px[i + 2]];
};

// 1) background detection
const small = new Int8Array(width * height);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const [r, g, b] = colorAt(x, y);
    small[i] = isBg(r, g, b) ? 0 : 1;
  }
}

// 2) flood fill from corners to find reachable background
const vis = new Uint8Array(width * height);
const fillVisited = (seeds) => {
  const queue = new Int32Array(width * height * 2);
  let head = 0, tail = 0;
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (vis[i]) return;
    vis[i] = 1;
    queue[tail++] = x;
    queue[tail++] = y;
  };
  for (const [x, y] of seeds) push(x, y);
  while (head < tail) {
    const x = queue[head++], y = queue[head++];
    if (small[y * width + x] !== 0) continue; // background-only travel
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
};

fillVisited([[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]);
const reached = new Uint8Array(width * height); // 1 = background reached
for (let i = 0; i < width * height; i++) reached[i] = vis[i];

// 3) keep only pixels NOT reached by background fill
const cardMask = new Uint8Array(width * height);
for (let i = 0; i < width * height; i++) cardMask[i] = reached[i] ? 0 : 1;

// 4) alpha = 4x4 supersampled card mask coverage for ultra-smooth edges
const SS = 4;
const step = 1 / SS;
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let cov = 0;
    for (let sy = 0; sy < SS; sy++) {
      const py = Math.min(SIZE - 1, Math.floor(y + (sy + 0.5) * step));
      for (let sx = 0; sx < SS; sx++) {
        const px2 = Math.min(SIZE - 1, Math.floor(x + (sx + 0.5) * step));
        if (cardMask[py * SIZE + px2]) cov++;
      }
    }
    if (cov === 0) continue;
    const [r, g, b] = colorAt(x, y);
    const i = (y * SIZE + x) * 4;
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = Math.round((cov / (SS * SS)) * 255);
  }
}

writeFileSync(OUT_FILE, encodePNG(SIZE, SIZE, out));
console.log("Icon written:", OUT_FILE);