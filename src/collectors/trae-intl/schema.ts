import { sha256 } from "../../core/hash.js";
import type { TokenUsageRecord } from "../../core/types.js";
import {
  normalizeTraeModel,
  normalizeTraeUsage,
  parseTraeHistoryRequest,
  traeTimestamp
} from "./usage.js";
import type { TraeHistoryRequest } from "./usage.js";

export const TOKEN_FIELDS = [
  "prompt_tokens",
  "prompt_tokens_total",
  "input_tokens",
  "completion_tokens",
  "completion_tokens_total",
  "output_tokens",
  "total_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_tokens",
  "reasoning_output_tokens"
];

export interface TraeIntlUsageRow {
  id: string | null;
  session_id: string | null;
  turn_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  model: string;
  usage: Record<string, number> | null;
}

export interface TraeIntlHistoryRow {
  id: string | null;
  session_id: string | null;
  message_id: string | null;
  agent_run_id: string | null;
  created_at: unknown;
  total_tokens: number;
  messages_json: string;
}

export type QueryRows = (sql: string) => Promise<Array<Record<string, unknown>>>;

/**
 * 读取 chat_turn 表中 token_usage 汇总（旧版 schema 兜底数据源）。
 * 纯 SQL 构造 + 行解析，不依赖任何 Node 能力；queryRows 由调用方注入。
 */
export async function queryProjectUsage(queryRows: QueryRows): Promise<TraeIntlUsageRow[]> {
  const tables = await queryRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turn'");
  if (tables.length === 0) {
    throw new Error("unsupported database schema: chat_turn table is missing.");
  }

  const columns = new Set(
    (await queryRows("PRAGMA table_info(chat_turn)")).map((row) => String(row.name))
  );

  if (!columns.has("context") || (!columns.has("created_at") && !columns.has("updated_at"))) {
    throw new Error("unsupported chat_turn schema.");
  }

  const column = (name: string, fallback = "NULL") => (columns.has(name) ? `"${name}"` : fallback);
  const date =
    columns.has("created_at") && columns.has("updated_at")
      ? 'COALESCE("created_at", "updated_at")'
      : column("created_at", column("updated_at"));
  const modelPaths = [
    "persist_user_message_context.model_info.display_model_name",
    "persist_user_message_context.model_info.model_name",
    "persist_user_message_context.model_info.config_name",
    "model_name",
    "model",
    "agent_model",
    "selected_model.name",
    "selectedModel.name"
  ];
  const model = modelPaths.map(
    (field) => `CASE WHEN json_type(context, '$.${field}') = 'text'
    THEN NULLIF(NULLIF(TRIM(json_extract(context, '$.${field}')), ''), '-') END`
  );
  const fields = TOKEN_FIELDS.map(
    (field) => `CASE
    WHEN json_type(context, '$.token_usage.${field}') IN ('integer', 'real')
    THEN json_extract(context, '$.token_usage.${field}') END AS "${field}"`
  );
  const invalidFields = TOKEN_FIELDS.map(
    (field) => `COALESCE(json_type(context, '$.token_usage.${field}') NOT IN ('integer', 'real', 'null'), 0)`
  );
  const query = `SELECT CAST(${column("id", "rowid")} AS TEXT) AS id,
    ${column("session_id")} AS session_id, ${column("turn_id")} AS turn_id,
    ${date} AS created_at, ${column("updated_at")} AS updated_at,
    COALESCE(${model.join(", ")}, 'trae-unknown') AS model,
    ${fields.join(", ")}, (${invalidFields.join(" OR ")}) AS invalid_usage
    FROM chat_turn WHERE CASE WHEN json_valid(context)
      THEN json_type(context, '$.token_usage') = 'object' ELSE 0 END`;

  return (await queryRows(query)).map((row) => {
    const usage: Record<string, number> = {};
    let invalid = Boolean(row.invalid_usage);

    for (const field of TOKEN_FIELDS) {
      const value = row[field];
      if (value == null) {
        continue;
      }

      if (!Number.isSafeInteger(value) || Number(value) < 0) {
        invalid = true;
      } else {
        usage[field] = Number(value);
      }
    }

    return {
      id: row.id == null ? null : String(row.id),
      session_id: row.session_id == null ? null : String(row.session_id),
      turn_id: row.turn_id == null ? null : String(row.turn_id),
      created_at: row.created_at,
      updated_at: row.updated_at,
      model: String(row.model ?? "trae-unknown"),
      usage: invalid ? null : usage
    };
  });
}

/**
 * 读取 history_v2 表中 content_source='llm_default' 的每次 LLM 请求记录（主数据源）。
 * compress_token_usage 是 Trae 客户端对该次请求记录下的完整 total_tokens；
 * messages 内 raw_messages[0].extra_info 提供模型名与思考链 token（input_token）。
 */
export async function queryHistoryUsage(queryRows: QueryRows): Promise<TraeIntlHistoryRow[]> {
  const tables = await queryRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_v2'");
  if (tables.length === 0) {
    return [];
  }

  const columns = new Set(
    (await queryRows("PRAGMA table_info(history_v2)")).map((row) => String(row.name))
  );

  if (
    !columns.has("compress_token_usage") ||
    !columns.has("messages") ||
    !columns.has("created_at") ||
    !columns.has("content_source")
  ) {
    return [];
  }

  const column = (name: string, fallback = "NULL") => (columns.has(name) ? `"${name}"` : fallback);
  const query = `SELECT CAST(${column("id", "rowid")} AS TEXT) AS id,
    ${column("session_id")} AS session_id, ${column("message_id")} AS message_id,
    ${column("agent_run_id")} AS agent_run_id, ${column("created_at")} AS created_at,
    CAST(${column("compress_token_usage")} AS INTEGER) AS total_tokens,
    ${column("messages")} AS messages_json
    FROM history_v2 WHERE ${column("content_source")} = 'llm_default'
      AND CAST(${column("compress_token_usage")} AS INTEGER) > 0`;

  return (await queryRows(query)).map((row) => ({
    id: row.id == null ? null : String(row.id),
    session_id: row.session_id == null ? null : String(row.session_id),
    message_id: row.message_id == null ? null : String(row.message_id),
    agent_run_id: row.agent_run_id == null ? null : String(row.agent_run_id),
    created_at: row.created_at,
    total_tokens: Number(row.total_tokens) || 0,
    messages_json: row.messages_json == null ? "" : String(row.messages_json)
  }));
}

/**
 * 按 agent_run_id 推断缺失的模型名：同一轮 agent 循环内所有请求共用同一个模型。
 */
export function resolveRunModels(rows: TraeIntlHistoryRow[]): Map<string, string> {
  const runSamples = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (!row.agent_run_id || !row.messages_json) {
      continue;
    }
    let model: string | null = null;
    try {
      model = parseTraeHistoryRequest(row.messages_json)?.model ?? null;
    } catch {
      // ignore malformed rows
    }
    if (!model) {
      continue;
    }
    let counts = runSamples.get(row.agent_run_id);
    if (!counts) {
      counts = new Map<string, number>();
      runSamples.set(row.agent_run_id, counts);
    }
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }

  const resolved = new Map<string, string>();
  for (const [runId, counts] of runSamples) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [model, count] of counts) {
      if (count > bestCount) {
        best = model;
        bestCount = count;
      }
    }
    if (best) {
      resolved.set(runId, best);
    }
  }

  return resolved;
}

/**
 * 将读取到的原始行组装成 TokenUsageRecord 列表（纯逻辑，Node/WebView 通用）。
 * 主数据源为 history_v2；historyRows 为空时退回 chat_turn 的 usageRows。
 */
export async function buildTraeIntlRecords(options: {
  databasePath: string;
  historyRows: TraeIntlHistoryRow[];
  usageRows: TraeIntlUsageRow[];
}): Promise<{ records: TokenUsageRecord[]; notes: string[] }> {
  const { databasePath, historyRows, usageRows } = options;
  const notes = new Set<string>();
  const records: TokenUsageRecord[] = [];

  if (historyRows.length > 0) {
    const runModels = resolveRunModels(historyRows);
    let resolvedModels = 0;
    // history_v2.id 是库内自增小整数，不同数据库文件之间可能重复，
    // 用库路径摘要做前缀，避免 collector 级去重误合并不同库的记录。
    const dbTag = sha256(databasePath).slice(0, 10);

    for (const row of historyRows) {
      if (row.total_tokens <= 0) {
        continue;
      }
      const timestamp = traeTimestamp(row.created_at);
      if (!timestamp) {
        continue;
      }

      let parsed: TraeHistoryRequest | null = null;
      try {
        parsed = parseTraeHistoryRequest(row.messages_json);
      } catch {
        // ignore malformed rows
      }

      let modelName = parsed?.model ?? null;
      if (!modelName && row.agent_run_id) {
        modelName = runModels.get(row.agent_run_id) ?? null;
        if (modelName) {
          resolvedModels += 1;
        }
      }
      const model = normalizeTraeModel(modelName ?? "trae-unknown");

      const total = row.total_tokens;
      const output = parsed?.output_tokens ?? 0;
      const reasoning = parsed?.reasoning_tokens ?? 0;
      const input = Math.max(0, total - output - reasoning);

      const requestId = `${dbTag}:${row.id ?? "0"}`;
      const sessionId = row.session_id ?? undefined;
      const id = sha256([databasePath, requestId ?? "", sessionId ?? "", model, String(timestamp)].join("|"));

      records.push({
        id,
        source: "trae-intl",
        model,
        sessionId,
        requestId,
        timestamp,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: reasoning,
        totalTokens: total,
        accuracy: "estimated",
        evidenceSource: databasePath
      });
    }

    if (resolvedModels > 0) {
      notes.add(`${resolvedModels} requests without model metadata inherited the model used by the rest of their agent run.`);
    }
    notes.add(
      "Per-request totals come from history_v2.compress_token_usage (exact client-recorded total per LLM request, including agent-loop context re-sends); input/output split is estimated from reply text length."
    );

    return { records, notes: [...notes] };
  }

  // 兜底数据源：旧版 schema（无 history_v2 或无用例时），退回 chat_turn.token_usage。
  for (const row of usageRows) {
    if (!row.usage) {
      continue;
    }

    const normalized = normalizeTraeUsage(row.usage, { model: row.model });
    if (!normalized) {
      continue;
    }

    if (normalized.usage_precision === "estimated") {
      notes.add("Some Gemini rows were repaired from incomplete Trae metadata and are marked estimated.");
    }

    if ((normalized.unpriced_input_tokens ?? 0) > 0) {
      notes.add("Whole-turn prompt totals exceeded the final request cache split, so part of prompt cost remains unpriced.");
    }

    const timestamp = traeTimestamp(row.created_at) ?? traeTimestamp(row.updated_at);
    if (!timestamp) {
      continue;
    }

    const requestId = row.turn_id ?? row.id ?? undefined;
    const sessionId = row.session_id ?? undefined;
    const model = normalizeTraeModel(row.model);
    const id = sha256([databasePath, requestId ?? "", sessionId ?? "", model, String(timestamp)].join("|"));

    records.push({
      id,
      source: "trae-intl",
      model,
      sessionId,
      requestId,
      timestamp,
      inputTokens: normalized.input_tokens,
      outputTokens: normalized.output_tokens,
      cacheReadTokens: normalized.cached_input_tokens,
      cacheWriteTokens: normalized.cache_creation_input_tokens,
      reasoningTokens: normalized.reasoning_output_tokens,
      totalTokens: normalized.total_tokens,
      accuracy: normalized.usage_precision === "estimated" ? "estimated" : "exact",
      evidenceSource: databasePath
    });
  }

  return { records, notes: [...notes] };
}