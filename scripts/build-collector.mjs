// Builds the WebView collector bundle used by the Tauri desktop app:
//   frontend/collector.js   (esbuild IIFE bundle of src/webview/entry.ts, sql.js inlined)
//   frontend/sql-wasm.wasm  (sql.js WebAssembly binary, fetched at runtime)
//
// 替代旧的 runtime-prepare.mjs（node.exe + collector.mjs + wa-sqlite），
// 采集逻辑全部在 WebView 内执行，不再携带 Node 运行时。
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const frontendDir = path.join(root, "frontend");
const outfile = path.join(frontendDir, "collector.js");
const wasmSource = path.join(root, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const wasmTarget = path.join(frontendDir, "sql-wasm.wasm");

async function main() {
  mkdirSync(frontendDir, { recursive: true });

  await build({
    entryPoints: [path.join(root, "src", "webview", "entry.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["es2022", "chrome105", "edge105", "safari16"],
    outfile,
    sourcemap: false,
    minify: true,
    logLevel: "info"
  });

  if (!existsSync(wasmSource)) {
    throw new Error(`缺少 sql.js wasm: ${wasmSource}`);
  }
  copyFileSync(wasmSource, wasmTarget);

  console.log("WebView collector bundle ready ->");
  console.log("  collector.js:  ", statSync(outfile).size, "bytes");
  console.log("  sql-wasm.wasm: ", statSync(wasmTarget).size, "bytes");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});