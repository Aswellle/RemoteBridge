'use client';

import { toast } from 'sonner';
import type { RespDownloadReadyPayload, RespDownloadErrorPayload } from '@remotebridge/shared';
import { useAppStore } from '@/store/app-store';
import { RELAY_API_URL as RELAY_API_BASE } from './env';

/**
 * 下载响应的全局唯一处理器，由 useWebSocket 的共享消息循环调用。
 *
 * RESP_DOWNLOAD_* 必须且只能在这里消费：多处监听会导致同一响应触发多次下载，
 * 且 Host 返回的 downloadUrl 是它本机文件服务器的 127.0.0.1 地址，
 * 任何绕过代理改写直接使用该地址的路径在远程访问时都会失败。
 * 链路：store.requestDownload 发请求 → 这里消费响应并回写进度 → DownloadPanel 纯展示。
 */

// ===== RESP_DOWNLOAD_READY =====
export async function handleDownloadReady(payload: RespDownloadReadyPayload): Promise<void> {
  const store = useAppStore.getState();
  const download = store.activeDownloads.find((d) => d.id === payload.requestId);
  // 不是本标签页发起的请求（或已被清理）——忽略
  if (!download) return;

  const fileName = payload.fileName || download.fileName;
  store.updateDownload(download.id, {
    fileName,
    fileSize: payload.fileSize || 0,
    status: 'downloading',
  });

  // Host 返回的是它本机文件服务器的地址（127.0.0.1）。浏览器与 Host 不在同一台
  // 机器时该地址不可达，必须改走 Relay 代理（代理会向 Host 转发并流式传回）。
  const isHostLocalUrl = /127\.0\.0\.1|localhost/.test(payload.downloadUrl);

  try {
    if (isHostLocalUrl) {
      const { sessionId, accessToken } = store;
      const proxyUrl = `${RELAY_API_BASE}/proxy/download/${sessionId}?filePath=${encodeURIComponent(download.filePath)}`;
      store.updateDownload(download.id, { downloadUrl: proxyUrl });
      // 代理端点要求 Authorization 头，<a download> 带不了 —— 用 fetch 流式下载，
      // 顺便拿到真实进度（之前的进度条是定时器模拟出来的假数据）
      await streamDownload(proxyUrl, fileName, accessToken, payload.fileSize || 0, download.id);
    } else {
      // 直连可达的 URL（同机部署等场景）：交给浏览器原生下载
      store.updateDownload(download.id, { downloadUrl: payload.downloadUrl });
      anchorDownload(payload.downloadUrl, fileName);
    }

    useAppStore.getState().updateDownload(download.id, {
      status: 'completed',
      progress: 100,
      eta: 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useAppStore.getState().updateDownload(download.id, { status: 'error', error: message });
    toast.error(`下载失败: ${fileName}`, { description: message });
  }
}

// ===== RESP_DOWNLOAD_ERROR =====
export function handleDownloadError(payload: RespDownloadErrorPayload): void {
  const store = useAppStore.getState();
  const download = store.activeDownloads.find((d) => d.id === payload.requestId);
  if (!download) return;

  const message = payload.message || '下载请求失败';
  store.updateDownload(download.id, { status: 'error', error: message });
  toast.error(`下载失败: ${download.fileName}`, { description: message });
}

// ===== 流式下载（带进度统计） =====
async function streamDownload(
  url: string,
  fileName: string,
  accessToken: string | null,
  expectedSize: number,
  downloadId: string,
): Promise<void> {
  const token = accessToken ||
    (typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null);

  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const totalSize = Number(response.headers.get('content-length')) || expectedSize || 0;
  if (totalSize > 0) {
    useAppStore.getState().updateDownload(downloadId, { fileSize: totalSize });
  }

  // 无 body reader（极旧浏览器）时退化为一次性 blob
  if (!response.body) {
    const blob = await response.blob();
    saveBlob(blob, fileName);
    return;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const startedAt = performance.now();
  let lastUpdate = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;

    // 节流：每 200ms 回写一次进度，避免高频 setState
    const now = performance.now();
    if (now - lastUpdate > 200) {
      lastUpdate = now;
      const elapsed = (now - startedAt) / 1000;
      const speed = elapsed > 0 ? received / elapsed : 0;
      const progress = totalSize > 0 ? Math.min(99, Math.round((received / totalSize) * 100)) : 0;
      const eta = speed > 0 && totalSize > received ? Math.ceil((totalSize - received) / speed) : 0;
      useAppStore.getState().updateDownload(downloadId, { progress, speed, eta });
    }
  }

  saveBlob(new Blob(chunks as BlobPart[]), fileName);
}

// ===== 触发浏览器保存 =====
function saveBlob(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  anchorDownload(blobUrl, fileName);
  // 延迟释放，给浏览器留出启动保存的时间
  setTimeout(() => URL.revokeObjectURL(blobUrl), 300000);
}

function anchorDownload(url: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
  }, 1000);
}
