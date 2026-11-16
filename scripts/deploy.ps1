# Cloudflare Pages 部署脚本
# 项目名称: tokenmetrology

$ProjectName = "tokenmetrology"
$FrontendDir = "frontend"

Write-Host "🚀 正在开始部署到 Cloudflare Pages..." -ForegroundColor Cyan

# 检查是否安装了 wrangler
if (!(Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Host "❌ 错误: 未找到 npx，请确保已安装 Node.js" -ForegroundColor Red
    exit 1
}

# 执行部署命令
# 如果在 CI 环境或遇到权限问题，可以手动设置 $env:CLOUDFLARE_API_TOKEN
npx wrangler pages deploy $FrontendDir --project-name $ProjectName

if ($LASTEXITCODE -eq 0) {
    Write-Host "✨ 部署成功！" -ForegroundColor Green
    Write-Host "🔗 访问地址: https://$ProjectName.pages.dev" -ForegroundColor Blue
} else {
    Write-Host "❌ 部署失败，请检查错误日志或运行 'npx wrangler login' 重新登录" -ForegroundColor Red
}
