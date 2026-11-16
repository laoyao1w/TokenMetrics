import { deduplicateRecords } from "../../core/deduplication.js";
import { sha256 } from "../../core/hash.js";
import { getHost } from "../../host/types.js";
import type { FsStat } from "../../host/types.js";
import type { Accuracy, TokenUsageRecord } from "../../core/types.js";

const TOKEN_KEYS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens"
];
const TOKEN_KEY_HINTS = TOKEN_KEYS.map((key) => `"${key}"`);
const FAST_TEXT_SCAN_THRESHOLD = 128 * 1024;

type UnknownRecord = Record<string, unknown>;

function metadataScore(record: TokenUsageRecord): number {
  let score = 0;
  if (record.requestId) {
    score += 4;
  }
  if (record.sessionId) {
    score += 2;
  }
  if (record.model !== "unknown") {
    score += 2;
  }
  if (record.accuracy === "exact") {
    score += 1;
  }
  return score;
}

function collapseSimilarRecords(records: TokenUsageRecord[]): TokenUsageRecord[] {
  const groups = new Map<string, TokenUsageRecord>();

  for (const record of records) {
    const bucket = [
      record.source,
      record.evidenceSource,
      String(record.timestamp),
      String(record.inputTokens),
      String(record.outputTokens),
      String(record.cacheReadTokens),
      String(record.cacheWriteTokens),
      String(record.reasoningTokens),
      String(record.totalTokens)
    ].join("|");
    const current = groups.get(bucket);

    if (!current || metadataScore(record) > metadataScore(current)) {
      groups.set(bucket, record);
    }
  }

  return [...groups.values()];
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asObject(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function getNestedNumber(record: UnknownRecord | undefined, pathParts: string[]): number | undefined {
  let current: unknown = record;

  for (const part of pathParts) {
    const objectValue = asObject(current);
    if (!objectValue) {
      return undefined;
    }
    current = objectValue[part];
  }

  return asNumber(current);
}

function getNestedString(record: UnknownRecord | undefined, pathParts: string[]): string | undefined {
  let current: unknown = record;

  for (const part of pathParts) {
    const objectValue = asObject(current);
    if (!objectValue) {
      return undefined;
    }
    current = objectValue[part];
  }

  return asString(current);
}

function findObjectBounds(text: string, keyIndex: number): Array<[number, number]> {
  const candidateStarts: number[] = [];
  for (let index = keyIndex; index >= 0 && index >= keyIndex - 6000; index -= 1) {
    if (text[index] === "{") {
      candidateStarts.push(index);
    }
  }

  const bounds: Array<[number, number]> = [];

  for (const start of candidateStarts) {
    let inString = false;
    let escaping = false;
    let depth = 0;

    for (let index = start; index < text.length && index <= start + 10000; index += 1) {
      const char = text[index];

      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0 && index >= keyIndex) {
          bounds.push([start, index + 1]);
          break;
        }
      }
    }
  }

  return bounds;
}

function extractJsonObjects(text: string): string[] {
  const matches = new Set<string>();
  const keyRegex = new RegExp(`"(?:${TOKEN_KEYS.join("|")})"\\s*:`, "g");

  for (const match of text.matchAll(keyRegex)) {
    if (match.index === undefined) {
      continue;
    }

    const bounds = findObjectBounds(text, match.index);
    if (bounds.length === 0) {
      continue;
    }

    const candidates = bounds
      .map(([start, end]) => text.slice(start, end))
      .sort((left, right) => right.length - left.length);

    for (const candidate of candidates) {
      try {
        JSON.parse(candidate);
        matches.add(candidate);
        break;
      } catch {
        // Fall back to the next candidate.
      }
    }
  }

  return [...matches];
}

function detectAccuracy(filePath: string): Accuracy {
  const normalized = filePath.toLowerCase();
  const sep = getHost().path.sep;

  if (
    normalized.includes("log") ||
    normalized.includes("history") ||
    normalized.includes("db") ||
    normalized.includes("cache_data") ||
    normalized.includes(`${sep}network${sep}`) ||
    normalized.includes(`${sep}cef${sep}`)
  ) {
    return "exact";
  }

  return "estimated";
}

function buildRecord(
  payload: UnknownRecord,
  source: string,
  evidenceSource: string,
  fallbackTimestamp?: number
): TokenUsageRecord | undefined {
  const usage =
    asObject(payload.usage) ??
    asObject(payload.token_usage) ??
    asObject(payload.metrics) ??
    payload;

  const inputTokens =
    asNumber(usage.prompt_tokens) ??
    asNumber(usage.input_tokens) ??
    getNestedNumber(usage, ["input_tokens_details", "text_tokens"]) ??
    0;
  const outputTokens =
    asNumber(usage.completion_tokens) ??
    asNumber(usage.output_tokens) ??
    getNestedNumber(usage, ["output_tokens_details", "text_tokens"]) ??
    0;
  const cacheReadTokens =
    asNumber(usage.cache_read_tokens) ??
    getNestedNumber(usage, ["input_tokens_details", "cached_tokens"]) ??
    0;
  const cacheWriteTokens = asNumber(usage.cache_write_tokens) ?? 0;
  const reasoningTokens =
    asNumber(usage.reasoning_tokens) ??
    getNestedNumber(usage, ["output_tokens_details", "reasoning_tokens"]) ??
    0;

  const explicitTotal =
    asNumber(usage.total_tokens) ??
    getNestedNumber(usage, ["token_counts", "total_tokens"]);
  const totalTokens = explicitTotal ?? inputTokens + outputTokens;

  if (totalTokens <= 0) {
    return undefined;
  }

  const model =
    asString(payload.model) ??
    asString(payload.model_name) ??
    getNestedString(payload, ["response", "model"]) ??
    "unknown";
  const requestId =
    asString(payload.request_id) ??
    asString(payload.requestId) ??
    asString(payload.id) ??
    getNestedString(payload, ["response", "id"]);
  const sessionId =
    asString(payload.session_id) ??
    asString(payload.sessionId) ??
    asString(payload.conversation_id) ??
    asString(payload.conversationId);
  const timestampSeconds =
    asNumber(payload.timestamp) ??
    asNumber(payload.created_at) ??
    asNumber(payload.created) ??
    fallbackTimestamp;
  const timestamp =
    timestampSeconds !== undefined && timestampSeconds < 10_000_000_000
      ? timestampSeconds * 1000
      : timestampSeconds ?? Date.now();

  const id = sha256(
    [
      source,
      requestId ?? "",
      sessionId ?? "",
      model,
      String(timestamp),
      String(totalTokens),
      evidenceSource
    ].join("|")
  );

  return {
    id,
    source,
    model,
    sessionId,
    requestId,
    timestamp,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    accuracy: detectAccuracy(evidenceSource),
    evidenceSource
  };
}

function extractUsageRecordsFromText(
  rawText: string,
  source: string,
  evidenceSource: string,
  fallbackTimestamp?: number
): TokenUsageRecord[] {
  if (!TOKEN_KEY_HINTS.some((hint) => rawText.includes(hint))) {
    return [];
  }

  const parsedRecords: TokenUsageRecord[] = [];

  for (const rawObject of extractJsonObjects(rawText)) {
    try {
      const payload = JSON.parse(rawObject) as UnknownRecord;
      const record = buildRecord(payload, source, evidenceSource, fallbackTimestamp);
      if (record) {
        parsedRecords.push(record);
      }
    } catch {
      // Ignore malformed fragments.
    }
  }

  return deduplicateRecords(collapseSimilarRecords(parsedRecords));
}

async function extractUsageRecordsFromSqliteDatabase(filePath: string, source: string): Promise<TokenUsageRecord[]> {
  try {
    const host = getHost();
    const [databaseBytes, fallbackTimestamp] = await Promise.all([
      host.readFile(filePath),
      fileTimestamp(filePath)
    ]);
    const db = await host.openSqliteDb(databaseBytes);
    const records: TokenUsageRecord[] = [];
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");

    if (tables.length === 0) {
      db.close();
      return [];
    }

    const tableNames = ((tables[0]?.values ?? []) as unknown[][]).map((row: unknown[]) => String(row[0]));

    for (const tableName of tableNames) {
      if (tableName.startsWith("sqlite_")) {
        continue;
      }

      const escapedTableName = tableName.replaceAll("\"", "\"\"");
      const result = db.exec(`SELECT * FROM "${escapedTableName}" LIMIT 200`);

      for (const dataset of result) {
        for (const row of dataset.values as unknown[][]) {
          const payload = Object.fromEntries(
            dataset.columns.map((column: string, index: number) => [column, row[index]])
          );
          const directRecord = buildRecord(payload, source, `${filePath}#${tableName}`, fallbackTimestamp);
          if (directRecord) {
            records.push(directRecord);
          }

          for (const value of row) {
            if (typeof value !== "string") {
              continue;
            }

            if (!TOKEN_KEYS.some((key) => value.includes(key))) {
              continue;
            }

            records.push(...extractUsageRecordsFromText(value, source, `${filePath}#${tableName}`, fallbackTimestamp));
          }
        }
      }
    }

    db.close();
    return deduplicateRecords(records);
  } catch {
    return [];
  }
}

/** 文本类证据文件最大读取上限：避免把数百 MB 的浏览缓存/大日志读进来做正则扫描。 */
const MAX_TEXT_EVIDENCE_BYTES = 32 * 1024 * 1024;
const textDecoder = new TextDecoder();

export async function extractUsageRecordsFromFile(filePath: string, source: string): Promise<TokenUsageRecord[]> {
  const host = getHost();
  if ([".db", ".sqlite"].includes(host.path.extname(filePath.toLowerCase()))) {
    return extractUsageRecordsFromSqliteDatabase(filePath, source);
  }

  let stat: FsStat;
  try {
    stat = await host.stat(filePath);
  } catch {
    return [];
  }
  if (stat.size > MAX_TEXT_EVIDENCE_BYTES) {
    return [];
  }

  if (
    stat.size >= FAST_TEXT_SCAN_THRESHOLD &&
    host.fileContainsAny &&
    !(await host.fileContainsAny(filePath, TOKEN_KEY_HINTS, MAX_TEXT_EVIDENCE_BYTES))
  ) {
    return [];
  }

  let rawText: string;

  try {
    rawText = textDecoder.decode(await host.readFile(filePath));
  } catch {
    return [];
  }

  const fallbackTimestamp = await fileTimestamp(filePath, stat);
  return extractUsageRecordsFromText(rawText, source, filePath, fallbackTimestamp);
}

async function fileTimestamp(filePath: string, statHint?: FsStat): Promise<number | undefined> {
  if (statHint) {
    return statHint.mtimeMs;
  }

  try {
    const stat = await getHost().stat(filePath);
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

export function looksLikeUsageFile(filePath: string): boolean {
  const host = getHost();
  const lower = filePath.toLowerCase();
  const ext = host.path.extname(lower);
  const sep = host.path.sep;
  const interestingExtension = [".log", ".json", ".jsonl", ".db", ".sqlite"].includes(ext);
  const interestingName =
    lower.includes("history") ||
    lower.includes("renderer") ||
    lower.includes("assistant") ||
    lower.includes("usage") ||
    lower.includes("chat") ||
    lower.includes("agent") ||
    lower.includes("session") ||
    lower.includes("cache_data") ||
    lower.includes(`${sep}log${sep}`) ||
    lower.includes(`${sep}logs${sep}`) ||
    lower.includes(`${sep}cef${sep}`);

  return interestingExtension && interestingName;
}
