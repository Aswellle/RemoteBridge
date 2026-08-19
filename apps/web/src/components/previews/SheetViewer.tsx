'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search,
  ChevronUp,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Download,
  AlertTriangle,
} from 'lucide-react';

const RENDER_ROW_LIMIT = 1000;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 0] as const; // 0 = All

type SortDir = 'asc' | 'desc';

interface SheetViewerProps {
  url: string;
  fileName: string;
  fileExt: string;
}

/* ------------------------------------------------------------------ */
/*  CSV / TSV parser – handles quoted fields, escaped quotes (""),    */
/*  and newlines inside quotes.                                        */
/* ------------------------------------------------------------------ */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    // not in quotes
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }

    if (ch === '\r') {
      // skip if part of \r\n
      if (text[i + 1] === '\n') {
        i++;
        continue;
      }
      // lone \r → treat as line break
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      continue;
    }

    field += ch;
 i++;
  }

  // flush remaining
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */
export default function SheetViewer({ url, fileName, fileExt }: SheetViewerProps) {
  /* ---------- fetch & parse ---------- */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [allRows, setAllRows] = useState<string[][]>([]);
  const [totalParsed, setTotalParsed] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Only CSV/TSV are supported client-side
        const ext = fileExt.toLowerCase();
        if (ext !== 'csv' && ext !== 'tsv') {
          throw new Error(
            `.${ext.toUpperCase()} 文件需要服务端解析，暂不支持客户端预览。请下载后查看。`,
          );
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error(`下载文件失败 (${res.status})`);

        const text = await res.text();

        if (cancelled) return;

        const delimiter = ext === 'tsv' ? '\t' : ',';
        const parsed = parseDelimited(text, delimiter);

        if (parsed.length === 0) {
          throw new Error('文件为空或格式无法识别');
        }

        const hdrs = parsed[0];
        const data = parsed.slice(1);

        setHeaders(hdrs);
        setAllRows(data);
        setTotalParsed(data.length);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : '解析文件时发生未知错误');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [url, fileExt]);

  /* ---------- search ---------- */
  const [query, setQuery] = useState('');

  const filteredRows = useMemo(() => {
    if (!query.trim()) return allRows;
    const q = query.toLowerCase();
    return allRows.filter((row) =>
      row.some((cell) => cell.toLowerCase().includes(q)),
    );
  }, [allRows, query]);

  /* ---------- sort ---------- */
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const handleSort = useCallback(
    (colIdx: number) => {
      if (sortCol === colIdx) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortCol(colIdx);
        setSortDir('asc');
      }
    },
    [sortCol],
  );

  const sortedRows = useMemo(() => {
    if (sortCol === null) return filteredRows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const va = a[sortCol] ?? '';
      const vb = b[sortCol] ?? '';
      // numeric sort when both look numeric
      const na = Number(va);
      const nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && va.trim() !== '' && vb.trim() !== '') {
        return (na - nb) * dir;
      }
      return va.localeCompare(vb) * dir;
    });
  }, [filteredRows, sortCol, sortDir]);

  /* ---------- pagination ---------- */
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState(1);

  // reset to page 1 when filter / sort / page-size changes
  useEffect(() => { setPage(1); }, [query, sortCol, sortDir, pageSize]);

  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(sortedRows.length / pageSize));

  const paginatedRows = useMemo(() => {
    if (pageSize === 0) return sortedRows;
    const start = (page - 1) * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, page, pageSize]);

  /* ---------- export ---------- */
  const handleExport = useCallback(() => {
    const delimiter = fileExt.toLowerCase() === 'tsv' ? '\t' : ',';
    const escape = (val: string) => {
      if (val.includes('"') || val.includes(delimiter) || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };
    const lines = [headers.map(escape).join(delimiter)];
    for (const row of sortedRows) {
      lines.push(row.map(escape).join(delimiter));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName.replace(/\.[^.]+$/, '') + '_export.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [sortedRows, headers, fileName, fileExt]);

  /* ---------- render ---------- */

  // loading
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center text-muted-foreground">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">正在解析文件…</p>
        </div>
      </div>
    );
  }

  // error
  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center text-muted-foreground max-w-md">
          <AlertTriangle className="w-12 h-12 mx-auto mb-3 text-destructive" />
          <p className="text-foreground font-medium mb-1">无法预览文件</p>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  const isCapped = totalParsed > RENDER_ROW_LIMIT;

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* ============ Top Bar ============ */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
        {/* filename */}
        <span className="text-sm font-medium truncate max-w-[200px]" title={fileName}>
          {fileName}
        </span>
        <span className="text-xs text-muted-foreground">
          {totalParsed.toLocaleString()} 行 · {headers.length} 列
        </span>

        {/* spacer */}
        <div className="flex-1" />

        {/* search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索…"
            className="pl-8 pr-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary w-48"
          />
        </div>

        {/* page size */}
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          className="text-sm px-2 py-1.5 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size === 0 ? '全部' : `${size} 行/页`}
            </option>
          ))}
        </select>

        {/* export */}
        <button
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors"
        >
          <Download className="w-4 h-4" />
          导出 CSV
        </button>
      </div>

      {/* ============ Capped Warning ============ */}
      {isCapped && (
        <div className="px-4 py-2 text-xs text-yellow-300 bg-yellow-500/10 border-b border-yellow-500/20 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
          文件较大，仅加载前 {RENDER_ROW_LIMIT.toLocaleString()} 行数据（共 {totalParsed.toLocaleString()} 行）。搜索和排序仅作用于已加载的数据。
        </div>
      )}

      {/* ============ Table ============ */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground border-b border-border w-12">
                #
              </th>
              {headers.map((hdr, idx) => {
                const isActive = sortCol === idx;
                return (
                  <th key={idx} className="px-3 py-2 text-left border-b border-border">
                    <button
                      onClick={() => handleSort(idx)}
                      className={`inline-flex items-center gap-1 text-xs font-medium truncate max-w-[180px] ${
                        isActive ? 'text-primary' : 'text-foreground hover:text-primary'
                      }`}
                      title={hdr}
                    >
                      <span className="truncate">{hdr}</span>
                      {isActive ? (
                        sortDir === 'asc' ? (
                          <ChevronUp className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                        )
                      ) : (
                        <ChevronUp className="w-3.5 h-3.5 shrink-0 opacity-30" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {paginatedRows.length === 0 ? (
              <tr>
                <td colSpan={headers.length + 1} className="text-center py-12 text-muted-foreground">
                  {query ? '没有匹配的行' : '文件无数据行'}
                </td>
              </tr>
            ) : (
              paginatedRows.map((row, rIdx) => {
                const globalIdx = pageSize === 0 ? rIdx : (page - 1) * pageSize + rIdx;
                return (
                  <tr
                    key={globalIdx}
                    className={globalIdx % 2 === 0 ? 'bg-background' : 'bg-muted/30'}
                  >
                    <td className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border select-none">
                      {globalIdx + 1}
                    </td>
                    {headers.map((_, cIdx) => (
                      <td
                        key={cIdx}
                        className="px-3 py-1.5 border-b border-border max-w-[320px] truncate"
                        title={row[cIdx] ?? ''}
                      >
                        {row[cIdx] ?? ''}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ============ Pagination Footer ============ */}
      {pageSize !== 0 && totalPages > 1 && (
        <div className="flex items-center gap-3 px-4 py-2 border-t border-border bg-card text-sm text-muted-foreground shrink-0">
          <span>
            第 {page} / {totalPages} 页
          </span>
          <span className="flex-1 text-right">
            共 {sortedRows.length.toLocaleString()} 行
            {query && sortedRows.length !== allRows.length && (
              <span>（自 {allRows.length.toLocaleString()} 行筛选）</span>
            )}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(1)}
              disabled={page === 1}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronUp className="w-4 h-4 rotate-[-90deg]" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronUp className="w-4 h-4 rotate-90" />
            </button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page === totalPages}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronsRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
