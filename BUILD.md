# Token 统计局 — 构建与打包指南

> 本文档记录本项目的完整构建 / 打包流程、环境要求、体积精简方案与常见坑位，
> 供下次构建打包时直接参照。

---

## 1. 项目技术栈

- 前端：纯静态 HTML/CSS/JS（`frontend/`，无框架，Tauri `frontendDist` 直接指向前端目录）
- 数据采集：TypeScript 采集逻辑（`src/collectors/` 共享）+ `src/webview/` 入口，
  esbuild 打包为 `frontend/collector.js`，在 **WebView 内直接执行**（不内置 Node）
- 桌面壳：Tauri 2.x（CLI 2.12.4），Rust 后端位于 `src-tauri/`
- 数据库：sql.js（WebAssembly SQLite，wasm 随前端静态资源发布）
- 文件系统访问：WebView 通过 Tauri IPC 调用 Rust 命令（`read_dir` / `read_file` /
  `fs_stat` / `os_env` / `platform` / `read_trae_snapshot`）

---

## 2. 前置环境

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | >= 24 | 仅构建期需要（esbuild 打包采集 bundle）；**运行时不内置 Node** |
| Rust 工具链 | stable | Tauri 后端编译 |
| Tauri CLI | `@tauri-apps/cli` ^2.12.4（已在 devDependencies） | `npm run tauri` 调用 |
| Visual Studio Build Tools | MSVC + Windows SDK | Windows 平台链接 C++ 依赖 |

Rust MSVC 工具链与 Node 均已配置的机器上，直接执行第 3 节的命令即可。

---

## 3. 构建命令

### 3.1 完整构建（生成 release exe + NSIS 安装包）

```powershell
# 在项目根目录执行
npm install
npm run tauri:build
```

`npm run tauri:build` 解析为 `tauri build`，其 `beforeBuildCommand` 会自动先跑
`npm run build:collector`（见第 4 节），无需手动执行。

### 3.2 仅构建可执行文件（不打包安装包）

```powershell
npm run tauri -- build --no-bundle
```

### 3.3 单独刷新 WebView 采集 bundle（改动了采集逻辑后手动跑）

```powershell
npm run build:collector
```

### 3.4 开发模式

```powershell
npm run tauri:dev      # 启动预览服务器 + Tauri 开发窗口
```

---

## 4. WebView 采集 bundle 与体积精简（关键）

自 0.1.x 起，桌面端**不再内置 Node 运行时**。采集逻辑全部在 WebView 内执行：
- `frontend/collector.js`：由 [scripts/build-collector.mjs](file:///d:/code/token%E7%BB%9F%E8%AE%A1%E5%B1%80/scripts/build-collector.mjs)
  用 esbuild 打包 `src/webview/entry.ts` 生成（IIFE，含 sql.js，约 72 KB）
- `frontend/sql-wasm.wasm`：sql.js 的 WebAssembly 二进制（约 668 KB），运行时装在内存

采集运行时工作链路：

```
index.html
  └─ window.tokenHallCollect(cb)           ← frontend/collector.js 暴露的全局函数
       ├─ 4 个文件系统采集器（codex/claude/workbuddy/trae）
       │    └─ getHost().readDir/readFile/stat → Tauri IPC → Rust 命令
       └─ Trae 国际版
            └─ host.readTraeSnapshot() → Rust SQLCipher 解密 + WAL 合并
                 └─ host.openSqliteDb() → sql.js 查询明文快照
```

宿主抽象：`src/host/types.ts` 定义 `Host` 接口，Node 环境（CLI/预览服务器）注册
`node-host.ts`，Tauri WebView 注册 `web-host.ts`（经 `window.__TAURI__.core.invoke`
调用 Rust 命令）。共享采集逻辑（`src/collectors/shared/`）只依赖该接口，不直接
import 任何 `node:*` 模块，因此同一个 bundle 可在浏览器 / WebView 双端执行。

Rust 侧 6 个 IPC 命令定义在 [lib.rs](file:///d:/code/token%E7%BB%9F%E8%AE%A1%E5%B1%80/src-tauri/src/lib.rs)：
`os_env` / `platform` / `read_dir` / `read_file` / `fs_stat` / `read_trae_snapshot`。

**体积优化原则**：不随包携带任何运行时二进制，node.exe 从安装包中彻底移除后，
NSIS 安装包由 ~20 MB 降至 **~1.7 MB**（压缩后）。`token-hall.exe` 约 3.9 MB
（含前端资源与 wasm）。切勿再退回「spawn node.exe 执行采集脚本」的旧方案。

---

## 5. NSIS 打包工具链（重点避坑）

安装包由 NSIS 生成。**工具的下载与摆放是本项目最大的坑**，以下均已踩过并解决。

### 5.1 工具缓存位置

`src-tauri/tauri.conf.json` 已配置 `bundle.useLocalToolsDir: true`，工具缓存到项目内：

```
src-tauri/target/.tauri/NSIS/
```

正常单次构建即可自动完成准备。**不要轻易删除 `src-tauri/target/.tauri/`**，
删掉后需要重新走 5.2 的下载流程。

### 5.2 缓存丢失时需要手工准备 NSIS

#### ① 下载 NSIS 压缩包

```powershell
Invoke-WebRequest `
  -Uri "https://gh-proxy.com/https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip" `
  -OutFile "src-tauri\target\.tauri\nsis-3.13.zip"
```

- SHA1 校验值：`DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E`
- 校验命令：
  ```powershell
  Get-FileHash src-tauri\target\.tauri\nsis-3.13.zip -Algorithm SHA1
  ```
- 网络提示：GitHub 直连可能超时，任选一个镜像代理替换 `gh-proxy.com`（如 `ghfast.top`）。
- 解压：
  ```powershell
  Compress-Archive 无法解压则用 Expand-Archive：
  Expand-Archive -Path "src-tauri\target\.tauri\nsis-3.13.zip" -DestinationPath "src-tauri\target\.tauri\"
  ```

#### ② 目录结构（关键！）

解压后默认是 `src-tauri\target\.tauri\nsis-3.13\`，**必须重命名为 `NSIS`**，
让 `makensis.exe` 位于 `NSIS\` 顶层：

```powershell
Rename-Item "src-tauri\target\.tauri\nsis-3.13" "src-tauri\target\.tauri\NSIS"
```

最终结构：

```
NSIS/
├── makensis.exe          # 必须在此层，不能多一层 nsis-3.13
├── makensisw.exe
├── NSIS.exe
├── COPYING
├── NSIS.chm
├── nsisconf.nsh
├── Bin/makensis.exe
├── Stubs/lzma-x86-unicode
├── Stubs/lzma_solid-x86-unicode
├── Include/MUI2.nsh
├── Include/FileFunc.nsh
├── Include/x64.nsh
├── Include/nsDialogs.nsh
├── Include/WinMessages.nsh
├── Include/Win/COM.nsh
├── Include/Win/Propkey.nsh
├── Include/Win/RestartManager.nsh
└── Plugins/x86-unicode/additional/nsis_tauri_utils.dll   # 见 ③
```

未满足结构时会报 `NSIS directory is missing some files. Recreating it.` 并重下。

#### ③ 单独补充 nsis_tauri_utils.dll

`nsis_tauri_utils.dll` 不在 NSIS 官方包里，必须单独下载放到 `Plugins/x86-unicode/additional/`：

```powershell
Invoke-WebRequest `
  -Uri "https://gh-proxy.com/https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll" `
  -OutFile "src-tauri\target\.tauri\NSIS\Plugins\x86-unicode\additional\nsis_tauri_utils.dll"
```

- SHA1 校验值：`75197FEE3C6A814FE035788D1C34EAD39349B860`
- 目录不存在则先 `New-Item -ItemType Directory -Force`

---

## 6. 产物输出位置

| 产物 | 路径 |
| --- | --- |
| 桌面程序 exe | `src-tauri\target\release\token-hall.exe` |
| NSIS 安装包 | `src-tauri\target\release\bundle\nsis\Token Hall_0.1.0_x64-setup.exe` |
| WebView 采集 bundle | `frontend\collector.js` + `frontend\sql-wasm.wasm`（随 frontendDist 打进 exe） |
| NSIS 工具缓存 | `src-tauri\target\.tauri\` |

版本号由 `src-tauri/tauri.conf.json` 的 `version`（当前 `0.1.0`）决定；
改版本号后安装包文件名会同步变化。

---

## 7. 打包配置速览（src-tauri/tauri.conf.json）

- `bundle.targets: ["nsis"]` — 只打 NSIS，不产 MSI，减少体积与构建时间
- `bundle.useLocalToolsDir: true` — 工具缓存到项目 `.tauri/`，避免写入系统 AppData（沙箱/权限受限环境必须）
- `build.beforeBuildCommand: "npm run build:collector"` — 构建前自动重建 WebView 采集 bundle
- **不配置 `bundle.resources`** — 不再内嵌任何运行时目录（node.exe 已彻底移除）
- 图标由两段命令生成（见下），源码位于 `assets/app-icon.png`，全套输出在 `src-tauri/icons/`

### 7.1 重新生成全套图标（改图标后执行）

图标是**圆环设计**（以悬浮球的醍醐骑车外圈动态圆环为参考），圆环之外为透明。设计源文件为 `assets/new-icon-design-v2.jpg`（1024×1024），
`scripts/gen-icon.mjs` 负责把 JPG 裁成「醍醐骑车圆环 + 外侧全透明」的 `assets/app-icon.png`。
改完设计后按顺序执行：

```powershell
# 1) 从设计 JPG 生成 1024x1024 源图（无外部依赖：
#    System.Drawing(JPG->PNG) + 自定义 PNG 解码 + 边缘背景检测 + 3x3 超采样抗锯齿）
node scripts/gen-icon.mjs

# 2) 由源图生成 Tauri 全套图标（png / ico / icns / ios / android 等）
npx tauri icon assets/app-icon.png
```

> `gen-icon.mjs` 的设计原理（若改阈值或换设计需留意）：
> - 图标是居中的圆形设计，背景为纯黑色。
> - 直接按像素色做背景检测：背景判定为「极暗」（`R,G,B < 30`）。
> - 从中心点向外扩展保留连通区域，确保圆环主体完整且边缘透明。
> - 边界用 3×3 超采样计算 alpha，得到平滑的抗锯齿透明边缘。
>
> 注意：Windows 任务栏 / 资源管理器取的是 `icon.ico` 与各尺寸 png。
> 改完图标后必须重新 `tauri build`（或 `tauri build --no-bundle`）才能让
> `token-hall.exe` 内嵌新图标；不重新构建，exe 里仍是旧图标。
>
> **大坑（已踩）**：exe 图标资源由 `tauri-build` 的 build script 在编译期用
> `rc.exe` 编译 `resource.rc -> resource.lib` 后链接进 exe。`tauri_build::build()`
> **不会**为 icon.ico 声明 `cargo:rerun-if-changed`，所以**只改图标不触发资源重编**，
> cargo 会复用缓存的旧 `resource.lib`，exe 图标看上去"没变化"。
> 项目已在 `src-tauri/build.rs` 里补了一句 `cargo:rerun-if-changed=icons/icon.ico`，
> 以后改图标会自动重编。若遇到图标不更新的旧环境，手动清一次：
> `cargo clean -p token-hall`，或删除 `src-tauri/target/release/build/token-hall-*/` 后重 build。

---

## 8. 已知坑与提示

1. **GitHub 下载超时**：NSIS 下载走 `gh-proxy.com` 代理；若代理失效，换带外镜像。
2. **写入 AppData 被拒（os error 5）**：说明 `useLocalToolsDir` 未生效或缓存被清，
   改用项目内 `.tauri/` 目录。
3. **采集 bundle 不更新**：修改 `src/` 采集代码后必须重新执行 `npm run build:collector`
   （`tauri build` 前的 `beforeBuildCommand` 会自动做）。开发/预演时可直接用
   `npm run preview` 在浏览器里验证（非 Tauri 环境走 `/api/summary` Node 采集路径）。
4. **解压报 .NET 重载歧义**：`Expand-Archive -Path x.zip -DestinationPath y` 别带
   第三个布尔参数（老版本 .NET Framework 会解析成 Encoding 重载导致失败）。
5. **WebView 采集与 Node 采集是两套入口**：桌面端 `index.html` 调
   `window.tokenHallCollect`（WebView 路径）；CLI/预演服务器走 `src/cli.ts` /
   `/api/summary`（Node 宿主路径）。共享的采集逻辑在 `src/collectors/shared/`,
   新写采集器时只允许依赖 `getHost()` 与纯函数，**禁止直接 import `node:*`**，
   否则 esbuild 打浏览器 bundle 会失败。
6. **新增 npm 运行时依赖时**：先确认它能被 esbuild 打进 `frontend/collector.js`
   且无 `node:*` / `import.meta` 依赖；再跑 `npm run build:collector` 冒烟验证。