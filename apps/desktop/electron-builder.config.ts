import type { Config } from 'electron-builder';

const config: Config = {
  appId: 'com.remotebridge.desktop',
  productName: 'RemoteBridge',
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: [
    'dist/**/*',
  ],

  // ===== 发布渠道：GitHub Releases =====
  // GITHUB_REPOSITORY_OWNER / GITHUB_REPOSITORY_NAME 由 CI 环境变量注入；
  // 本地打包时需手动设置，或直接填写实际用户名/仓库名。
  // electron-updater 通过 GitHub Releases 的 latest.yml / latest-mac.yml /
  // latest-linux.yml 元数据文件发现并下载更新。
  publish: [
    {
      provider: 'github',
      owner: process.env.GITHUB_REPOSITORY_OWNER ?? 'YOUR_GITHUB_USERNAME',
      repo: process.env.GITHUB_REPOSITORY_NAME ?? 'remotebridge',
      releaseType: 'release',
    },
  ],

  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    icon: 'resources/icon.ico',
    // 代码签名：在 CI 中设置 CSC_LINK（.p12 Base64）和 CSC_KEY_PASSWORD 环境变量。
    // 本地开发可留空（unsigned build 在 Windows 会触发 SmartScreen 警告）。
    // certificateSubjectName 留给 electron-builder 从 CSC_LINK 中自动提取。
  },
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64'],
      },
    ],
    icon: 'resources/icon.icns',
    // 代码签名 + Notarization：在 CI 中设置：
    //   CSC_LINK（.p12 Base64）、CSC_KEY_PASSWORD、
    //   APPLE_ID、APPLE_APP_SPECIFIC_PASSWORD、APPLE_TEAM_ID
    // notarize: true 需要 electron-builder >= 24.9 且 Xcode Command Line Tools。
  },
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['x64'],
      },
    ],
    icon: 'resources/icon.png',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
};

export default config;
