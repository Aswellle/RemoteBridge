'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  WSMessageType,
  WSMessage,
  decodeFileChunkFrame,
  type FileChunkFrameMeta,
} from '@remotebridge/shared';
import { useAppStore } from '@/store/app-store';
import { RELAY_WS_URL } from '@/lib/env';

/**
 * 独立预览页的文件流式获取 Hook。
 * 通过 WS → relay → host 下载文件二进制，组装为 Blob 后返回 object URL。
 */
export function useFileStream(filePath: string | null) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const chunksRef = useRef<Map<number, Uint8Array>>(new Map());
  const totalSizeRef = useRef<number>(0);
  const inFlightRef = useRef<Set<string>>(new Set());
  const blobUrlRef = useRef<string | null>(null);

  // 清理：关闭 WS + 释放 blob URL 防止内存泄漏
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'cleanup');
        wsRef.current = null;
      }
    };
  }, []);

  const fetchFile = useCallback(async () => {
    if (!filePath) return;

    // 防止 StrictMode 并发双重调用（仅保护同一次渲染周期内的重入）
    const key = filePath;
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);

    setLoading(true);
    setError(null);
    setProgress(0);
    chunksRef.current.clear();
    totalSizeRef.current = 0;
    // 失败时移除标记，允许用户重试
    const cleanup = () => inFlightRef.current.delete(key);

    const { sessionId } = useAppStore.getState();
    if (!sessionId) {
      setError('未连接');
      setLoading(false);
      cleanup();
      return;
    }
    try {
      // 1. 获取 WS 票据
      const ticketRes = await fetch('/auth/ws-ticket', { credentials: 'include' });
      if (!ticketRes.ok) throw new Error('获取连接票据失败');
      const ticketData = await ticketRes.json();
      if (!ticketData.success) throw new Error(ticketData.error?.message || '获取票据失败');
      const ticket = ticketData.data?.ticket ?? ticketData.data?.ticket;
      if (!ticket) throw new Error('票据为空');

      // 2. 建立 WS 连接
      const ws = new WebSocket(`${RELAY_WS_URL}?ticket=${encodeURIComponent(ticket)}&type=client`);
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('连接超时')), 10000);
        ws.onopen = () => { clearTimeout(timeout); resolve(); };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('连接失败')); };
      });

      // 3. 请求下载
      const requestId = crypto.randomUUID();
      const msg: WSMessage = {
        id: crypto.randomUUID(),
        type: WSMessageType.CMD_REQUEST_DOWNLOAD,
        payload: { filePath, requestId },
        timestamp: Date.now(),
        sessionId: sessionId || undefined,
      };
      ws.send(JSON.stringify(msg));

      // 4. 等待数据就绪 + 接收分块
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('下载超时')), 60000);

        ws.onmessage = (evt) => {
          // 二进制帧
          if (evt.data instanceof Blob) {
            evt.data.arrayBuffer().then((buf) => {
              try {
                const decoded = decodeFileChunkFrame(Buffer.from(buf));
                if (decoded.data && decoded.data.length > 0) {
                  chunksRef.current.set(decoded.seq, decoded.data);
                  if (decoded.totalSize) {
                    totalSizeRef.current = decoded.totalSize;
                  }
                  const received = Array.from(chunksRef.current.values())
                    .reduce((sum, c) => sum + c.length, 0);
                  const ts = decoded.totalSize || totalSizeRef.current;
                  if (ts) {
                    setProgress(Math.min(Math.round((received / ts) * 100), 99));
                  }
                }
                if (decoded.eof) {
                  clearTimeout(timeout);
                  assembleAndResolve(resolve);
                }
              } catch (e) {
                clearTimeout(timeout);
                reject(e);
              }
            });
            return;
          }

          // JSON 消息
          try {
            const resp = JSON.parse(evt.data);
            if (resp.type === WSMessageType.RESP_DOWNLOAD_ERROR) {
              clearTimeout(timeout);
              reject(new Error(resp.payload?.message || '下载失败'));
            }
          } catch { /* ignore */ }
        };

        const assembleAndResolve = (res: () => void) => {
          const chunks = chunksRef.current;
          if (chunks.size === 0) { res(); return; }

          // 按 seq 排序组装
          const sorted = Array.from(chunks.entries()).sort((a, b) => a[0] - b[0]);
          const totalLen = sorted.reduce((s, [, c]) => s + c.length, 0);
          const assembled = new Uint8Array(totalLen);
          let offset = 0;
          for (const [, chunk] of sorted) {
            assembled.set(chunk, offset);
            offset += chunk.length;
          }
          const blob = new Blob([assembled]);
          // 释放旧 blob URL 后创建新 URL（防止内存泄漏）
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          setBlobUrl(url);
        };
      });

      ws.close(1000, 'done');
      wsRef.current = null;
      cleanup(); // 成功完成，移除飞行标记
    } catch (err: any) {
      setError(err.message || '下载失败');
      setLoading(false);
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      cleanup(); // 失败也移除标记，允许重试
    }
  }, [filePath]);

  return { blobUrl, loading, error, progress, fetchFile };
}
