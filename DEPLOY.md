# 部署指南

本项目前端部分托管于 **Cloudflare Pages**，项目名称为 `tokenmetrology`。

## 快速部署

在项目根目录下运行：

```powershell
npm run deploy
```

或者直接运行脚本：

```powershell
.\scripts\deploy.ps1
```

## 环境要求

1. **Node.js**: 确保已安装 Node.js 环境。
2. **Cloudflare 账号**: 需要有 Cloudflare 账号访问权限。
3. **Wrangler CLI**: 部署使用 `wrangler` 工具（已包含在依赖中）。

## 常见问题处理

### 1. 授权失效
如果部署失败并提示授权过期，请运行以下命令重新登录：

```bash
npx wrangler login
```

### 2. 非交互式环境部署 (CI/CD)
在自动化部署环境下，需要设置 `CLOUDFLARE_API_TOKEN` 环境变量。

### 3. 手动部署命令
如果需要手动指定项目名称部署：

```bash
npx wrangler pages deploy frontend --project-name tokenmetrology
```

---
*由 Token 计量办 自动化部署模块生成*
