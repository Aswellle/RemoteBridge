/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@remotebridge/shared'],
  // 输出独立部署包
  output: 'standalone',

  // ===== 安全响应头 (P1-10) =====
  // script-src/style-src 仍保留 'unsafe-inline'/'unsafe-eval'：Next.js 开发模式的
  // Fast Refresh 与 hydration 内联脚本依赖它们,收紧为基于 nonce 的 CSP 是后续工作。
  // connect-src 同理放宽到 http(s)/ws(s) 全集 —— Relay API/WS 地址通过
  // NEXT_PUBLIC_API_URL/NEXT_PUBLIC_WS_URL 配置,可指向任意域名/端口。
  // 重点是 object-src / frame-ancestors / frame-src / base-uri / form-action:
  // PDF 预览走 blob: iframe(见 PdfViewer.tsx 的 sandbox 属性),blob: 文档默认继承
  // 创建者文档的 CSP —— 这里的 script-src 同样会作用于该 iframe,与 sandbox
  // 共同防止"伪装成 .pdf 的 HTML/JS"以同源身份读取本应用的 localStorage。
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self' http: https: ws: wss:",
              "frame-src 'self' blob:",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
