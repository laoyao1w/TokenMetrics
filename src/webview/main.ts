import { registerWebSha256 } from "../core/hash-web.js";
import { registerWebHost } from "../host/web-host.js";
import { getHost } from "../host/types.js";
import { CodexCollector } from "../collectors/codex/collector.js";
import { ClaudeCollector } from "../collectors/claude/collector.js";
import { TraeCollector } from "../collectors/trae/collector.js";
import { WorkBuddyCollector } from "../collectors/workbuddy/collector.js";
import { deduplicateRecords } from "../core/deduplication.js";
import { summarizeUsage } from "../core/statistics.js";
import { collectTraeIntlWeb } from "./trae-intl-web.js";
import type { Collector } from "../collectors/types.js";

// 注意：不经过 registry（registry 会拖入 Node 版 trae-intl 采集器及其 wa-sqlite 依赖）。
// 这里只引入 4 个文件系统采集器，Trae 国际版由 collectTraeIntlWeb 单独走 Rust 解密 + sql.js。

/**
 * WebView 采集主入口（由 esbuild 打包为 bundle/collector.js 供 index.html 使用）。
 * 完全替代旧方案中 "Rust spawn node.exe 执行 collector.mjs" 的进程外采集：
 * 文件系统/解密走 Tauri IPC，解析与汇总逻辑在浏览器内执行。
 */

export interface WebProgressUpdate {
  phase: string;
  label: string;
  progress: number;
  collectorId?: string;
  collectorName?: string;
  detail?: string;
}

export type WebProgressListener = (update: WebProgressUpdate) => void;

let registered = false;

async function ensureRuntime(): Promise<void> {
  if (registered) {
    return;
  }
  registerWebSha256();
  await registerWebHost();
  registered = true;
}

export async function runWebCollection(
  onProgress?: WebProgressListener
): Promise<string> {
  await ensureRuntime();
  const host = getHost();
  const emit = (update: WebProgressUpdate) => {
    onProgress?.(update);
  };

  const filesystemCollectors: Collector[] = [
    new CodexCollector(),
    new ClaudeCollector(),
    new WorkBuddyCollector(),
    new TraeCollector()
  ];
  const collectorTasks = [
    ...filesystemCollectors.map((collector) => ({
      id: collector.id,
      displayName: collector.displayName,
      run: () => collector.collect()
    })),
    {
      id: "trae-intl",
      displayName: "TRAE International",
      run: () => collectTraeIntlWeb()
    }
  ];
  const batches = new Array(collectorTasks.length);

  emit({
    phase: "prepare",
    label: "正在准备本地采集器",
    progress: 4,
    detail: `已接入 ${collectorTasks.length} 个数据源`
  });

  collectorTasks.forEach((collector, index) => {
    emit({
      phase: "collector:start",
      label: `正在读取 ${collector.displayName}`,
      progress: 10,
      collectorId: collector.id,
      collectorName: collector.displayName,
      detail: `第 ${index + 1} / ${collectorTasks.length} 个数据源`
    });
  });

  let completedCount = 0;
  await Promise.all(
    collectorTasks.map(async (collector, index) => {
      const batch = await collector.run();
      batches[index] = batch;
      completedCount += 1;
      const matched = batch.coverage.matchedRecordCount;
      emit({
        phase: "collector:done",
        label: `${collector.displayName} 读取完成`,
        progress: 10 + Math.round((completedCount / collectorTasks.length) * 64),
        collectorId: collector.id,
        collectorName: collector.displayName,
        detail: matched > 0 ? `发现 ${matched} 条有效记录` : "未发现可计入的用量记录"
      });
    })
  );

  emit({
    phase: "postprocess:dedupe",
    label: "正在去重并合并用量记录",
    progress: 82,
    detail: "按 request / session 去重"
  });
  const records = deduplicateRecords(batches.flatMap((batch) => batch.records));

  emit({
    phase: "postprocess:summary",
    label: "正在汇总模型分布",
    progress: 91,
    detail: `累计 ${records.length} 条请求记录`
  });
  const summary = summarizeUsage(records);

  const payload = {
    generatedAt: new Date().toISOString(),
    summary,
    collectors: batches.map((batch) => ({
      status: batch.status,
      coverage: batch.coverage
    })),
    host: {
      platform: host.platform
    }
  };

  emit({
    phase: "done",
    label: "采集完成，统计已更新",
    progress: 100,
    detail: `累计 ${summary.totalTokens} Tokens`
  });

  return JSON.stringify(payload);
}

// 供 index.html 直接调用的全局入口（esbuild --global-name）。
export function exposeToWindow(): void {
  (globalThis as Record<string, unknown>)["tokenHallCollect"] = runWebCollection;
  (globalThis as Record<string, unknown>)["tokenHallPlatform"] = async () => (await ensureRuntime(), getHost().platform);
}
