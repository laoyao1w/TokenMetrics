import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { statSync } from "node:fs";
import { access, open, readdir } from "node:fs/promises";
import type { FsEntry, FsStat, Host, HostPlatform, SqlJsDatabase } from "./types.js";
import { setHost } from "./types.js";

let sqlJsPromise: Promise<{ Database: new (bytes?: Uint8Array) => SqlJsDatabase }> | undefined;

function platformOf(platform: NodeJS.Platform): HostPlatform {
  return platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
}

const host: Host = {
  platform: platformOf(process.platform),
  env: async (name) => process.env[name],
  path: path as unknown as Host["path"],
  async readDir(dirPath): Promise<FsEntry[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDir: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymlink: entry.isSymbolicLink()
    }));
  },
  async walkFiles(root, maxDepth, skipSubstrings = []): Promise<string[]> {
    const output: string[] = [];
    const normalizedSkips = skipSubstrings.map((value) => value.toLowerCase()).filter(Boolean);

    async function walk(currentPath: string, depth: number): Promise<void> {
      if (depth > maxDepth) {
        return;
      }

      const lowerPath = currentPath.toLowerCase();
      if (normalizedSkips.some((fragment) => lowerPath.includes(fragment))) {
        return;
      }

      let entries;
      try {
        entries = await readdir(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const nextPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(nextPath, depth + 1);
        } else if (entry.isFile()) {
          const lowerFilePath = nextPath.toLowerCase();
          if (normalizedSkips.some((fragment) => lowerFilePath.includes(fragment))) {
            continue;
          }
          output.push(nextPath);
        }
      }
    }

    await walk(root, 0);
    return output;
  },
  async fileContainsAny(filePath, needles, maxBytes): Promise<boolean> {
    const filtered = needles.filter(Boolean);
    if (filtered.length === 0) {
      return false;
    }

    const handle = await open(filePath, "r");
    const chunkSize = 64 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    const overlapBytes = Math.max(...filtered.map((needle) => Buffer.byteLength(needle, "utf8"))) - 1;
    let carry = "";
    let bytesScanned = 0;

    try {
      while (true) {
        const remaining = maxBytes === undefined ? chunkSize : Math.min(chunkSize, maxBytes - bytesScanned);
        if (remaining <= 0) {
          return false;
        }

        const { bytesRead } = await handle.read(buffer, 0, remaining, null);
        if (bytesRead <= 0) {
          return false;
        }

        bytesScanned += bytesRead;
        const text = carry + buffer.toString("utf8", 0, bytesRead);
        if (filtered.some((needle) => text.includes(needle))) {
          return true;
        }

        carry = text.slice(-Math.max(overlapBytes, 0));
      }
    } finally {
      await handle.close();
    }
  },
  async stat(filePath): Promise<FsStat> {
    const big = statSync(filePath, { bigint: true });
    return {
      isFile: big.isFile(),
      isDir: big.isDirectory(),
      size: Number(big.size),
      mtimeMs: Number(big.mtimeMs),
      mtimeNs: Number(big.mtimeNs % 1_000_000_000n)
    };
  },
  async readFile(filePath): Promise<Uint8Array> {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(filePath));
  },
  async exists(filePath): Promise<boolean> {
    try {
      await access(filePath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  async openSqliteDb(bytes): Promise<SqlJsDatabase> {
    sqlJsPromise ||= (async () => {
      const { default: initSqlJs } = await import("sql.js");
      return initSqlJs();
    })();
    const SQL = await sqlJsPromise;
    return new SQL.Database(bytes);
  }
};

export function registerNodeHost(): void {
  setHost(host);
}

export function nodeHomeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? "";
}
