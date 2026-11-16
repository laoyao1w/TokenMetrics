/* Token计量办 · 段位与称号系统（唯一数据源）
 * 浏览器与 Node 共用：浏览器挂 window.TokenRanks，Node 直接 require。
 * 段位依据 = 跨工具去重后的终身累计 Token（只增不减，不用单日/周/月量）。
 * 阈值判定：左闭右开 [minTokens, maxTokens)；Token=0 时返回 RANK_ZERO（待首次开蹬）。
 * 数值安全：最大阈值 1 万亿 = 1e12 < Number.MAX_SAFE_INTEGER(≈9e15)，整数比较安全。
 */
(function (global, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    global.TokenRanks = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Token = 0：未解锁正式段位
  // badge 视觉等级：1 简洁基础 / 2 精致边框 / 3 立体感 / 4 勋章光效 / 5 顶级荣耀
  const RANK_ZERO = {
    level: 0,
    name: "待首次开蹬",
    minTokens: 0,
    maxTokens: 0,
    badge: 1,
    titles: ["AI初见者"]
  };

  const RANK_TIERS = [
    { level: 1,  name: "初入江湖",   minTokens: 0,               maxTokens: 5e7,               badge: 1, titles: ["AI尝鲜者", "初代玩家", "赛博新人", "Token萌新", "蹬车预备役"] },
    { level: 2,  name: "正式上车",   minTokens: 5e7,             maxTokens: 2e8,               badge: 1, titles: ["AI体验官", "Token探索家", "AI常驻人口", "赛博熟练工", "蹬车入门者"] },
    { level: 3,  name: "持续输出",   minTokens: 2e8,             maxTokens: 1e9,               badge: 2, titles: ["Token收割机", "AI熟练玩家", "赛博劳模", "Token常客", "猛蹬选手"] },
    { level: 4,  name: "深度玩家",   minTokens: 1e9,             maxTokens: 5e9,               badge: 2, titles: ["AI驾驭者", "Token燃烧者", "赛博工作狂", "AI重度玩家", "蹬车老司机"] },
    { level: 5,  name: "进阶高手",   minTokens: 5e9,             maxTokens: 2e10,              badge: 3, titles: ["AI操盘手", "Token狂热者", "算力玩家", "赛博极客", "蹬车猛将"] },
    { level: 6,  name: "高强度玩家", minTokens: 2e10,            maxTokens: 5e10,              badge: 3, titles: ["赛博永动机", "AI狂人", "Token巨鳄", "算力猛兽", "疯狂蹬车手"] },
    { level: 7,  name: "顶级玩家",   minTokens: 5e10,            maxTokens: 1.5e11,            badge: 4, titles: ["赛博战神", "AI重装骑士", "Token巨擘", "算力霸主", "蹬车王者"] },
    { level: 8,  name: "传奇玩家",   minTokens: 1.5e11,          maxTokens: 3e11,              badge: 4, titles: ["赛博传奇", "AI征服者", "Token暴君", "算力巨人", "永不落地者"] },
    { level: 9,  name: "殿堂玩家",   minTokens: 3e11,            maxTokens: 1e12,              badge: 5, titles: ["算力之王", "AI先驱者", "Token帝王", "赛博元老", "蹬车天尊"] },
    { level: 10, name: "神话玩家",   minTokens: 1e12,            maxTokens: Infinity,          badge: 5, titles: ["Token至尊", "AI时代先行者", "算力主宰", "赛博神话", "蹬车成仙"] }
  ];

  /** 依据终身累计 Token 计算段位（左闭右开；边界值进入更高一级段位）。 */
  function computeRank(totalTokens) {
    const t = Math.floor(Number(totalTokens) || 0);
    if (t <= 0) return RANK_ZERO;
    for (const rank of RANK_TIERS) {
      if (t >= rank.minTokens && t < rank.maxTokens) return rank;
    }
    return RANK_TIERS[RANK_TIERS.length - 1];
  }

  /** 默认称号 = 段位称号库第 1 项。 */
  function defaultTitle(rank) {
    return rank && rank.titles.length ? rank.titles[0] : "AI初见者";
  }

  /** 大 Token 数量简洁格式：亿 / 万 / 原数 */
  function formatToken(n) {
    n = Math.floor(Number(n) || 0);
    if (n >= 1e8) {
      const v = n / 1e8;
      return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + " 亿";
    }
    if (n >= 1e4) return Math.round(n / 1e4) + " 万";
    return String(n);
  }

  /** 段位升级进度：{ pct, done, diff, next }；LV.10 返回 done=true。未开蹬返回 null。 */
  function rankProgress(rank, totalTokens) {
    if (!rank || rank.level === 0) return null;
    const t = Math.floor(Number(totalTokens) || 0);
    if (rank.maxTokens === Infinity) return { pct: 1, done: true, diff: null, next: null };
    const pct = Math.max(0, Math.min(1, (t - rank.minTokens) / (rank.maxTokens - rank.minTokens)));
    const next = rank.level < RANK_TIERS.length ? RANK_TIERS[rank.level] : null;
    return { pct, done: false, diff: rank.maxTokens - t, next };
  }

  return { RANK_ZERO, RANK_TIERS, computeRank, defaultTitle, formatToken, rankProgress };
});