import { registerNodeSha256 } from "./core/hash-node.js";
import { registerNodeHost } from "./host/node-host.js";

registerNodeSha256();
registerNodeHost();

import { getCollectors } from "./collectors/registry.js";
import { deduplicateRecords } from "./core/deduplication.js";
import { summarizeUsage } from "./core/statistics.js";

interface ProgressUpdate {
  phase: string;
  label: string;
  progress: number;
  collectorId?: string;
  collectorName?: string;
  detail?: string;
}

const PROGRESS_PREFIX = "__TOKENHALL_PROGRESS__";

function emitProgress(update: ProgressUpdate): void {
  if (process.env["TOKENHALL_PROGRESS"] !== "1") return;
  process.stderr.write(`${PROGRESS_PREFIX}${JSON.stringify(update)}\n`);
}

async function main(): Promise<void> {
  const collectors = getCollectors();
  const batches = [];

  emitProgress({
    phase: "prepare",
    label: "正在准备本地采集器",
    progress: 4,
    detail: `已接入 ${collectors.length} 个数据源`
  });

  for (const [index, collector] of collectors.entries()) {
    const startProgress = 10 + Math.round((index / collectors.length) * 64);
    emitProgress({
      phase: "collector:start",
      label: `正在读取 ${collector.displayName}`,
      progress: startProgress,
      collectorId: collector.id,
      collectorName: collector.displayName,
      detail: `第 ${index + 1} / ${collectors.length} 个数据源`
    });

    const batch = await collector.collect();
    batches.push(batch);

    const matched = batch.coverage.matchedRecordCount;
    emitProgress({
      phase: "collector:done",
      label: `${collector.displayName} 读取完成`,
      progress: 10 + Math.round(((index + 1) / collectors.length) * 64),
      collectorId: collector.id,
      collectorName: collector.displayName,
      detail: matched > 0 ? `发现 ${matched} 条有效记录` : "未发现可计入的用量记录"
    });
  }

  emitProgress({
    phase: "postprocess:dedupe",
    label: "正在去重并合并用量记录",
    progress: 82,
    detail: "按 request / session 去重"
  });
  const records = deduplicateRecords(batches.flatMap((batch) => batch.records));

  emitProgress({
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
    }))
  };

  emitProgress({
    phase: "done",
    label: "采集完成，统计已更新",
    progress: 100,
    detail: `累计 ${summary.totalTokens} Tokens`
  });

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
