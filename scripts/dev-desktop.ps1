# RemoteBridge Desktop 开发启动脚本
# Electron 28 和 Node.js 22 需要不同版本的 better-sqlite3
# 此脚本在启动 Desktop 前重建 native 模块为 Electron 版本

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\..\apps\desktop"

Write-Host "🔧 为 Electron 重建 better-sqlite3..."
npx electron-rebuild -f -w better-sqlite3 2>&1 | Select-String -Pattern "Rebuild Complete|error|Error" -NotMatch | Out-Null

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ better-sqlite3 重建失败" -ForegroundColor Red
    exit 1
}
Write-Host "✅ better-sqlite3 已适配 Electron" -ForegroundColor Green

Write-Host "🚀 启动 Desktop..."
pnpm dev
