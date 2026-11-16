import type { Collector } from "../types.js";
import { collectFromFilesystem } from "../shared/filesystem-collector.js";
import { getHost } from "../../host/types.js";

export class WorkBuddyCollector implements Collector {
  readonly id = "workbuddy";
  readonly displayName = "Tencent WorkBuddy";

  async collect() {
    return collectFromFilesystem({
      id: this.id,
      displayName: this.displayName,
      evidenceTypes: ["local-log"],
      warningWhenEmpty: "Tencent WXWork directory was not found.",
      maxDepth: 6,
      candidateRoots(environment) {
        const path = getHost().path;
        const roots = [];

        if (environment.appData) {
          roots.push(path.join(environment.appData, "Tencent", "WXWork"));
        }

        return roots;
      },
      extraFilter(filePath) {
        const lower = filePath.toLowerCase();
        const sep = getHost().path.sep;
        return (
          lower.includes(`${sep}log${sep}`) ||
          lower.includes("assistant") ||
          lower.includes("ai_summary") ||
          lower.includes("workbuddy")
        );
      }
    });
  }
}
