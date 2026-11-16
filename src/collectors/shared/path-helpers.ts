import type { CollectorEnvironment } from "../../core/types.js";
import { getHost } from "../../host/types.js";

export async function getEnvironment(
  overrides?: Partial<CollectorEnvironment>
): Promise<CollectorEnvironment> {
  const host = getHost();
  const [userProfile, appData, localAppData, home] = await Promise.all([
    host.env("USERPROFILE"),
    host.env("APPDATA"),
    host.env("LOCALAPPDATA"),
    host.env("HOME")
  ]);

  return {
    homeDir: overrides?.homeDir ?? userProfile ?? home ?? "",
    appData: overrides?.appData ?? appData,
    localAppData: overrides?.localAppData ?? localAppData
  };
}

export async function existingDirectories(paths: string[]): Promise<string[]> {
  const host = getHost();
  const uniqueCandidates = [...new Set(paths)];
  const checks = await Promise.all(
    uniqueCandidates.map(async (candidate) => ({
      candidate,
      exists: await host.exists(candidate)
    }))
  );
  return checks.filter((item) => item.exists).map((item) => item.candidate);
}

export interface ListFilesOptions {
  shouldSkip?(path: string): boolean;
  skipSubstrings?: string[];
}

export async function listFilesRecursively(
  root: string,
  maxDepth = 4,
  options?: ListFilesOptions
): Promise<string[]> {
  const host = getHost();
  const output: string[] = [];
  const shouldSkip = options?.shouldSkip;

  if (host.walkFiles) {
    const files = await host.walkFiles(root, maxDepth, options?.skipSubstrings);
    return shouldSkip ? files.filter((filePath) => !shouldSkip(filePath)) : files;
  }

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    if (shouldSkip?.(currentPath)) {
      return;
    }

    let entries;
    try {
      entries = await host.readDir(currentPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      const nextPath = host.path.join(currentPath, entry.name);
      if (entry.isDir) {
        await walk(nextPath, depth + 1);
      } else if (entry.isFile) {
        if (shouldSkip?.(nextPath)) {
          continue;
        }
        output.push(nextPath);
      }
    }
  }

  await walk(root, 0);
  return output;
}
