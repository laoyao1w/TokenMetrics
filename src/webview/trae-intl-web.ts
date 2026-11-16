import type { CollectorBatch, CollectorStatus, CoverageWindow } from "../core/types.js";
import { getHost } from "../host/types.js";
import { deduplicateRecords } from "../core/deduplication.js";
import {
  buildTraeIntlRecords,
  queryHistoryUsage,
  queryProjectUsage
} from "../collectors/trae-intl/schema.js";
import type { TraeIntlHistoryRow, TraeIntlUsageRow } from "../collectors/trae-intl/schema.js";

/**
 * WebView 版 Trae 国际版采集：
 * 数据库路径探测 + Rust read_trae_snapshot（SQLCipher 解密 + WAL 合并）→
 * sql.js 查询明文快照 → schema.ts 纯逻辑组装记录。
 * wa-sqlite 与 node 版 db.ts 不再参与桌面端路径。
 */

async function resolveTraeIntlDbPathsWeb(): Promise<string[]> {
  const host = getHost();
  const [explicit, userProfile, appData, home, customHome] = await Promise.all([
    host.env("TRAE_INTL_DB"),
    host.env("USERPROFILE"),
    host.env("APPDATA"),
    host.env("HOME"),
    host.env("TRAE_INTL_HOME")
  ]);

  if (explicit) {
    return [explicit.trim()];
  }

  const homeDir = userProfile ?? home ?? "";
  const parent =
    host.platform === "win32"
      ? appData || host.path.join(homeDir, "AppData", "Roaming")
      : host.platform === "darwin"
        ? host.path.join(homeDir, "Library", "Application Support")
        : await host.env("XDG_CONFIG_HOME") || host.path.join(homeDir, ".config");

  const roots = customHome
    ? [customHome.trim()]
    : [host.path.join(parent, "Trae"), host.path.join(parent, "TRAE SOLO")];
  const result: string[] = [];

  for (const root of roots) {
    for (const moduleName of ["ai-agent", "ai-chat"]) {
      const candidate = host.path.join(root, "ModularData", moduleName, "database.db");
      if (await host.exists(candidate)) {
        result.push(candidate);
        break;
      }
    }
  }

  return [...new Set(result)];
}

function queryRows(db: { exec(sql: string): Array<{ columns: string[]; values: unknown[][] }> }) {
  return async (sql: string): Promise<Array<Record<string, unknown>>> => {
    const rows: Array<Record<string, unknown>> = [];
    for (const dataset of db.exec(sql)) {
      for (const values of dataset.values) {
        rows.push(Object.fromEntries(dataset.columns.map((column, index) => [column, values[index]])));
      }
    }
    return rows;
  };
}

async function readTraeIntlRows(databasePath: string): Promise<{
  historyRows: TraeIntlHistoryRow[];
  usageRows: TraeIntlUsageRow[];
}> {
  const host = getHost();
  if (!host.readTraeSnapshot) {
    throw new Error("当前宿主不支持读取 Trae 加密快照。");
  }
  const plainBytes = await host.readTraeSnapshot(databasePath, undefined);
  const db = await host.openSqliteDb(plainBytes);
  try {
    const query = queryRows(db);
    const historyRows = await queryHistoryUsage(query);
    if (historyRows.length > 0) {
      return { historyRows, usageRows: [] };
    }
    const usageRows = await queryProjectUsage(query);
    return { historyRows, usageRows };
  } finally {
    db.close();
  }
}

export async function collectTraeIntlWeb(): Promise<CollectorBatch> {
  const detectedRoots = await resolveTraeIntlDbPathsWeb();

  if (detectedRoots.length === 0) {
    const status: CollectorStatus = {
      id: "trae-intl",
      displayName: "TRAE International",
      availability: "unavailable",
      accuracy: "none",
      detectedRoots: [],
      evidenceTypes: ["local-database"],
      warnings: ["TRAE international local database was not found."],
      notes: [
        "This collector targets Trae international / Trae Solo SQLCipher databases rather than CN log snapshots."
      ]
    };

    const coverage: CoverageWindow = {
      fileCount: 0,
      matchedFileCount: 0,
      matchedRecordCount: 0,
      notes: ["No Trae international database was detected."]
    };

    return { records: [], status, coverage };
  }

  const allRecords = [];
  const notes = new Set<string>();
  const warnings: string[] = [];
  const matchedFiles = new Set<string>();

  for (const databasePath of detectedRoots) {
    try {
      const { historyRows, usageRows } = await readTraeIntlRows(databasePath);
      const result = await buildTraeIntlRecords({ databasePath, historyRows, usageRows });
      if (result.records.length > 0) {
        matchedFiles.add(databasePath);
        allRecords.push(...result.records);
      }
      for (const note of result.notes) {
        notes.add(note);
      }
    } catch (error) {
      warnings.push(`${databasePath}: ${(error as Error).message}`);
    }
  }

  const records = deduplicateRecords(allRecords);
  const timestamps = records.map((record) => record.timestamp).sort((a, b) => a - b);

  const status: CollectorStatus = {
    id: "trae-intl",
    displayName: "TRAE International",
    availability: records.length > 0 ? "ready" : "partial",
    accuracy: records.some((record) => record.accuracy === "exact")
      ? "exact"
      : records.length > 0
        ? "estimated"
        : "none",
    detectedRoots,
    evidenceTypes: ["local-database"],
    warnings:
      warnings.length > 0
        ? warnings
        : records.length > 0
          ? []
          : ["Trae international databases were found, but no usable token_usage rows were parsed."],
    notes: [
      "The collector decrypts Trae SQLCipher pages in memory and never writes a decrypted database to disk.",
      ...notes
    ]
  };

  const coverage: CoverageWindow = {
    earliestTimestamp: timestamps[0],
    latestTimestamp: timestamps[timestamps.length - 1],
    fileCount: detectedRoots.length,
    matchedFileCount: matchedFiles.size,
    matchedRecordCount: records.length,
    notes:
      records.length > 0
        ? [
            "Records come from per-request history_v2 messages in Trae international local databases; chat_turn token_usage is used as a fallback when history_v2 has no usable rows."
          ]
        : ["Trae international databases were readable, but no valid token_usage payloads were found."]
  };

  return { records, status, coverage };
}