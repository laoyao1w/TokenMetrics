import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../frontend/ranks.cjs");
const { computeRank, defaultTitle, formatToken, RANK_TIERS } = R;

let failures = 0;
function check(name, actual, expect) {
  const ok = actual === expect;
  if (!ok) {
    console.error(`FAIL ${name}: got=${JSON.stringify(actual)} expect=${JSON.stringify(expect)}`);
    failures++;
  } else {
    console.log(`ok   ${name}: ${actual}`);
  }
}

function desc(t) {
  const rank = computeRank(t);
  return `${rank.level}:${rank.name}·${defaultTitle(rank)}`;
}

// ---- 验收表 ----
const cases = [
  [3e7, "1:初入江湖·AI尝鲜者"],
  [8e7, "2:正式上车·AI体验官"],
  [5e8, "3:持续输出·Token收割机"],
  [2e9, "4:深度玩家·AI驾驭者"],
  [8e9, "5:进阶高手·AI操盘手"],
  [3e10, "6:高强度玩家·赛博永动机"],
  [8e10, "7:顶级玩家·赛博战神"],
  [2e11, "8:传奇玩家·赛博传奇"],
  [6e11, "9:殿堂玩家·算力之王"],
  [1.2e12, "10:神话玩家·Token至尊"]
];
for (const [t, expect] of cases) check(`case ${t}`, desc(t), expect);

// ---- 边界值：必须进入更高一级 ----
const bounds = [
  [5e7, "2:正式上车·AI体验官"],
  [2e8, "3:持续输出·Token收割机"],
  [1e9, "4:深度玩家·AI驾驭者"],
  [5e9, "5:进阶高手·AI操盘手"],
  [2e10, "6:高强度玩家·赛博永动机"],
  [5e10, "7:顶级玩家·赛博战神"],
  [1.5e11, "8:传奇玩家·赛博传奇"],
  [3e11, "9:殿堂玩家·算力之王"],
  [1e12, "10:神话玩家·Token至尊"]
];
for (const [t, expect] of bounds) check(`bound ${t}`, desc(t), expect);

// ---- 边界前一位必须停留在低一级 ----
const justBefore = [
  [5e7 - 1, "1:初入江湖·AI尝鲜者"],
  [2e8 - 1, "2:正式上车·AI体验官"],
  [1e9 - 1, "3:持续输出·Token收割机"],
  [5e9 - 1, "4:深度玩家·AI驾驭者"],
  [2e10 - 1, "5:进阶高手·AI操盘手"],
  [5e10 - 1, "6:高强度玩家·赛博永动机"],
  [1.5e11 - 1, "7:顶级玩家·赛博战神"],
  [3e11 - 1, "8:传奇玩家·赛博传奇"],
  [1e12 - 1, "9:殿堂玩家·算力之王"]
];
for (const [t, expect] of justBefore) check(`before ${t}`, desc(t), expect);

// ---- 特殊值 ----
check("zero", desc(0), "0:待首次开蹬·AI初见者");
check("negative", desc(-5), "0:待首次开蹬·AI初见者");
check("huge", computeRank(1e16).level, 10);

// ---- 进度条 ----
const prog1 = R.rankProgress(computeRank(8e7), 8e7);
check("prog diff", prog1.diff, 2e8 - 8e7);
check("prog next", prog1.next.name, "持续输出");
const progTop = R.rankProgress(computeRank(2e12), 2e12);
check("prog top done", progTop.done, true);
check("prog zero", R.rankProgress(R.RANK_ZERO, 0), null);

// ---- formatToken ----
check("fmt 亿", formatToken(1.2e10), "120 亿");
check("fmt 亿小数", formatToken(1.25e8), "1.3 亿");
check("fmt 万", formatToken(3.4e6), "340 万");

// ---- 称号库结构 ----
check("10 tiers", RANK_TIERS.length, 10);
for (const r of RANK_TIERS) {
  check("tier titles x5 " + r.name, r.titles.length, 5);
}

if (failures) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nALL PASS");