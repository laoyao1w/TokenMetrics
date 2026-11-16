import { deduplicateRecords } from "../../core/deduplication.js";
import type {
  CollectorBatch,
  CollectorEnvironment,
  CollectorStatus,
  CoverageWindow,
  EvidenceLevel
} from "../../core/types.js";
import { existingDirectories, getEnvironment, listFilesRecursively } from "./path-helpers.js";
import { extractUsageRecordsFromFile, looksLikeUsageFile } from "./generic-usage-parser.js";
import { getHost } from "../../host/types.js";

export interface FilesystemCollectorConfig {
  id: string;
  displayName: string;
  evidenceTypes: EvidenceLevel[];
  candidateRoots(environment: CollectorEnvironment): string[];
  warningWhenEmpty: string;
  statusNotes?: string[];
  maxDepth?: number;
  extraFilter?(filePath: string): boolean;
  /** 返回 true 表示该路径应被排除（用于剔除日志/缓存等已知无证据的海量目录）。 */
  excludeFilter?(filePath: string): boolean;
  /** 宿主可直接利用的排除片段，用于在递归阶段提前剪枝。 */
  excludePathSubstrings?: string[];
}

export async function collectFromFilesystem(
  config: FilesystemCollectorConfig,
  overrides?: Partial<CollectorEnvironment>
): Promise<CollectorBatch> {
  const environment = await getEnvironment(overrides);
  const roots = await existingDirectories(config.candidateRoots(environment));

  if (roots.length === 0) {
    const status: CollectorStatus = {
      id: config.id,
      displayName: config.displayName,
      availability: "unavailable",
      accuracy: "none",
      detectedRoots: [],
      evidenceTypes: config.evidenceTypes,
      warnings: [config.warningWhenEmpty],
      notes: config.statusNotes
    };

    const coverage: CoverageWindow = {
      fileCount: 0,
      matchedFileCount: 0,
      matchedRecordCount: 0,
      notes: ["No candidate root directory detected."]
    };

    return { records: [], status, coverage };
  }

  const candidateFiles: string[] = [];

  const rootFileSets = await Promise.all(
    roots.map((root) =>
      listFilesRecursively(root, config.maxDepth ?? 5, {
        shouldSkip: config.excludeFilter,
        skipSubstrings: config.excludePathSubstrings
      })
    )
  );

  for (const files of rootFileSets) {
    candidateFiles.push(
      ...files.filter((filePath) => {
        if (config.excludeFilter && config.excludeFilter(filePath)) {
          return false;
        }

        const passesExtraFilter = config.extraFilter ? config.extraFilter(filePath) : false;
        if (!passesExtraFilter && !looksLikeUsageFile(filePath)) {
          return false;
        }

        return true;
      })
    );
  }

  const allRecords = [];
  const matchedFiles = new Set<string>();

  const MAX_PARSE_CONCURRENCY = 6;

  for (let index = 0; index < candidateFiles.length; index += MAX_PARSE_CONCURRENCY) {
    const chunk = candidateFiles.slice(index, index + MAX_PARSE_CONCURRENCY);
    const parsed = await Promise.all(
      chunk.map(async (filePath) => ({
        filePath,
        records: await extractUsageRecordsFromFile(filePath, config.id)
      }))
    );

    for (const { filePath, records } of parsed) {
      if (records.length > 0) {
        matchedFiles.add(filePath);
        allRecords.push(...records);
      }
    }
  }

  const records = deduplicateRecords(allRecords);
  const timestamps = records.map((record) => record.timestamp).sort((left, right) => left - right);
  const availability = records.length > 0 ? "ready" : "partial";
  const accuracy = records.some((record) => record.accuracy === "exact")
    ? "exact"
    : records.length > 0
      ? "estimated"
      : "none";
  const warnings =
    records.length > 0
      ? []
      : ["Collector root exists, but no explicit token usage payloads were found yet."];

  const status: CollectorStatus = {
    id: config.id,
    displayName: config.displayName,
    availability,
    accuracy,
    detectedRoots: roots.map((root) => getHost().path.normalize(root)),
    evidenceTypes: config.evidenceTypes,
    warnings,
    notes: config.statusNotes
  };

  const coverage: CoverageWindow = {
    earliestTimestamp: timestamps[0],
    latestTimestamp: timestamps[timestamps.length - 1],
    fileCount: candidateFiles.length,
    matchedFileCount: matchedFiles.size,
    matchedRecordCount: records.length,
    notes:
      records.length > 0
        ? ["Records are derived only from explicit usage payloads found in local files."]
        : ["The collector refuses to infer tokens from context windows or chat length."]
  };

  return { records, status, coverage };
}
