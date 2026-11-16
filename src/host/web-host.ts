import type { FsEntry, FsStat, Host, SqlJsDatabase } from "./types.js";
import { setHost } from "./types.js";
import { createWebPath } from "./web-path.js";

/** Tauri v2 IPC 可用时的 window.__TAURI__（不要引入 @tauri-apps/api，避免打包膨胀）。 */
interface TauriCore {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
interface TauriWindow {
  __TAURI__?: { core?: TauriCore };
  location?: { href?: string };
}
declare const window: TauriWindow;

function tauriInvoke(): TauriCore {
  const core = window.__TAURI__?.core;
  if (!core) {
    throw new Error("__TAURI__.core is not available in this window.");
  }
  return core;
}

/** Tauri ipc::Response 在 JS 侧以 ArrayBuffer 形式返回。 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("expected binary response from Tauri command.");
}

interface TauriFsEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
}

interface TauriFsStat {
  isFile: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number | null;
  mtimeNs: number | null;
}

interface TauriWalkFilesArgs {
  root: string;
  maxDepth: number;
  skipSubstrings?: string[];
}

interface TauriFileContainsAnyArgs {
  path: string;
  needles: string[];
  maxBytes?: number;
}

function toFsEntry(entry: TauriFsEntry): FsEntry {
  return {
    name: entry.name,
    isDir: Boolean(entry.isDir),
    isFile: !entry.isDir && !entry.isSymlink,
    isSymlink: Boolean(entry.isSymlink)
  };
}

function toFsStat(info: TauriFsStat): FsStat {
  return {
    isFile: Boolean(info.isFile),
    isDir: Boolean(info.isDir),
    size: Number(info.size ?? 0),
    mtimeMs: Number(info.mtimeMs ?? 0),
    mtimeNs: Number(info.mtimeNs ?? 0)
  };
}

/** sql.js 初始化完成后返回的静态对象（含 Database 构造器）。 */
interface SqlJsStatic {
  Database: new (bytes?: Uint8Array) => SqlJsDatabase;
}

/** sql.js 浏览器版单例初始化（wasm 从 bundle 目录按需拉取，首次调用时加载）。 */
let sqlJsInitPromise: Promise<(config?: { wasmBinary?: Uint8Array }) => Promise<SqlJsStatic>> | undefined;
let sqlJsWasmPromise: Promise<Uint8Array | undefined> | undefined;

async function ensureSqlJs(): Promise<(config?: { wasmBinary?: Uint8Array }) => Promise<SqlJsStatic>> {
  sqlJsInitPromise ||= (async () => {
    const module = await import("sql.js");
    return module.default as unknown as (config?: { wasmBinary?: Uint8Array }) => Promise<SqlJsStatic>;
  })();
  return sqlJsInitPromise;
}

async function ensureSqlJsWasm(baseHref?: string): Promise<Uint8Array | undefined> {
  if (!baseHref) {
    return undefined;
  }
  sqlJsWasmPromise ||= (async () => {
    try {
      const response = await fetch(new URL("sql-wasm.wasm", baseHref));
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      // wasm 缺失时让 sql.js 按默认方式定位
      return undefined;
    }
  })();
  return sqlJsWasmPromise;
}

export async function createWebHost(): Promise<Host> {
  const core = tauriInvoke();
  const invoke = (command: string, args?: Record<string, unknown>) =>
    core.invoke(command, args);
  const platform = String(await invoke("platform")) as Host["platform"];

  // 预取常用环境变量，避免每次 env() 都走一遍 IPC。
  const envCache: Record<string, string | undefined> = {};
  const [userprofile, appdata, localappdata] = await Promise.all([
    invoke("os_env", { name: "USERPROFILE" }),
    invoke("os_env", { name: "APPDATA" }),
    invoke("os_env", { name: "LOCALAPPDATA" })
  ]);
  envCache.USERPROFILE = userprofile == null ? undefined : String(userprofile);
  envCache.APPDATA = appdata == null ? undefined : String(appdata);
  envCache.LOCALAPPDATA = localappdata == null ? undefined : String(localappdata);

  const host: Host = {
    platform,
    env: async (name) => envCache[name] ?? undefined,
    path: createWebPath(platform),
    async readDir(dirPath): Promise<FsEntry[]> {
      const entries = (await invoke("read_dir", { path: dirPath })) as TauriFsEntry[];
      return entries.map(toFsEntry);
    },
    async walkFiles(root: string, maxDepth: number, skipSubstrings?: string[]): Promise<string[]> {
      return (await invoke("walk_files", {
        root,
        maxDepth,
        skipSubstrings: skipSubstrings ?? []
      } satisfies TauriWalkFilesArgs)) as string[];
    },
    async fileContainsAny(filePath: string, needles: string[], maxBytes?: number): Promise<boolean> {
      return Boolean(
        await invoke("file_contains_any", {
          path: filePath,
          needles,
          maxBytes
        } satisfies TauriFileContainsAnyArgs)
      );
    },
    async stat(filePath): Promise<FsStat> {
      const info = (await invoke("fs_stat", { path: filePath })) as TauriFsStat;
      return toFsStat(info);
    },
    async readFile(filePath): Promise<Uint8Array> {
      const raw = await invoke("read_file", { path: filePath });
      return toBytes(raw);
    },
    async exists(filePath): Promise<boolean> {
      try {
        const info = (await invoke("fs_stat", { path: filePath })) as TauriFsStat;
        return Boolean(info) && (Boolean(info.isFile) || Boolean(info.isDir));
      } catch {
        return false;
      }
    },
    async openSqliteDb(bytes): Promise<SqlJsDatabase> {
      const wasmBinary = await ensureSqlJsWasm(window.location?.href);
      const init = await ensureSqlJs();
      const SQL = await init(wasmBinary ? { wasmBinary } : undefined);
      return new SQL.Database(bytes);
    },
    async readTraeSnapshot(path, keyOverride) {
      const raw = await invoke("read_trae_snapshot", {
        path,
        keyOverride: keyOverride ?? null
      });
      return toBytes(raw);
    }
  };

  return host;
}

export async function registerWebHost(): Promise<void> {
  const host = await createWebHost();
  setHost(host);
}
