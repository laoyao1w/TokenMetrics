import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listFilesRecursively } from "../src/collectors/shared/path-helpers.js";

describe("listFilesRecursively", () => {
  it("skips excluded directories before descending into them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "path-helpers-"));
    const keptDir = path.join(root, "kept");
    const skippedDir = path.join(root, "logs");

    await mkdir(keptDir, { recursive: true });
    await mkdir(path.join(skippedDir, "nested"), { recursive: true });
    await writeFile(path.join(keptDir, "history.json"), "{}");
    await writeFile(path.join(skippedDir, "nested", "huge.log"), "{}");

    const files = await listFilesRecursively(root, 4, {
      shouldSkip(candidate) {
        return candidate.toLowerCase().includes(`${path.sep}logs`);
      }
    });

    expect(files).toEqual([path.join(keptDir, "history.json")]);
  });
});
