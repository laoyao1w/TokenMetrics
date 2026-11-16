import { describe, expect, it } from "vitest";
import { deduplicateRecords } from "../src/core/deduplication.js";
import type { TokenUsageRecord } from "../src/core/types.js";

function createRecord(overrides: Partial<TokenUsageRecord>): TokenUsageRecord {
  return {
    id: "1",
    source: "trae",
    model: "gpt-4.1",
    timestamp: 1_700_000_000_000,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    accuracy: "estimated",
    evidenceSource: "a.log",
    ...overrides
  };
}

describe("deduplicateRecords", () => {
  it("prefers exact data over estimated data for the same request", () => {
    const estimated = createRecord({ requestId: "req-1", accuracy: "estimated", evidenceSource: "cache.json" });
    const exact = createRecord({ requestId: "req-1", accuracy: "exact", evidenceSource: "renderer.log" });

    const result = deduplicateRecords([estimated, exact]);

    expect(result).toHaveLength(1);
    expect(result[0]?.accuracy).toBe("exact");
    expect(result[0]?.evidenceSource).toBe("renderer.log");
  });
});
