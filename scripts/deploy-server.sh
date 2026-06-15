#!/bin/bash
# RemoteBridge 服务器部署脚本（仅构建产物，不直接前台运行）
#
# 生产环境的进程守护（崩溃自动重启）由 systemd 或 docker compose 负责：
#   - 裸机部署：参考 deploy/systemd/remotebridge-server.service
#       sudo cp deploy/systemd/remotebridge-server.service /etc/systemd/system/
#       sudo systemctl daemon-reload && sudo systemctl enable --now remotebridge-server
#   - 容器部署：docker compose up -d --build（见根目录 docker-compose.yml，
#       已包含 TLS 反向代理 Caddy）

set -e

echo "🚀 部署 RemoteBridge Relay Server..."

# 构建（shared 是 server 的依赖，需先构建）
echo "🔨 构建 shared..."
pnpm --filter @remotebridge/shared build

echo "🔨 构建服务器..."
pnpm --filter @remotebridge/server build

# 创建数据目录
mkdir -p data

echo "✅ 构建完成。请通过 systemd 或 docker compose 启动服务（见脚本头部说明）。"
echo "   如需手动临时运行（无自动重启）：cd apps/server && NODE_ENV=production node dist/index.js"
