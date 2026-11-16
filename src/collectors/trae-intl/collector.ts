import { deduplicateRecords } from "../../core/deduplication.js";
import type { CollectorBatch, CollectorStatus, CoverageWindow } from "../../core/types.js";
import type { Collector } from "../types.js";
import { collectTraeIntlRecords, resolveTraeIntlDbPaths } from "./db.js";

export class TraeIntlCollector implements Collector {
  readonly id = "trae-intl";
  readonly displayName = "TRAE International";

  async collect() {
    const detectedRoots = resolveTraeIntlDbPaths();

    if (detectedRoots.length === 0) {
      const status: CollectorStatus = {
        id: this.id,
        displayName: this.displayName,
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
        const result = await collectTraeIntlRecords(databasePath);
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
      id: this.id,
      displayName: this.displayName,
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
}
