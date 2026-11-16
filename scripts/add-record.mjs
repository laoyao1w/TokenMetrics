/* 排行榜录入脚本：解析一条战绩验证链接（verify?n=..&t=..&d=..&a=..&s=..），
 * 校验数据指纹后 upsert 进 frontend/leaderboard.json，并按今日用量降序排列。
 * 用法：
 *   npm run add-record -- "<verify链接>" [--name "昵称"]
 * 说明：昵称缺省为「匿名蹬车手」；同名报告号重复提交会保留原昵称、覆盖数据。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(here, "../frontend/leaderboard.json");
const RNO_RE = /^TJ-\d{8}-[0-9A-F]{6}$/;

function parseArgs(argv) {
  const out = { url: "", name: "匿名蹬车手" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") {
      out.name = argv[++i] || out.name;
    } else if (!out.url) {
      out.url = argv[i];
    }
  }
  return out;
}

function parseQuery(url) {
  const idx = url.indexOf("?");
  const q = {};
  if (idx >= 0) {
    (url.slice(idx + 1) || "").split("&").forEach((kv) => {
      const p = kv.indexOf("=");
      if (p < 0) return;
      try {
        q[decodeURIComponent(kv.slice(0, p))] = decodeURIComponent(kv.slice(p + 1));
      } catch {
        q[kv.slice(0, p)] = kv.slice(p + 1);
      }
    });
  }
  return q;
}

/** 与 frontend/verify.html 完全一致的数据指纹（FNV-1a 32bit，取 hex 后 6 位大写）。 */
function fingerprint(total, today, active) {
  const fp = String(total) + "|" + String(today) + "|" + String(active);
  let h = 2166136261;
  for (let i = 0; i < fp.length; i++) {
    h ^= fp.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).toUpperCase().padStart(6, "0").slice(-6);
}

function fail(msg) {
  console.error("[add-record] " + msg);
  process.exit(1);
}

const { url, name } = parseArgs(process.argv.slice(2));
if (!url) fail("缺少战绩链接参数，用法：npm run add-record -- \"<verify链接>\" [--name 昵称]");
if (!/^https?:\/\//i.test(url)) fail("参数不是有效链接");

const q = parseQuery(url);
const rno = q.n || "";
const total = Number(q.t);
const today = Number(q.d);
const active = Number(q.a);
const sources = (q.s || "").split(",").filter(Boolean);

if (!RNO_RE.test(rno)) fail("报告编号无效：" + rno);
if (!Number.isFinite(total) || !Number.isFinite(today) || !Number.isFinite(active)) {
  fail("数据字段缺失（t/d/a）或非数字");
}
const hashPart = rno.slice(-6);
const ok = fingerprint(total, today, active) === hashPart;
if (!ok) fail("数据指纹校验未通过，链接疑似被篡改：" + rno);

const date = rno.slice(3, 11).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
const entry = { name, reportNo: rno, date, total, today, activeDays: active, sources };

let list = [];
if (existsSync(FILE)) {
  try {
    list = JSON.parse(readFileSync(FILE, "utf-8"));
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
}
const prev = list.find((r) => r && r.reportNo === rno);
if (prev && prev.name && prev.name !== "匿名蹬车手") entry.name = prev.name;
list = list.filter((r) => r && r.reportNo !== rno);
list.push(entry);
list.sort((a, b) => b.today - a.today);

writeFileSync(FILE, JSON.stringify(list, null, 2) + "\n");
console.log(`[add-record] OK 已入库：${entry.name} · 今日 ${today} · ${rno}（榜单第 ${list.indexOf(entry) + 1} 名）`);