const path = require('path');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.remotebridge.desktop',
  productName: 'RemoteBridge',
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: [
    'dist/**/*',
  ],

  // dlopen hook (electron-binding.ts) 重定向加载 .cache/ 中的 Electron 预编译二进制，
  // 无需 electron-builder 再次 rebuild。
  npmRebuild: false,

  // 打包后 __dirname 从 app.asar/dist/main 向上遍历跨越 ASAR 边界到 resources/，
  // 此处将 .cache/better_sqlite3.electron.node 放入 resources/.cache/ 供 hook 找到。
  extraResources: [
    {
      // 绝对路径：避免 electron-builder 不跟随 ../../ 相对路径到项目目录之外
      from: path.resolve(__dirname, '..', '..', '.cache', 'better_sqlite3.electron.node'),
      to: '.cache/better_sqlite3.electron.node',
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
  },
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64'],
      },
    ],
    icon: 'resources/icon.icns',
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
