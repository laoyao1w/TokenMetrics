/** 目录条目（跨 Node/WebView 的最小 Dirent 等价物）。 */
export interface FsEntry {
  name: string;
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

/** 文件/目录统计（跨 Node/WebView 的最小 stat 等价物）。 */
export interface FsStat {
  isFile: boolean;
  isDir: boolean;
  size: number;
  /** 最后修改毫秒时间戳（Node mtimeMs）。 */
  mtimeMs: number;
  /** 最后修改纳秒余数，用于稳定性判断（Node bigint mtimeNs）。 */
  mtimeNs: number;
}

export type HostPlatform = "win32" | "darwin" | "linux";

/** 跨平台路径操作（Node path / WebView 纯 JS 实现的统一抽象）。 */
export interface PathOps {
  readonly sep: string;
  join(...parts: string[]): string;
  normalize(path: string): string;
  resolve(path: string): string;
  dirname(path: string): string;
  basename(path: string): string;
  extname(path: string): string;
  isAbsolute(path: string): boolean;
}

/** sql.js 打开后返回的数据库对象（node 版与 browser 版 API 一致）。 */
export interface SqlJsDatabase {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
}

/**
 * 宿主能力抽象：Node 侧（CLI / 预览服务器）由 node-host.ts 提供，
 * 桌面端 WebView 侧由 web-host.ts 通过 Tauri IPC 提供。
 * collector 共享逻辑只依赖本接口，不直接 import 任何 node 内置模块。
 */
export interface Host {
  platform: HostPlatform;
  env(name: string): Promise<string | undefined>;
  path: PathOps;
  readDir(path: string): Promise<FsEntry[]>;
  walkFiles?(root: string, maxDepth: number, skipSubstrings?: string[]): Promise<string[]>;
  fileContainsAny?(path: string, needles: string[], maxBytes?: number): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  /** 用 sql.js 打开一个内存 SQLite 数据库（明文字节）。 */
  openSqliteDb(bytes: Uint8Array): Promise<SqlJsDatabase>;
  /** 读取 Trae 国际版 SQLCipher 快照，返回解密后的明文 SQLite 字节。Node 侧不支持。 */
  readTraeSnapshot?(path: string, keyOverride?: string): Promise<Uint8Array>;
}

let currentHost: Host | undefined;

/** 在启动时注册宿主实现（node-host.ts / web-host.ts 调用）。 */
export function setHost(host: Host): void {
  currentHost = host;
}

/** 获取已注册的宿主实现，必须在首轮采集前注册。 */
export function getHost(): Host {
  if (!currentHost) {
    throw new Error(
      "host is not registered. Call setHost() (registerNodeHost / registerWebHost) at startup."
    );
  }
  return currentHost;
}
