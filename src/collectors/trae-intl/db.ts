import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CollectorEnvironment, TokenUsageRecord } from "../../core/types.js";
import {
  buildTraeIntlRecords,
  queryHistoryUsage,
  queryProjectUsage
} from "./schema.js";
import type { TraeIntlHistoryRow, TraeIntlUsageRow } from "./schema.js";
import { openTraeSnapshot, withTraeIntlSqlite } from "./sqlite.js";

export type { TraeIntlHistoryRow, TraeIntlUsageRow };

export function resolveTraeIntlDbPaths(
  environment?: Partial<CollectorEnvironment>,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const explicit = String(env.TRAE_INTL_DB ?? "").trim();
  if (explicit) {
    return [path.resolve(explicit)];
  }

  const home = environment?.homeDir ?? env.USERPROFILE ?? homedir();
  const customHome = String(env.TRAE_INTL_HOME ?? "").trim();
  const parent =
    process.platform === "win32"
      ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");

  const roots = customHome ? [customHome] : [path.join(parent, "Trae"), path.join(parent, "TRAE SOLO")];
  const result: string[] = [];

  for (const root of roots) {
    for (const moduleName of ["ai-agent", "ai-chat"]) {
      const candidate = path.resolve(root, "ModularData", moduleName, "database.db");
      try {
        if (statSync(candidate).isFile()) {
          result.push(candidate);
          break;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          result.push(candidate);
          break;
        }
      }
    }
  }

  return [...new Set(result)];
}

export async function readTraeIntlUsageRows(databasePath: string): Promise<TraeIntlUsageRow[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let snapshot;
    try {
      snapshot = openTraeSnapshot(databasePath);
    } catch (error) {
      if ((error as { transient?: boolean }).transient && attempt < 2) {
        continue;
      }
      throw error;
    }

    try {
      let result: TraeIntlUsageRow[];
      try {
        result = await withTraeIntlSqlite(snapshot, queryProjectUsage);
      } catch (error) {
        if (snapshot.isStable()) {
          throw error;
        }
        continue;
      }

      if (snapshot.isStable()) {
        return result;
      }
    } finally {
      snapshot.close();
    }
  }

  throw new Error("database changed during the read; retry after Trae finishes its current turn.");
}

export async function readTraeIntlHistoryRows(databasePath: string): Promise<TraeIntlHistoryRow[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let snapshot;
    try {
      snapshot = openTraeSnapshot(databasePath);
    } catch (error) {
      if ((error as { transient?: boolean }).transient && attempt < 2) {
        continue;
      }
      throw error;
    }

    try {
      let result: TraeIntlHistoryRow[];
      try {
        result = await withTraeIntlSqlite(snapshot, queryHistoryUsage);
      } catch (error) {
        if (snapshot.isStable()) {
          throw error;
        }
        continue;
      }

      if (snapshot.isStable()) {
        return result;
      }
    } finally {
      snapshot.close();
    }
  }

  throw new Error("database changed during the read; retry after Trae finishes its current turn.");
}

export async function collectTraeIntlRecords(
  databasePath: string
): Promise<{ records: TokenUsageRecord[]; notes: string[] }> {
  // 主数据源：history_v2 中每次 LLM 请求（content_source = 'llm_default'）。
  // compress_token_usage 是 Trae 客户端记录的该次请求完整 total_tokens，
  // 覆盖 agent 循环内每一次重发上下文的请求，比 chat_turn 只记最后一次请求完整得多。
  const historyRows = await readTraeIntlHistoryRows(databasePath);

  let usageRows: TraeIntlUsageRow[] = [];
  if (historyRows.length === 0) {
    // 兜底数据源：旧版 schema（无 history_v2 或无用例时），退回 chat_turn.token_usage。
    usageRows = await readTraeIntlUsageRows(databasePath);
  }

  return buildTraeIntlRecords({ databasePath, historyRows, usageRows });
}