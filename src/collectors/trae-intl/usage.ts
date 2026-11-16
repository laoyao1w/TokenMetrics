const TOKEN_FIELDS = [
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
] as const;

type UsageInput = Record<string, unknown>;

export interface NormalizedTraeUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  unpriced_input_tokens?: number;
  usage_precision?: "estimated";
}

export interface TraeHistoryRequest {
  id: string | null;
  sessionId: string | null;
  messageId: string | null;
  created_at: unknown;
  /** 可能为 null：部分请求行没有 extra_info，需按 agent_run 推断 */
  model: string | null;
  /** 该次请求发送给模型的完整上下文 token 数（含输出），由 Trae 客户端直接记录 */
  total_tokens: number;
  /** 该次请求的思考链 token 数（Trae 记为 input_token），无思考链时为 0 */
  reasoning_tokens: number;
  /** 由助手回复文本估算的输出 token 数 */
  output_tokens: number;
  /** 估算出的输入 token 数（total - output - reasoning） */
  input_tokens: number;
}

/**
 * 解析 history_v2 表中一条 LLM 请求记录（content_source = 'llm_default'）的 messages JSON。
 * raw_messages[0].extra_info 含模型名与思考链 token；raw_messages[0].content 含助手回复文本。
 */
export function parseTraeHistoryRequest(raw: unknown): TraeHistoryRequest | null {
  let payload: UsageInput;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw) as UsageInput;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    payload = raw as UsageInput;
  } else {
    return null;
  }

  const rawMessages = payload.raw_messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return null;
  }

  const first = (rawMessages[0] ?? {}) as Record<string, unknown>;
  const extraInfo = (first.extra_info ?? {}) as Record<string, unknown>;
  const rawModelName = String(extraInfo.model_name ?? extraInfo.model ?? "").trim();
  const modelName = rawModelName && rawModelName !== "-" ? rawModelName : null;
  const reasoning = Number(extraInfo.input_token ?? 0);

  let outputText = "";
  const content = first.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") {
          outputText += text;
        }
      }
    }
  } else if (typeof content === "string") {
    outputText = content;
  }

  // 粗略估算：中英混合文本平均约 2 字符/token
  const outputEstimated = Math.max(1, Math.round(outputText.length / 2));
  const total = Math.max(0, Number(payload.total_tokens ?? 0));
  const reasoningTokens = Number.isSafeInteger(reasoning) && reasoning >= 0 ? reasoning : 0;
  const inputEstimated = Math.max(0, total - outputEstimated - reasoningTokens);

  return {
    id: payload.id == null ? null : String(payload.id),
    sessionId: payload.session_id == null ? null : String(payload.session_id),
    messageId: payload.message_id == null ? null : String(payload.message_id),
    created_at: payload.created_at,
    model: modelName,
    total_tokens: total,
    reasoning_tokens: reasoningTokens,
    output_tokens: outputEstimated,
    input_tokens: inputEstimated
  };
}

export function normalizeTraeModel(value: unknown): string {
  if (typeof value !== "string") {
    return "trae-unknown";
  }

  const model = value.trim().split("__")[0]?.toLowerCase().replace(/\s+/g, "-") ?? "";
  if (model === "claude-4-sonnet") {
    return "claude-sonnet-4-20250514";
  }

  return model && model !== "-" && !model.includes("|") ? model : "trae-unknown";
}

export function traeTimestamp(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }

  let millis: number | undefined;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) {
    const numeric = Number(value);
    millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  } else if (typeof value === "string") {
    millis = Date.parse(value);
  }

  if (!Number.isFinite(millis) || !millis || millis <= 0) {
    return null;
  }

  return millis;
}

export function normalizeTraeUsage(raw: unknown, { model }: { model?: string } = {}): NormalizedTraeUsage | null {
  let usage = raw;
  if (typeof usage === "string") {
    try {
      usage = JSON.parse(usage) as UsageInput;
    } catch {
      return null;
    }
  }

  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }

  for (const field of TOKEN_FIELDS) {
    const value = (usage as UsageInput)[field];
    if (value != null && (!Number.isSafeInteger(value) || Number(value) < 0)) {
      return null;
    }
  }

  for (const [left, right] of [
    ["prompt_tokens", "input_tokens"],
    ["completion_tokens", "output_tokens"],
    ["reasoning_tokens", "reasoning_output_tokens"]
  ] as const) {
    const leftValue = (usage as UsageInput)[left];
    const rightValue = (usage as UsageInput)[right];
    if (leftValue != null && rightValue != null && leftValue !== rightValue) {
      return null;
    }
  }

  if (
    !["prompt_tokens", "prompt_tokens_total", "input_tokens", "completion_tokens", "completion_tokens_total", "output_tokens"]
      .some((field) => (usage as UsageInput)[field] != null)
  ) {
    return null;
  }

  const input = Number((usage as UsageInput).prompt_tokens ?? (usage as UsageInput).input_tokens ?? (usage as UsageInput).prompt_tokens_total ?? 0);
  const output = Number((usage as UsageInput).completion_tokens ?? (usage as UsageInput).output_tokens ?? (usage as UsageInput).completion_tokens_total ?? 0);
  const aggregateInput =
    Number((usage as UsageInput).prompt_tokens_total) > 0 ? Number((usage as UsageInput).prompt_tokens_total) : input;
  const aggregateOutput =
    Number((usage as UsageInput).completion_tokens_total) > 0 ? Number((usage as UsageInput).completion_tokens_total) : output;

  if (aggregateInput < input || aggregateOutput < output) {
    return null;
  }

  const cached = Number((usage as UsageInput).cache_read_input_tokens ?? 0);
  let written = Number((usage as UsageInput).cache_creation_input_tokens ?? 0);
  let reasoning = Number((usage as UsageInput).reasoning_tokens ?? (usage as UsageInput).reasoning_output_tokens ?? 0);
  let estimated = false;
  const isGemini = /^gemini(?:-|$)/i.test(normalizeTraeModel(model ?? String((usage as UsageInput).name ?? "")));

  if (isGemini && cached > 0 && written === cached && cached + written > input) {
    written = 0;
    estimated = true;
  }

  if (
    isGemini &&
    (usage as UsageInput).reasoning_tokens == null &&
    (usage as UsageInput).reasoning_output_tokens == null &&
    Number((usage as UsageInput).total_tokens) > input + output &&
    written === 0 &&
    cached <= input
  ) {
    reasoning = Number((usage as UsageInput).total_tokens) - input - output;
    estimated = true;
  }

  if ((usage as UsageInput).total_tokens == null && (cached || written || reasoning)) {
    return null;
  }

  const total = Number((usage as UsageInput).total_tokens ?? (input + output));
  if (!Number.isSafeInteger(total)) {
    return null;
  }

  const candidates = new Map<string, NormalizedTraeUsage>();
  for (const includedCache of new Set([cached + written, cached, 0])) {
    for (const includedReasoning of new Set([reasoning, 0])) {
      const nonCached = input - includedCache;
      const nonReasoning = output - includedReasoning;
      if (nonCached < 0 || nonReasoning < 0) {
        continue;
      }
      if (nonCached + cached + written + nonReasoning + reasoning !== total) {
        continue;
      }

      const totals: NormalizedTraeUsage = {
        input_tokens: nonCached,
        cached_input_tokens: cached,
        cache_creation_input_tokens: written,
        output_tokens: nonReasoning,
        reasoning_output_tokens: reasoning,
        total_tokens: total
      };
      candidates.set(JSON.stringify(totals), totals);
    }
  }

  if (candidates.size !== 1) {
    return null;
  }

  const totals = candidates.values().next().value as NormalizedTraeUsage;
  if (aggregateInput !== input || aggregateOutput !== output) {
    const unpriced = aggregateInput - input;
    totals.output_tokens += aggregateOutput - output;
    totals.total_tokens += unpriced + aggregateOutput - output;
    if (unpriced > 0) {
      totals.unpriced_input_tokens = unpriced;
    }
  }

  if (Object.values(totals).some((value) => value != null && !Number.isSafeInteger(value))) {
    return null;
  }

  if (estimated) {
    totals.usage_precision = "estimated";
  }

  return totals;
}
