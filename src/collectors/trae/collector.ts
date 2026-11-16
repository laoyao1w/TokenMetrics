import type { Collector } from "../types.js";
import { collectFromFilesystem } from "../shared/filesystem-collector.js";
import { getHost } from "../../host/types.js";

export class TraeCollector implements Collector {
  readonly id = "trae";
  readonly displayName = "Trae CN";

  async collect() {
    return collectFromFilesystem({
      id: this.id,
      displayName: this.displayName,
      evidenceTypes: ["local-log", "local-database", "official-api"],
      warningWhenEmpty: "Trae local data directory was not found.",
      statusNotes: [
        "Trae CN local token ledger may be encrypted at rest, so plaintext log/database scans can miss real usage.",
        "If token-stats style Trae sync dumps exist, this collector can scan them as official-api evidence."
      ],
      maxDepth: 6,
      excludePathSubstrings: [
        `${getHost().path.sep}logs${getHost().path.sep}`,
        "cache_data",
        "code cache",
        "gpu cache",
        "blob_storage",
        "indexeddb",
        "service worker",
        `${getHost().path.sep}local storage${getHost().path.sep}`,
        "-wal",
        "-journal",
        "-shm"
      ],
      candidateRoots(environment) {
        const path = getHost().path;
        const roots = [];

        if (environment.appData) {
          roots.push(path.join(environment.appData, "Trae"));
          roots.push(path.join(environment.appData, "tokscale", "trae-cache", "sessions"));
        }

        roots.push(path.join(environment.homeDir, ".config", "tokscale", "trae-cache", "sessions"));

        return roots;
      },
      extraFilter(filePath) {
        const lower = filePath.toLowerCase();
        const sep = getHost().path.sep;
        return (
          lower.includes(`${sep}user${sep}history${sep}`) ||
          lower.includes("database.db")
        );
      },
      // 日志与浏览器缓存目录既庞大又无 token 证据，直接剔除可把扫描量从数千文件降到数百
      excludeFilter(filePath) {
        const lower = filePath.toLowerCase();
        const sep = getHost().path.sep;
        return (
          lower.includes(`${sep}logs${sep}`) ||
          lower.includes("cache_data") ||
          lower.includes("code cache") ||
          lower.includes("gpu cache") ||
          lower.includes("blob_storage") ||
          lower.includes("indexeddb") ||
          lower.includes("service worker") ||
          lower.includes(`${sep}local storage${sep}`) ||
          /-wal$|-journal$|-shm$/.test(lower)
        );
      }
    });
  }
}
