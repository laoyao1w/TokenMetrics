import type { Collector } from "../types.js";
import { collectFromFilesystem } from "../shared/filesystem-collector.js";
import { getHost } from "../../host/types.js";

export class CodexCollector implements Collector {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex";

  async collect() {
    return collectFromFilesystem({
      id: this.id,
      displayName: this.displayName,
      evidenceTypes: ["local-log", "local-database"],
      warningWhenEmpty: "OpenAI Codex local data directory was not found.",
      maxDepth: 5,
      candidateRoots(environment) {
        const path = getHost().path;
        const roots = [
          path.join(environment.homeDir, ".codex"),
          path.join(environment.homeDir, ".config", "codex"),
          path.join(environment.homeDir, ".config", "Codex")
        ];

        if (environment.appData) {
          roots.push(path.join(environment.appData, "Codex"));
          roots.push(path.join(environment.appData, "OpenAI Codex"));
        }

        if (environment.localAppData) {
          roots.push(path.join(environment.localAppData, "Codex"));
          roots.push(path.join(environment.localAppData, "OpenAI", "Codex"));
        }

        return roots;
      },
      extraFilter(filePath) {
        const lower = filePath.toLowerCase();
        return lower.includes("history") || lower.includes("response") || lower.includes("session") || lower.includes("log");
      }
    });
  }
}
