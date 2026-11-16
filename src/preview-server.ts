import { registerNodeSha256 } from "./core/hash-node.js";
import { registerNodeHost } from "./host/node-host.js";

registerNodeSha256();
registerNodeHost();

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCollectors } from "./collectors/registry.js";
import { deduplicateRecords } from "./core/deduplication.js";
import { summarizeUsage } from "./core/statistics.js";

const PORT = Number(process.env.PORT ?? 4173);
const FRONTEND_INDEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../frontend/index.html"
);
const FRONTEND_DIR = path.dirname(FRONTEND_INDEX);
const FRONTEND_ANIMATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../frontend/animation-preview.html"
);
const FRONTEND_RANKS = path.resolve(FRONTEND_DIR, "ranks.cjs");

async function buildPayload() {
  const collectors = getCollectors();
  const batches = await Promise.all(collectors.map((collector) => collector.collect()));
  const records = deduplicateRecords(batches.flatMap((batch) => batch.records));
  const summary = summarizeUsage(records);

  return {
    generatedAt: new Date().toISOString(),
    summary,
    collectors: batches.map((batch) => ({
      status: batch.status,
      coverage: batch.coverage
    }))
  };
}

const server = createServer(async (request, response) => {
  try {
    if (!request.url || request.url === "/") {
      const html = await readFile(FRONTEND_INDEX, "utf-8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(html);
      return;
    }

    if (request.url === "/animation-preview.html") {
      const html = await readFile(FRONTEND_ANIMATION, "utf-8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (request.url.startsWith("/verify.html")) {
      const html = await readFile(path.resolve(FRONTEND_DIR, "verify.html"), "utf-8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (request.url === "/ranks.cjs" || request.url === "/ranks.js") {
      const js = await readFile(FRONTEND_RANKS, "utf-8");
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(js);
      return;
    }

    if (request.url === "/qrcode.js") {
      const js = await readFile(path.resolve(FRONTEND_DIR, "qrcode.js"), "utf-8");
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(js);
      return;
    }

    if (request.url === "/api/summary") {
      const payload = await buildPayload();
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(payload));
      return;
    }

    // 通用静态资源回退：直接返回 frontend 目录下的既有文件（如 floatball.html）
    const urlPath = decodeURIComponent(request.url.split("?")[0]);
    const relativePath = urlPath.replace(/^\/+/, "");
    const requestedPath = path.resolve(FRONTEND_DIR, relativePath);
    const relativeToFrontend = path.relative(FRONTEND_DIR, requestedPath);
    const withinFrontend =
      relativeToFrontend === "" ||
      (!relativeToFrontend.startsWith("..") && !path.isAbsolute(relativeToFrontend));
    if (withinFrontend) {
      const ext = path.extname(requestedPath);
      if (
        ext === ".html" ||
        ext === ".js" ||
        ext === ".mjs" ||
        ext === ".css" ||
        ext === ".wasm" ||
        ext === ".json" ||
        ext === ".exe"
      ) {
        try {
          if ((await stat(requestedPath)).isFile()) {
            const mime =
              ext === ".html"
                ? "text/html; charset=utf-8"
                : ext === ".js" || ext === ".mjs"
                  ? "text/javascript; charset=utf-8"
                  : ext === ".css"
                    ? "text/css; charset=utf-8"
                    : ext === ".wasm"
                      ? "application/wasm"
                      : ext === ".json"
                        ? "application/json; charset=utf-8"
                        : "application/octet-stream";
            const data = await readFile(requestedPath);
            response.writeHead(200, {
              "content-type": mime,
              "cache-control": "no-store"
            });
            response.end(data);
            return;
          }
        } catch {
          // 文件不存在，落入 404
        }
      }
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ message: (error as Error).message }));
  }
});

server.listen(PORT, () => {
  console.log(`AI Token Hall preview running at http://127.0.0.1:${PORT}`);
});
