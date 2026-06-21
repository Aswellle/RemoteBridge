'use client';

import { useState, useEffect, useRef } from 'react';
import { Loader2, Hash, WrapText, ZoomIn, ZoomOut } from 'lucide-react';

interface TextViewerProps {
  // 原始文件字节（BOM 未剥离），由 usePreview 直接传入，无需二次 fetch blob URL
  rawBytes: Uint8Array;
  fileName: string;
}

type TextEncoding = 'utf-8' | 'gbk' | 'utf-16le';

const ENCODING_OPTIONS: { value: TextEncoding; label: string }[] = [
  { value: 'utf-8',    label: 'UTF-8'        },
  { value: 'gbk',      label: 'GBK / GB2312' },
  { value: 'utf-16le', label: 'UTF-16'        },
];

// 从 BOM 字节推断编码，返回编码名和应跳过的 BOM 字节数
function detectBom(bytes: Uint8Array): { enc: string; skip: number } {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { enc: 'utf-8',    skip: 3 };
  if (bytes[0] === 0xFF && bytes[1] === 0xFE)                        return { enc: 'utf-16le', skip: 2 };
  if (bytes[0] === 0xFE && bytes[1] === 0xFF)                        return { enc: 'utf-16be', skip: 2 };
  return { enc: 'utf-8', skip: 0 };
}

function decodeBytes(bytes: Uint8Array, enc: string): string {
  try {
    return new TextDecoder(enc, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

export default function TextViewer({ rawBytes, fileName }: TextViewerProps) {
  const [content, setContent]             = useState('');
  const [encoding, setEncoding]           = useState<TextEncoding>('utf-8');
  const [bodyBytes, setBodyBytes]         = useState<Uint8Array | null>(null); // BOM 已剥离
  const [lineCount, setLineCount]         = useState(0);
  const [wordWrap, setWordWrap]           = useState(true);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [fontSize, setFontSize]           = useState(14);
  const preRef = useRef<HTMLPreElement>(null);

  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  // rawBytes 变化时：BOM 检测 + 初次解码
  useEffect(() => {
    if (!rawBytes) return;
    const { enc, skip } = detectBom(rawBytes);
    const body = rawBytes.subarray(skip);
    // utf-16be 无对应选择器项，映射到 utf-16le 显示（已用正确解码器解码）
    const displayEnc: TextEncoding = enc === 'utf-16be' ? 'utf-16le' : enc as TextEncoding;
    setEncoding(displayEnc);
    setBodyBytes(body);
    const text = decodeBytes(body, enc);
    setContent(text);
    setLineCount(text.split('\n').length);
  }, [rawBytes]);

  // 用户手动切换编码时重新解码（bodyBytes 未变，仅 encoding 变）
  useEffect(() => {
    if (!bodyBytes) return;
    const text = decodeBytes(bodyBytes, encoding);
    setContent(text);
    setLineCount(text.split('\n').length);
  // bodyBytes 变化由上面的 effect 处理（那里同时设置了 encoding），
  // 此 effect 只响应用户手动改 encoding，不需要把 bodyBytes 列为依赖
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoding]);

  const handleZoomIn  = () => setFontSize(p => Math.min(p + 2, 28));
  const handleZoomOut = () => setFontSize(p => Math.max(p - 2, 10));

  // rawBytes 为空时显示加载中（通常不会出现，因为父组件仅在 rawBytes 存在时渲染本组件）
  if (!rawBytes) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="animate-spin h-8 w-8 text-primary" />
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
          {/* 编码选择器：GBK 对应 Windows ANSI/记事本传统编码 */}
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
