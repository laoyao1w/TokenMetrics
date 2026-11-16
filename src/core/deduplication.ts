import { sha256 } from "./hash.js";
import type { TokenUsageRecord } from "./types.js";

function dedupKey(record: TokenUsageRecord): string {
  if (record.requestId) {
    return `${record.source}:${record.requestId}`;
  }

  return sha256(
    [
      record.source,
      record.model,
      record.sessionId ?? "",
      String(record.timestamp),
      String(record.inputTokens),
      String(record.outputTokens),
      String(record.cacheReadTokens),
      String(record.cacheWriteTokens),
      String(record.reasoningTokens),
      String(record.totalTokens)
    ].join("|")
  );
}

export function deduplicateRecords(records: TokenUsageRecord[]): TokenUsageRecord[] {
  const seen = new Map<string, TokenUsageRecord>();

  for (const record of records) {
    const key = dedupKey(record);
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, record);
      continue;
    }

    if (existing.accuracy === "estimated" && record.accuracy === "exact") {
      seen.set(key, record);
      continue;
    }

    if (existing.evidenceSource.length < record.evidenceSource.length) {
      seen.set(key, record);
    }
  }

  return [...seen.values()].sort((left, right) => left.timestamp - right.timestamp);
}
