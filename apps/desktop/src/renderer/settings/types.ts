/** Settings 页面共享类型与常量 */

export interface SettingsData {
  relayUrl: string;
  relayApiUrl: string;
  autoStart: boolean;
  minimizeToTray: boolean;
  theme: 'light' | 'dark';
}

export interface UploadPaths {
  images: string;
  videos: string;
  documents: string;
  archives: string;
  markdown: string;
}

export const CATEGORY_LABELS: Record<keyof UploadPaths, string> = {
  images: '图片',
  videos: '视频',
  documents: '文档',
  archives: '压缩包',
  markdown: 'Markdown',
};

export interface SysInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
  osVersion: string;
  platform: string;
  hostname: string;
}

export type LocalRelayState = 'stopped' | 'starting' | 'running' | 'error';

export interface LocalRelayStatus {
  status: LocalRelayState;
  error?: string;
  logs: string[];
}

export interface LocalRelayConfig {
  port: number;
  autoStart: boolean;
}

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'connection'
  | 'localRelay'
  | 'fileHandling'
  | 'about';

export interface NavItem {
  id: SettingsSectionId;
  label: string;
}
