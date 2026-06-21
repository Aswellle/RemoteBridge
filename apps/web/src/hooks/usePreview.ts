'use client';

import { useState, useCallback, useRef } from 'react';
import { WSMessageType, type RespPreviewReadyPayload, type RespPreviewErrorPayload } from '@remotebridge/shared';
import { useAppStore } from '@/store/app-store';
import { RELAY_API_URL as RELAY_API_BASE } from '@/lib/env';

// ===== 预览状态 =====
interface PreviewState {
  previewUrl: string | null;
  // 文本文件直接保存原始字节（避免 blob URL 在 StrictMode 二次 effect 时被吊销导致
  // TextViewer fetch 失败）；非文本文件仍用 blob URL（ImageViewer/PdfViewer 需要 URL）
  rawBytes: Uint8Array | null;
  fileName: string;
  fileSize: number;
  extension: string;
  category: 'image' | 'text' | 'pdf' | 'unknown';
  expiresAt: number;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: PreviewState = {
  previewUrl: null,
  rawBytes: null,
  fileName: '',
  fileSize: 0,
  extension: '',
  category: 'unknown',
  expiresAt: 0,
  loading: false,
  error: null,
};

// ===== usePreview Hook =====
export function usePreview() {
  const { wsInstance, sessionId, accessToken } = useAppStore();
  const [previewState, setPreviewState] = useState<PreviewState>(INITIAL_STATE);

  const currentRequestIdRef = useRef<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const revokeBlobUrl = () => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  };

  const requestPreview = useCallback((filePath: string) => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    try {
      if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
        currentRequestIdRef.current = null;
        setPreviewState(prev => ({ ...prev, loading: false, error: 'WebSocket 未连接' }));
        return;
      }

      const requestId = crypto.randomUUID();
      currentRequestIdRef.current = requestId;

      revokeBlobUrl();
      setPreviewState({ ...INITIAL_STATE, loading: true });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        clearTimeout(timeoutId);
        wsInstance.removeEventListener('message', handleMessage);
        if (cleanupRef.current === cleanup) cleanupRef.current = null;
      };

      const handleMessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data);
          if (message.payload?.requestId !== requestId) return;

          if (message.type === WSMessageType.RESP_PREVIEW_READY) {
            const payload = message.payload as RespPreviewReadyPayload;
            cleanup();

            const needsProxy = payload.previewUrl.includes('127.0.0.1') ||
              payload.previewUrl.includes('localhost');

            // 非代理路径（直连可达）：直接使用 Host 返回的 URL
            if (!needsProxy) {
              if (currentRequestIdRef.current !== requestId) return;
              setPreviewState({
                previewUrl: payload.previewUrl,
                rawBytes: null,
                fileName: payload.fileName,
                fileSize: payload.fileSize,
                extension: payload.extension,
                category: payload.category,
                expiresAt: payload.expiresAt,
                loading: false,
                error: null,
              });
              return;
            }

            const proxyUrl = `${RELAY_API_BASE}/proxy/preview/${sessionId}?filePath=${encodeURIComponent(filePath)}`;
            const token = accessToken || localStorage.getItem('accessToken') || '';

            fetch(proxyUrl, { headers: { Authorization: `Bearer ${token}` } })
              .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.blob();
              })
              .then(async blob => {
                if (currentRequestIdRef.current !== requestId) return;

                if (payload.category === 'text') {
                  // 文本文件：直接读取原始字节，不创建 blob URL。
                  // 这样 TextViewer 无需二次 fetch blob URL（在 React StrictMode dev 模式下，
                  // StrictMode 的 effect 双重触发会在第二次 effect 运行前吊销 blob URL，
                  // 导致 TextViewer 的 fetch 抛出 "TypeError: Failed to fetch"）。
                  const buf = await blob.arrayBuffer();
                  if (currentRequestIdRef.current !== requestId) return;
                  setPreviewState({
                    previewUrl: null,
                    rawBytes: new Uint8Array(buf),
                    fileName: payload.fileName,
                    fileSize: payload.fileSize,
                    extension: payload.extension,
                    category: 'text',
                    expiresAt: payload.expiresAt,
                    loading: false,
                    error: null,
                  });
                } else {
                  // 图片 / PDF：使用 blob URL（ImageViewer / PDF 新标签打开均需要 URL）
                  const blobUrl = URL.createObjectURL(blob);
                  blobUrlRef.current = blobUrl;
                  if (currentRequestIdRef.current !== requestId) {
                    URL.revokeObjectURL(blobUrl);
                    blobUrlRef.current = null;
                    return;
                  }
                  setPreviewState({
                    previewUrl: blobUrl,
                    rawBytes: null,
                    fileName: payload.fileName,
                    fileSize: payload.fileSize,
                    extension: payload.extension,
                    category: payload.category,
                    expiresAt: payload.expiresAt,
                    loading: false,
                    error: null,
                  });
                }
              })
              .catch(err => {
                if (currentRequestIdRef.current !== requestId) return;
                setPreviewState(prev => ({
                  ...prev,
                  loading: false,
                  error: `加载预览内容失败: ${err.message || err}`,
                }));
              });

          } else if (message.type === WSMessageType.RESP_PREVIEW_ERROR) {
            if (currentRequestIdRef.current !== requestId) return;
            const payload = message.payload as RespPreviewErrorPayload;
            setPreviewState(prev => ({
              ...prev,
              loading: false,
              error: payload.message || '预览请求失败',
            }));
            cleanup();
          }
        } catch {
          // 忽略非 JSON 消息（二进制帧等）
        }
      };

      wsInstance.addEventListener('message', handleMessage);
      cleanupRef.current = cleanup;

      wsInstance.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: WSMessageType.CMD_REQUEST_PREVIEW,
        payload: { filePath, requestId },
        timestamp: Date.now(),
        sessionId,
      }));

      timeoutId = setTimeout(() => {
        if (currentRequestIdRef.current === requestId) {
          setPreviewState(prev => ({ ...prev, loading: false, error: '预览请求超时' }));
        }
        cleanup();
      }, 15000);

    } catch (err) {
      currentRequestIdRef.current = null;
      setPreviewState(prev => ({ ...prev, loading: false, error: `预览请求异常: ${String(err)}` }));
    }
  }, [wsInstance, sessionId, accessToken]);

  const clearPreview = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    currentRequestIdRef.current = null;
    revokeBlobUrl();
    setPreviewState(INITIAL_STATE);
  }, []);

  return {
    ...previewState,
    requestPreview,
    clearPreview,
  };
}
