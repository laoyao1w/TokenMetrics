import type { HostPlatform, PathOps } from "./types.js";

function isWin32(platform: HostPlatform): boolean {
  return platform === "win32";
}

/**
 * 纯 JS 跨平台路径工具（Node path 的最小等价物，供 WebView 使用）。
 * win32 语义：两种分隔符都识别，盘符感知。posix 语义：仅 / 分隔。
 */
export function createWebPath(platform: HostPlatform): PathOps {
  if (isWin32(platform)) {
    return createWin32Path();
  }
  return createPosixPath();
}

function createPosixPath(): PathOps {
  const sep = "/";
  const isAbsolute = (value: string) => value.startsWith("/");
  const dirname = (value: string) => {
    const parts = value.split("/");
    parts.pop();
    return parts.join("/") || ".";
  };
  const basename = (value: string) => value.split("/").pop() ?? "";
  const extname = (value: string) => {
    const base = basename(value);
    const index = base.lastIndexOf(".");
    return index > 0 ? base.slice(index) : "";
  };
  const normalize = (value: string) => {
    const absolute = isAbsolute(value);
    const parts = value.replace(/\/+/g, "/").split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") {
        continue;
      }
      if (part === "..") {
        if (stack.length > 0 && stack[stack.length - 1] !== "..") {
          stack.pop();
        } else if (!absolute) {
          stack.push("..");
        }
      } else {
        stack.push(part);
      }
    }
    const rest = stack.join(sep);
    if (!rest) {
      return absolute ? sep : ".";
    }
    return absolute ? `${sep}${rest}` : rest;
  };
  const resolve = (value: string) => normalize(isAbsolute(value) ? value : `${sep}${value}`);
  const join = (...parts: string[]) => normalize(parts.filter((part) => part !== "").join(sep));
  return { sep, join, normalize, resolve, dirname, basename, extname, isAbsolute };
}

function createWin32Path(): PathOps {
  const sep = "\\";
  const driveOf = (value: string): string | null => {
    const match = /^([a-zA-Z]:)/.exec(value);
    return match ? match[1] : null;
  };
  const isAbsolute = (value: string) => {
    const drive = driveOf(value);
    if (drive) {
      return value.length === 2 || value[2] === "\\" || value[2] === "/";
    }
    return value.startsWith("\\") || value.startsWith("/");
  };
  const partsOf = (value: string): string[] => value.split(/[\\/]+/).filter((part) => part !== "");
  const dirname = (value: string) => {
    const drive = driveOf(value);
    const parts = partsOf(value);
    if (parts.length === 0) {
      return ".";
    }
    if (parts.length === 1) {
      return drive ? `${drive}${sep}` : ".";
    }
    const rest = parts.slice(0, -1).join(sep);
    return drive ? `${drive}${sep}${rest}` : rest;
  };
  const basename = (value: string) => partsOf(value).pop() ?? "";
  const extname = (value: string) => {
    const base = basename(value);
    const index = base.lastIndexOf(".");
    return index > 0 ? base.slice(index) : "";
  };
  const normalize = (value: string) => {
    const drive = driveOf(value);
    const absolute = isAbsolute(value);
    if (drive && value.length === 2) {
      return `${drive}${sep}`;
    }
    const parts = value
      .slice(drive ? 2 : 0)
      .split(/[\\/]+/)
      .filter((part) => part !== "" && part !== ".");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "..") {
        if (stack.length > 0 && stack[stack.length - 1] !== "..") {
          stack.pop();
        } else if (!absolute) {
          stack.push("..");
        }
      } else {
        stack.push(part);
      }
    }
    if (stack.length === 0) {
      if (drive) {
        return `${drive}${sep}`;
      }
      return absolute ? sep : ".";
    }
    const rest = stack.join(sep);
    if (drive) {
      return `${drive}${sep}${rest}`;
    }
    return absolute ? `${sep}${rest}` : rest;
  };
  const resolve = (value: string) => {
    const drive = driveOf(value);
    if (drive) {
      return normalize(value);
    }
    return normalize(`${sep}${value}`);
  };
  const join = (...parts: string[]) =>
    normalize(
      parts
        .filter((part) => part !== "")
        .map((part) => part.replace(/[\\/]+/g, sep))
        .join(sep)
    );
  return { sep, join, normalize, resolve, dirname, basename, extname, isAbsolute };
}