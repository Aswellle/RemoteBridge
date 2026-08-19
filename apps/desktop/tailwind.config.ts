import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx,mdx}',
    // EVENT_TYPE_COLORS (P1-20) 的 Tailwind 类名字符串现位于此处
    '../../packages/shared/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive))' },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        border: 'hsl(var(--border))',
        ring: 'hsl(var(--ring))',
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"SF Pro Display"',
          '"Segoe UI Variable"', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial',
          '"Noto Sans"', '"Liberation Sans"', '"PingFang SC"', '"Microsoft YaHei"',
          '"Hiragino Sans GB"', '"WenQuanYi Micro Hei"', 'sans-serif',
          '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Noto Color Emoji"',
        ],
        mono: [
          '"SF Mono"', '"JetBrains Mono"', '"Fira Code"', '"Cascadia Code"',
          'ui-monospace', 'Menlo', 'Monaco', 'Consolas', '"Liberation Mono"',
          '"Courier New"', 'monospace',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
