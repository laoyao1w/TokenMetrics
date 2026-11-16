import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { extractUsageRecordsFromFile } from "../src/collectors/shared/generic-usage-parser.js";

describe("extractUsageRecordsFromFile", () => {
  it("parses nested usage objects with cache and reasoning fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usage-parser-"));
    const filePath = path.join(directory, "renderer.log");

    await writeFile(
      filePath,
      [
        "2026-11-10T09:00:00.000Z [info] response payload",
        JSON.stringify({
          id: "resp-123",
          request_id: "req-123",
          session_id: "sess-1",
          model: "claude-sonnet-4",
          timestamp: 1_794_297_600,
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 340,
            total_tokens: 1540,
            input_tokens_details: {
              cached_tokens: 800,
              text_tokens: 1200
            },
            output_tokens_details: {
              reasoning_tokens: 44,
              text_tokens: 340
            }
          }
        })
      ].join("\n"),
      "utf8"
    );

    const records = await extractUsageRecordsFromFile(filePath, "claude");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "claude",
      requestId: "req-123",
      sessionId: "sess-1",
      model: "claude-sonnet-4",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
      reasoningTokens: 44,
      totalTokens: 1540,
      accuracy: "exact"
    });
  });

  it("ignores payloads without explicit usage totals", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usage-parser-empty-"));
    const filePath = path.join(directory, "assistant.json");

    await writeFile(
      filePath,
      JSON.stringify({
        id: "resp-0",
        model: "unknown",
        body: {
          text: "hello"
        }
      }),
      "utf8"
    );

    const records = await extractUsageRecordsFromFile(filePath, "workbuddy");

    expect(records).toHaveLength(0);
  });

  it("extracts usage payloads from SQLite rows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "usage-parser-sqlite-"));
    const filePath = path.join(directory, "collector.db");
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    db.run("CREATE TABLE responses (id TEXT, payload TEXT)");
    db.run(
      "INSERT INTO responses VALUES (?, ?)",
      [
        "row-1",
        JSON.stringify({
          request_id: "req-db-1",
          session_id: "sess-db-1",
          model: "gpt-5",
          timestamp: 1_794_297_600,
          usage: {
            prompt_tokens: 256,
            completion_tokens: 128,
            total_tokens: 384
          }
        })
      ]
    );

    await writeFile(filePath, Buffer.from(db.export()));
    db.close();

    const records = await extractUsageRecordsFromFile(filePath, "codex");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "codex",
      requestId: "req-db-1",
      sessionId: "sess-db-1",
      model: "gpt-5",
      inputTokens: 256,
      outputTokens: 128,
      totalTokens: 384
    });
  });
});
