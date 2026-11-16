import type { TokenUsageRecord } from "./types.js";

export interface UsageSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  todayTokens: number;
  weekTokens: number;
  requestCount: number;
  activeDays: number;
  spanDays: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
  sources: Record<string, number>;
  models: Record<string, number>;
  levels: {
    high: number;
    medium: number;
    low: number;
  };
}

function getModelLevel(model: string): "high" | "medium" | "low" {
  const m = model.toLowerCase();

  const isGcg = m.includes("gpt") || m.includes("claude") || m.includes("gemini");
  const isFlagshipKeywords = m.includes("4") || m.includes("5") || m.includes("sonnet") || m.includes("opus") || m.includes("pro") || m.includes("o1") || m.includes("o3");
  const isNonFlagshipKeywords = m.includes("mini") || m.includes("flash") || m.includes("haiku") || m.includes("3.5");

  if (isGcg && isFlagshipKeywords && !isNonFlagshipKeywords) {
    return "high";
  }

  const isDkg = m.includes("deepseek") || m.includes("kimi") || m.includes("glm");
  const isFlagshipDkg = (m.includes("deepseek") && (m.includes("v3") || m.includes("v4") || m.includes("chat") || m.includes("reasoner"))) ||
                        (m.includes("kimi")) ||
                        (m.includes("glm") && (m.includes("4") || m.includes("pro")));

  if (isGcg || isFlagshipDkg) {
    return "medium";
  }

  return "low";
}

function toLocalDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function summarizeUsage(records: TokenUsageRecord[]): UsageSummary {
  const days = new Set<string>();
  const sources: Record<string, number> = {};
  const models: Record<string, number> = {};
  const timestamps: number[] = [];

  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let todayTokens = 0;
  let weekTokens = 0;
  const levels = { high: 0, medium: 0, low: 0 };

  const now = new Date();
  const todayKey = toLocalDay(now.getTime());
  const weekStartTs = now.getTime() - 7 * 86_400_000;

  for (const record of records) {
    totalTokens += record.totalTokens;
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    cacheReadTokens += record.cacheReadTokens;
    cacheWriteTokens += record.cacheWriteTokens;
    reasoningTokens += record.reasoningTokens;
    timestamps.push(record.timestamp);

    const dayKey = toLocalDay(record.timestamp);
    days.add(dayKey);
    if (dayKey === todayKey) todayTokens += record.totalTokens;
    if (record.timestamp >= weekStartTs) weekTokens += record.totalTokens;

    sources[record.source] = (sources[record.source] ?? 0) + record.totalTokens;
    models[record.model] = (models[record.model] ?? 0) + record.totalTokens;
    
    const level = getModelLevel(record.model);
    levels[level] += record.totalTokens;
  }

  timestamps.sort((left, right) => left - right);
  const firstTimestamp = timestamps[0];
  const lastTimestamp = timestamps[timestamps.length - 1];
  const spanDays =
    firstTimestamp !== undefined && lastTimestamp !== undefined
      ? Math.floor((lastTimestamp - firstTimestamp) / 86_400_000) + 1
      : 0;

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    todayTokens,
    weekTokens,
    requestCount: records.length,
    activeDays: days.size,
    spanDays,
    firstTimestamp,
    lastTimestamp,
    sources,
    models,
    levels
  };
}
