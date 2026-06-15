#!/bin/bash
# RemoteBridge 项目初始化脚本

set -e

echo "🚀 初始化 RemoteBridge 项目..."

# 检查 pnpm 是否安装
if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm 未安装，正在安装..."
    npm install -g pnpm
fi

# 安装依赖
echo "📦 安装依赖..."
pnpm install

# 构建共享包
echo "🔨 构建 shared 包..."
pnpm --filter @remotebridge/shared build

echo "✅ 初始化完成！"
echo ""
echo "可用命令："
echo "  pnpm dev          - 启动所有服务（开发模式）"
echo "  pnpm build        - 构建所有包"
echo "  pnpm lint         - 代码检查"
