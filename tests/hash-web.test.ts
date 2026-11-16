import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { webSha256 } from "../src/core/hash-web.js";

function nodeSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const SAMPLES = [
  "",
  "a",
  "hello world",
  "AI时代，率先成为Token大户，猛蹬不走偏门",
  "https://tokenmetrology.pages.dev/verify?no=1&s=中文+空格%20编码",
  "x".repeat(63),
  "x".repeat(64),
  "x".repeat(65),
  "x".repeat(127),
  "x".repeat(128),
  "多字节".repeat(1000),
  JSON.stringify({ usage: { prompt_tokens: 1234, completion_tokens: 56 }, model: "claude-opus-4" })
];

describe("webSha256 parity with node:crypto", () => {
  it("matches node:crypto sha256 for various UTF-8 inputs", () => {
    for (const sample of SAMPLES) {
      expect(webSha256(sample), `input: ${sample.slice(0, 60)}`).toBe(nodeSha256(sample));
    }
  });

  it("matches the FIPS-180-4 known answer for 'abc'", () => {
    expect(webSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});