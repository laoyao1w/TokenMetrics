import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const DESIGN_JPG = path.resolve(ROOT, "assets/new-icon-design-v4-mega.jpg");

function convertJpgToPng() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "tokenhall-"));
  const tmpPs1 = path.join(tmpDir, "conv.ps1");
  const outPng = path.join(tmpDir, "design.png");
  const ps = `\
Add-Type -AssemblyName System.Drawing
$src = $args[0]
$dst = $args[1]
$img = [System.Drawing.Image]::FromFile($src)
$bmp = New-Object System.Drawing.Bitmap $img
$bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $img.Dispose()
`;
  writeFileSync(tmpPs1, ps);
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmpPs1, DESIGN_JPG, outPng], { stdio: "pipe" });
  } catch (e) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`JPG -> PNG conversion failed: ${e.message}`);
  }
  return { tmpDir, outPng };
}

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

const { tmpDir, outPng } = convertJpgToPng();
let src;
try {
  src = decodePNG(readFileSync(outPng));
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const { width, height, bpp, px } = src;
console.log(`Image size: ${width}x${height}`);

const cy = Math.floor(height / 2);
let printed = 0;
console.log("Checking top...");
for (let y = 0; y < height / 2; y++) {
  const i = (y * width + 512) * bpp;
  const r = px[i], g = px[i+1], b = px[i+2];
  if (r > 30 || g > 30 || b > 30) {
    console.log(`y=${y}, rgb=(${r},${g},${b})`);
    printed++;
    if (printed > 60) break;
  }
}
