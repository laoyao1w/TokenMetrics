import { setSha256 } from "./hash.js";

/**
 * 纯 JS SHA-256（UTF-8 输入），供 WebView 使用（无 node:crypto 的同步哈希）。
 * 实现对照 FIPS 180-4；tests 会用 node:crypto 做全量一致性校验。
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

function rotr(value: number, shift: number): number {
  return ((value >>> shift) | (value << (32 - shift))) >>> 0;
}

function hexWord(value: number): string {
  return value.toString(16).padStart(8, "0");
}

export function webSha256(input: string): string {
  const data = new TextEncoder().encode(input);
  const bitLength = data.length * 8;
  const bitHigh = Math.floor(bitLength / 4_294_967_296);
  const bitLow = (bitLength % 4_294_967_296) >>> 0;

  const remainder = data.length % 64;
  const zeroBytes = (56 - ((data.length + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(data.length + 1 + zeroBytes + 8);
  padded.set(data);
  padded[data.length] = 0x80;
  padded[padded.length - 8] = bitHigh >>> 24;
  padded[padded.length - 7] = (bitHigh >>> 16) & 0xff;
  padded[padded.length - 6] = (bitHigh >>> 8) & 0xff;
  padded[padded.length - 5] = bitHigh & 0xff;
  padded[padded.length - 4] = bitLow >>> 24;
  padded[padded.length - 3] = (bitLow >>> 16) & 0xff;
  padded[padded.length - 2] = (bitLow >>> 8) & 0xff;
  padded[padded.length - 1] = bitLow & 0xff;

  const hash = SHA256_INIT.slice();
  const words = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      const offset = block + index * 4;
      words[index] =
        ((padded[offset] << 24) |
          (padded[offset + 1] << 16) |
          (padded[offset + 2] << 8) |
          padded[offset + 3]) >>>
        0;
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(words[index - 15], 7) ^ rotr(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotr(words[index - 2], 17) ^ rotr(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return Array.from(hash, hexWord).join("");
}

/** 注册 Web 版 SHA-256（无 WebCrypto 依赖、同步可用）。 */
export function registerWebSha256(): void {
  setSha256(webSha256);
}