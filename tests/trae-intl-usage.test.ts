import { describe, expect, it } from "vitest";
import { normalizeTraeModel, normalizeTraeUsage, traeTimestamp } from "../src/collectors/trae-intl/usage.js";

describe("Trae international usage normalization", () => {
  it("normalizes direct prompt and completion counters", () => {
    const usage = normalizeTraeUsage({
      prompt_tokens: 120,
      completion_tokens: 40,
      total_tokens: 160,
      cache_read_input_tokens: 10,
      reasoning_tokens: 5
    });

    expect(usage).toEqual({
      input_tokens: 110,
      cached_input_tokens: 10,
      cache_creation_input_tokens: 0,
      output_tokens: 35,
      reasoning_output_tokens: 5,
      total_tokens: 160
    });
  });

  it("keeps whole-turn prompt overflow as unpriced input", () => {
    const usage = normalizeTraeUsage(
      {
        prompt_tokens: 200,
        prompt_tokens_total: 500,
        completion_tokens: 50,
        completion_tokens_total: 80,
        total_tokens: 250,
        cache_read_input_tokens: 20
      },
      { model: "gpt-5.4" }
    );

    expect(usage).toMatchObject({
      input_tokens: 180,
      cached_input_tokens: 20,
      output_tokens: 80,
      total_tokens: 580,
      unpriced_input_tokens: 300
    });
  });

  it("normalizes Trae model aliases and timestamps", () => {
    expect(normalizeTraeModel("Claude-4 Sonnet")).toBe("claude-sonnet-4-20250514");
    expect(normalizeTraeModel("GPT-5.4__default")).toBe("gpt-5.4");
    expect(traeTimestamp(1_794_305_474)).toBe(1_794_305_474_000);
  });
});
