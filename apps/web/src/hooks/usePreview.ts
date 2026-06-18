'use client';

import { useState, useCallback, useRef } from 'react';
import { WSMessageType, type RespPreviewReadyPayload, type RespPreviewErrorPayload } from '@remotebridge/shared';
import { useAppStore } from '@/store/app-store';
import { RELAY_API_URL as RELAY_API_BASE } from '@/lib/env';

// ===== 预览状态 =====
interface PreviewState {
  previewUrl: string | null;
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
  fileName: '',
  fileSize: 0,
  extension: '',
  category: 'unknown',
  expiresAt: 0,
  loading: false,
  error: null,
};

// ===== usePreview Hook =====
// 发送 CMD_REQUEST_PREVIEW，监听 RESP_PREVIEW_READY/RESP_PREVIEW_ERROR
// 返回预览 URL 和状态
export function usePreview() {
  const { wsInstance, sessionId, accessToken } = useAppStore();
  const [previewState, setPreviewState] = useState<PreviewState>(INITIAL_STATE);

  // 使用 ref 追踪当前请求 ID，防止旧响应污染
  const currentRequestIdRef = useRef<string | null>(null);
  // 已创建的 blob URL，清理时必须 revoke 防内存泄漏
  const blobUrlRef = useRef<string | null>(null);
  // 上一个未完成请求的清理函数（移除监听器 + 清除超时）。切换文件或卸载时调用，
  // 避免监听器堆积，并防止其迟到的响应覆盖新请求的状态。
  const cleanupRef = useRef<(() => void) | null>(null);

  const revokeBlobUrl = () => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  };

  // 请求预览
  const requestPreview = useCallback((filePath: string) => {
    // 取消上一个未完成请求的监听器和超时
    cleanupRef.current?.();
    cleanupRef.current = null;

    try {
      if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
        currentRequestIdRef.current = null;
        setPreviewState(prev => ({
          ...prev,
          loading: false,
          error: 'WebSocket 未连接',
        }));
        return;
      }

      const requestId = crypto.randomUUID();
      currentRequestIdRef.current = requestId;

      // 重置状态为加载中
      revokeBlobUrl();
      setPreviewState({ ...INITIAL_STATE, loading: true });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        clearTimeout(timeoutId);
        wsInstance.removeEventListener('message', handleMessage);
        if (cleanupRef.current === cleanup) cleanupRef.current = null;
      };

      // 监听响应消息
      const handleMessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data);

          // 忽略非当前请求的响应
          if (message.payload?.requestId !== requestId) return;

          if (message.type === WSMessageType.RESP_PREVIEW_READY) {
            const payload = message.payload as RespPreviewReadyPayload;
            // 清理监听（异步加载前就可以摘掉了）
            cleanup();

            // Host 返回它本机的 127.0.0.1 地址，浏览器与 Host 不同机时不可达，
            // 改走 Relay 代理。代理要求 Authorization 头，而 <img>/<iframe> 这类
            // src 加载带不了请求头 —— 必须 fetch 成 blob 再交给查看器。
            const needsProxy = payload.previewUrl.includes('127.0.0.1') ||
              payload.previewUrl.includes('localhost');

            const applyReady = (url: string) => {
              // 异步加载期间用户可能已切换到新的预览请求
              if (currentRequestIdRef.current !== requestId) return;
              setPreviewState({
                previewUrl: url,
                fileName: payload.fileName,
                fileSize: payload.fileSize,
                extension: payload.extension,
                category: payload.category,
                expiresAt: payload.expiresAt,
                loading: false,
                error: null,
              });
            };

            if (!needsProxy) {
              applyReady(payload.previewUrl);
              return;
            }

            const proxyUrl = `${RELAY_API_BASE}/proxy/preview/${sessionId}?filePath=${encodeURIComponent(filePath)}`;
            const token = accessToken || localStorage.getItem('accessToken') || '';
            fetch(proxyUrl, { headers: { Authorization: `Bearer ${token}` } })
              .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.blob();
              })
              .then(blob => {
                // 异步期间已切换到新请求：丢弃该 blob，避免遗留未 revoke 的对象 URL
                if (currentRequestIdRef.current !== requestId) return;
                const blobUrl = URL.createObjectURL(blob);
                blobUrlRef.current = blobUrl;
                applyReady(blobUrl);
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
            // 忽略已被新请求取代的过期错误响应（与上方 ready 分支的守卫保持一致）
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
          // 忽略非 JSON 消息
        }
      };

      wsInstance.addEventListener('message', handleMessage);
      cleanupRef.current = cleanup;

      // 发送预览请求
      wsInstance.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: WSMessageType.CMD_REQUEST_PREVIEW,
        payload: {
          filePath,
          requestId,
        },
        timestamp: Date.now(),
        sessionId,
      }));

      // 超时处理（15 秒）
      timeoutId = setTimeout(() => {
        if (currentRequestIdRef.current === requestId) {
          setPreviewState(prev => ({
            ...prev,
            loading: false,
            error: '预览请求超时',
          }));
        }
        cleanup();
      }, 15000);
    } catch (err) {
      currentRequestIdRef.current = null;
      setPreviewState(prev => ({
        ...prev,
        loading: false,
        error: `预览请求异常: ${String(err)}`,
      }));
    }
  }, [wsInstance, sessionId, accessToken]);

  // 清除预览状态
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
