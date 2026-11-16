import type { Collector } from "../types.js";
import { collectFromFilesystem } from "../shared/filesystem-collector.js";
import { getHost } from "../../host/types.js";

export class ClaudeCollector implements Collector {
  readonly id = "claude";
  readonly displayName = "Claude Code";

  async collect() {
    return collectFromFilesystem({
      id: this.id,
      displayName: this.displayName,
      evidenceTypes: ["local-log", "local-database"],
      warningWhenEmpty: "Claude Code local data directory was not found.",
      maxDepth: 5,
      candidateRoots(environment) {
        const path = getHost().path;
        const roots = [
          path.join(environment.homeDir, ".claude"),
          path.join(environment.homeDir, ".config", "claude"),
          path.join(environment.homeDir, ".config", "Claude")
        ];

        if (environment.appData) {
          roots.push(path.join(environment.appData, "Claude"));
          roots.push(path.join(environment.appData, "Claude Code"));
        }

        if (environment.localAppData) {
          roots.push(path.join(environment.localAppData, "Claude"));
        }

        return roots;
      },
      extraFilter(filePath) {
        const lower = filePath.toLowerCase();
        return lower.includes("history") || lower.includes("session") || lower.includes("chat") || lower.includes("log");
      }
    });
  }
}
