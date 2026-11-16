import type { Collector } from "./types.js";
import { ClaudeCollector } from "./claude/collector.js";
import { CodexCollector } from "./codex/collector.js";
import { TraeCollector } from "./trae/collector.js";
import { TraeIntlCollector } from "./trae-intl/collector.js";
import { WorkBuddyCollector } from "./workbuddy/collector.js";

export function getCollectors(): Collector[] {
  return [
    new CodexCollector(),
    new ClaudeCollector(),
    new WorkBuddyCollector(),
    new TraeIntlCollector(),
    new TraeCollector()
  ];
}
