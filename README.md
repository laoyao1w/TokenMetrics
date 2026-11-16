<p align="center">
  <img src="assets/app-icon.png" width="128" alt="Token 统计局" />
</p>

<h1 align="center">🔋 Token 统计局 · TokenMetrics</h1>

<p align="center">
  <b>AI 时代不看你知不知道，看你的 Token 烧了多少。</b>
</p>

<p align="center">
  <a href="https://github.com/laoyao1w/TokenMetrics/raw/main/frontend/downloads/TokenMetrics.exe"><img src="https://img.shields.io/badge/下载桌面端-Windows%20exe-38bdf8?style=for-the-badge&labelColor=0f172a" alt="下载桌面端" /></a>
  <img src="https://img.shields.io/badge/版本-0.1.0-22d3ee?style=for-the-badge&labelColor=0f172a" alt="版本" />
  <img src="https://img.shields.io/badge/桌面端-Windows-38bdf8?style=for-the-badge&labelColor=0f172a" alt="平台" />
  <img src="https://img.shields.io/badge/协议-GPL--3.0-fbbf24?style=for-the-badge&labelColor=0f172a" alt="协议" />
  <img src="https://img.shields.io/badge/技术栈-Tauri%202%20·%20TypeScript-a78bfa?style=for-the-badge&labelColor=0f172a" alt="技术栈" />
</p>

---

## 💡 先讲清楚一个观念

> [!IMPORTANT]
> **普通人有没有进入 AI 时代，就看他每天的 Token 用量。**
>
> 在这个时代，AI 不是聊聊天、看几个视频就算参与。**真正踏进 AI 时代的标志，是你把自己的思考、代码、工作流，交出去和模型一起烧。**
>
> Token 消耗量越大，说明你在 AI 时代跟随得越紧。**Token，是你和这个时代之间的刻度。**

我们不信嘴上的「我天天用 AI」。我们只信数字。

<h3 align="center">🟢 用得多，跟得紧 🔴 用得少，别掉队</h3>

---

## 🎯 它是什么

一个 **本地优先** 的 AI Token 战绩统计与认证工具：

- 逐条采集你在 **Claude Code / OpenAI Codex / Trae / TRAE International / 腾讯 WorkBuddy** 上的真实用量
- 输入 + 输出 + 推理（Reasoning）Token **全口径**统计
- 按 requestId 全局去重，**绝不重复计算、绝不伪造数据**
- 生成「TOKEN 计量办」认证海报与可校验链接，战绩真实可查、无法造假

> 只信本地证据 —— 采集不到就不报，绝不瞎猜。

---

## ⚡ 特性一览

| | 特性 | 说明 |
|---|---|---|
| 🛡️ | **本地优先，证据可查** | 只读本地日志与数据库，逐条取证（`history_v2`），杜绝估算 |
| 🧮 | **全口径统计** | 输入 + 输出 + 推理 Token，一个都不少 |
| 🔍 | **全局去重** | 按 requestId 去重，统计结果唯一、不可重复计数 |
| 📡 | **多端采集** | Claude / Codex / WorkBuddy / Trae / Trae 国际版 SQLCipher 解密读取 |
| 🔐 | **指纹认证** | FNV-1a 指纹校验报告号，成绩无法造假 |
| 🏆 | **实时排行榜** | 真实报告链接构成，每日用量 TOP 100，个人战绩高亮 |
| 🦤 | **极致精简的桌面端** | Tauri 2 单文件 ~3.9 MB，WebView 内采集，不内置 Node |

---

## 🚀 快速开始

```bash
npm install
npm run collect   # 本地采集，打印统计摘要与证据元数据
npm run preview   # 浏览器预览（非 Tauri 环境走 Node 采集路径）
npm test          # 跑采集 / 去重 / 解析测试
```

桌面端（Tauri）开发与打包见 [BUILD.md](BUILD.md)。

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 纯静态 HTML/CSS/JS（无框架） |
| 采集 | TypeScript 采集器 + esbuild 打包为 WebView 内执行的 `collector.js` |
| 数据库 | sql.js（WebAssembly SQLite） |
| 桌面壳 | Tauri 2.x + Rust（文件系统 / SQLCipher 解密下沉 Rust 层） |

### 目录结构

```
src/collectors/    各 AI 工具采集器（共享解析逻辑）
src/core/          Token 记录模型、去重、统计
src/host/          宿主抽象（Node 宿主 / Tauri WebView 宿主）
frontend/          网页：主面板、战绩认证、排行榜、悬浮球
scripts/           构建、图标生成、榜单录入等工具脚本
src-tauri/src/     Rust：IPC 命令、SQLite 快照与解密
```

---

## 🤝 隐私承诺

> [!CAUTION]
> 你的对话内容、提示词、代码，**一律不上传、不采集**。只处理统计摘要。

- 采集进程以无窗口模式静默运行（Windows），不弹任何终端窗口
- 所有数据默认保存在本地
- 分享与上榜仅基于汇总数值与指纹认证链接

---

## 🧾 开源协议

本项目基于 [GPL-3.0](LICENSE) 开源。你可以自由使用、修改、分发，但衍生项目必须同样以 GPL-3.0 开放源代码。

采集策略参考了以下开源项目（详见 [OPEN_SOURCE_NOTES.md](OPEN_SOURCE_NOTES.md)）：

- `FightZhanAng/wb-token-meter` · `Annihilater/token-stats` · `splunk/token-meter` · `@aiusage/cli`

---

<p align="center">
  <i>Token 是战绩，段位是身份，称号是荣耀。</i><br/>
  <b>—— Token 计量办</b>
</p>

<p align="center">
  <sub>下载绿色免安装版：<a href="https://github.com/laoyao1w/TokenMetrics/raw/main/frontend/downloads/TokenMetrics.exe">TokenMetrics.exe</a>（约 3.9 MB），点击后可直接下载桌面端 exe 文件，解压即用。</sub>
</p>