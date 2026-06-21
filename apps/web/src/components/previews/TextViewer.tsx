'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, Hash, WrapText, ZoomIn, ZoomOut } from 'lucide-react';

interface TextViewerProps {
  url: string;
  fileName: string;
}

// 用户可切换的编码；TextDecoder 接受这些标准名称
type TextEncoding = 'utf-8' | 'gbk' | 'utf-16le';

const ENCODING_OPTIONS: { value: TextEncoding; label: string }[] = [
  { value: 'utf-8',    label: 'UTF-8'        },
  { value: 'gbk',      label: 'GBK / GB2312' },
  { value: 'utf-16le', label: 'UTF-16'        },
];

// 读取 BOM，返回推断编码和跳过的字节数
function detectBom(bytes: Uint8Array): { encoding: TextEncoding | 'utf-16be'; skip: number } {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { encoding: 'utf-8',    skip: 3 };
  if (bytes[0] === 0xFF && bytes[1] === 0xFE)                        return { encoding: 'utf-16le', skip: 2 };
  if (bytes[0] === 0xFE && bytes[1] === 0xFF)                        return { encoding: 'utf-16be', skip: 2 };
  return { encoding: 'utf-8', skip: 0 };
}

function decode(bytes: Uint8Array, enc: TextEncoding | 'utf-16be'): string {
  try {
    return new TextDecoder(enc, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

export default function TextViewer({ url, fileName }: TextViewerProps) {
  // 原始字节（BOM 已剥离）
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(null);
  // 自动检测到的编码（含 utf-16be，不在选择器里）
  const [detectedEnc, setDetectedEnc] = useState<TextEncoding | 'utf-16be'>('utf-8');
  // 用户手动选择的编码（选择器仅显示三项，BOM 强制命中时自动设为最近值）
  const [encoding, setEncoding] = useState<TextEncoding>('utf-8');

  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lineCount, setLineCount] = useState(0);
  const [wordWrap, setWordWrap] = useState(true);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [fontSize, setFontSize] = useState(14);
  const preRef = useRef<HTMLPreElement>(null);

  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  // 首次加载：读 ArrayBuffer，BOM 检测，初次解码
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const res = await fetch(url);
        if (!res.ok) throw new Error('加载失败');
        const buf = await res.arrayBuffer();
        const all = new Uint8Array(buf);
        const { encoding: det, skip } = detectBom(all);
        const body = all.subarray(skip);
        if (!cancelled) {
          setDetectedEnc(det);
          // utf-16be 不在选择器中，用 utf-16le 作为近似显示（内容已正确解码存 content）
          setEncoding(det === 'utf-16be' ? 'utf-16le' : det);
          setRawBytes(body);
          const text = decode(body, det);
          setContent(text);
          setLineCount(text.split('\n').length);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [url]);

  // 用户手动切换编码时重新解码（跳过初次加载，rawBytes 为 null 时不触发）
  useEffect(() => {
    if (!rawBytes) return;
    // 如果与自动检测一致则无需重新解码（初次已解码）
    const effEnc: TextEncoding | 'utf-16be' = encoding;
    if (effEnc === detectedEnc) return;
    const text = decode(rawBytes, effEnc);
    setContent(text);
    setLineCount(text.split('\n').length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoding]);

  const handleZoomIn  = () => setFontSize(p => Math.min(p + 2, 28));
  const handleZoomOut = () => setFontSize(p => Math.max(p - 2, 10));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <Loader2 className="animate-spin h-8 w-8 text-primary mx-auto mb-3" />
          <p className="text-muted-foreground">正在加载文件...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-96 text-destructive">
        <p>加载失败: {error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 bg-card border-b border-border">
        <div className="flex items-center space-x-3">
          <span className="text-sm text-muted-foreground">{lineCount} 行</span>
          <div className="w-px h-4 bg-secondary" />
          <button
            onClick={() => setShowLineNumbers(v => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${showLineNumbers ? 'bg-primary text-white' : 'bg-secondary text-foreground'}`}
          >
            <Hash className="w-3 h-3" />
            行号
          </button>
          <button
            onClick={() => setWordWrap(v => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${wordWrap ? 'bg-primary text-white' : 'bg-secondary text-foreground'}`}
          >
            <WrapText className="w-3 h-3" />
            自动换行
          </button>
          {/* 编码选择器：GBK 用于 Windows ANSI/记事本传统编码，UTF-16 用于 Windows Unicode */}
          <select
            value={encoding}
            onChange={e => setEncoding(e.target.value as TextEncoding)}
            className="text-xs px-2 py-1 bg-secondary text-foreground rounded cursor-pointer border-0 outline-none"
            title="切换文件编码"
          >
            {ENCODING_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center space-x-2">
          <button onClick={handleZoomOut} className="p-1 hover:bg-secondary rounded" title="缩小字体">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-muted-foreground">{fontSize}px</span>
          <button onClick={handleZoomIn} className="p-1 hover:bg-secondary rounded" title="放大字体">
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 代码区 */}
      <div className="flex-1 overflow-auto bg-background">
        <div className="flex">
          {showLineNumbers && (
            <div className="flex-shrink-0 text-right pr-4 py-4 select-none border-r border-border bg-background/50">
              {Array.from({ length: lineCount }, (_, i) => (
                <div
                  key={i + 1}
                  className="text-muted-foreground leading-6"
                  style={{ fontSize: `${fontSize}px`, fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace' }}
                >
                  {i + 1}
                </div>
              ))}
            </div>
          )}
          <pre
            ref={preRef}
            className="flex-1 p-4 overflow-x-auto"
            style={{
              fontSize: `${fontSize}px`,
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
              whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
              wordBreak: wordWrap ? 'break-all' : 'normal',
              tabSize: 2,
            }}
          >
            <code className="text-foreground leading-6">{content}</code>
          </pre>
        </div>
      </div>

      {/* 底部信息栏 */}
      <div className="px-4 py-2 bg-card border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span>{fileName} · {ext.toUpperCase()}</span>
        <span>{content.length.toLocaleString()} 字符</span>
      </div>
    </div>
  );
}
