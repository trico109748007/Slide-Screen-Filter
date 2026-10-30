/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useRef, useEffect } from "react";
import { Upload, AlertCircle, XCircle, RotateCcw, Download, FileText } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

type Decision = "keep" | "delete" | "unknown";

type ImageFile = {
  id: string;
  file: File;
  previewSrc: string;
  status: "idle" | "loading" | "success" | "error";
  decision: Decision | null;
  manual: boolean;
  errorMessage: string | null;
  rateLimitRetries: number;
};

type Filter = "all" | Decision | "error";

const FILTER_LABEL: Record<Filter, string> = {
  all: "全部",
  keep: "保留",
  delete: "刪除",
  unknown: "待確認",
  error: "錯誤",
};

// 同一張圖遇到速率限制最多自動重排幾次，超過就標成錯誤（例如每日額度用完）
const MAX_RATE_LIMIT_RETRIES = 3;
// 伺服器沒給建議等待時間時的預設暫停時間
const DEFAULT_PAUSE_MS = 15000;

class ApiError extends Error {
  constructor(message: string, public status: number, public retryAfterMs: number | null) {
    super(message);
  }
}

const DECISION_LABEL: Record<Decision, string> = {
  keep: "保留",
  delete: "刪除",
  unknown: "待確認",
};

let nextImageId = 0;

// ---------- 匯出（不使用外部套件） ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 只打包不壓縮（store），圖片本身已壓縮過，不需要再壓
async function buildZip(files: File[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const usedNames = new Set<string>();
  let offset = 0;

  for (const file of files) {
    // 同名檔案加上 (2)、(3)… 避免解壓時互相覆蓋
    let name = file.name;
    for (let i = 2; usedNames.has(name); i++) {
      const dot = file.name.lastIndexOf(".");
      name = dot > 0 ? `${file.name.slice(0, dot)} (${i})${file.name.slice(dot)}` : `${file.name} (${i})`;
    }
    usedNames.add(name);

    const data = new Uint8Array(await file.arrayBuffer());
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const d = new Date(file.lastModified || Date.now());
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // 檔名使用 UTF-8
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);

    parts.push(local.buffer, nameBytes, data);
    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

// 下載檔名用英文：部分瀏覽器遇到非 ASCII 檔名會改成 "download"
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export default function App() {
  const [images, setImages] = useState<ImageFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pausedUntil, setPausedUntil] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const updateImage = (id: string, patch: Partial<ImageFile>) => {
    setImages(prev => prev.map(img => img.id === id ? { ...img, ...patch } : img));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length > 0) {
      processFiles(files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []) as File[];
    if (files.length > 0) {
      processFiles(files);
    }
  };

  const processFiles = (newFiles: File[]) => {
    const imageFiles = newFiles
      .filter(f => f.type.startsWith("image/"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (imageFiles.length === 0) return;

    const newItems: ImageFile[] = imageFiles.map(file => ({
      id: String(nextImageId++),
      file,
      previewSrc: URL.createObjectURL(file),
      status: "idle",
      decision: null,
      manual: false,
      errorMessage: null,
      rateLimitRetries: 0,
    }));

    setImages(prev => [...prev, ...newItems]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const preprocessImage = (file: File, maxWidth = 1024, maxHeight = 1024): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        if (width > maxWidth || height > maxHeight) {
          if (width / height > maxWidth / maxHeight) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not get canvas context"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = reject;
      img.src = url;
    });
  };

  // 速率限制暫停時間到了就恢復處理
  useEffect(() => {
    if (pausedUntil === null) return;
    const timer = setTimeout(() => setPausedUntil(null), Math.max(0, pausedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [pausedUntil]);

  useEffect(() => {
    if (isProcessing || pausedUntil !== null) return;
    const item = images.find(img => img.status === "idle");
    if (!item) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsProcessing(true);
    updateImage(item.id, { status: "loading" });

    const processItem = async () => {
      try {
        const base64DataUrl = await preprocessImage(item.file);
        const base64Data = base64DataUrl.split(",")[1];
        const mimeType = "image/jpeg";

        const response = await fetch("/api/analyze-slide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: base64Data, mimeType }),
          signal: controller.signal,
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = [data.error, data.detail].filter(Boolean).join("：") || `HTTP ${response.status}`;
          throw new ApiError(message, response.status, data.retryAfterMs ?? null);
        }
        if (controller.signal.aborted) return;

        const decision: Decision = data.decision === "keep" || data.decision === "delete" ? data.decision : "unknown";
        updateImage(item.id, { status: "success", decision });
      } catch (error) {
        // 清空列表時取消的請求，結果直接丟掉
        if (controller.signal.aborted) return;
        // 速率限制：整批暫停一段時間，這張放回佇列稍後重送
        if (error instanceof ApiError && error.status === 429 && item.rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          setPausedUntil(Date.now() + (error.retryAfterMs ?? DEFAULT_PAUSE_MS));
          updateImage(item.id, { status: "idle", rateLimitRetries: item.rateLimitRetries + 1 });
          return;
        }
        updateImage(item.id, { status: "error", errorMessage: error instanceof Error ? error.message : "Error" });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setIsProcessing(false);
        }
      }
    };

    processItem();
  }, [images, isProcessing, pausedUntil]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    images.forEach(img => URL.revokeObjectURL(img.previewSrc));
    setImages([]);
    setIsProcessing(false);
    setPausedUntil(null);
    setFilter("all");
  };

  const retryImage = (id: string) => {
    updateImage(id, { status: "idle", errorMessage: null, rateLimitRetries: 0 });
  };

  const retryFailed = () => {
    setImages(prev => prev.map(img => img.status === "error" ? { ...img, status: "idle", errorMessage: null, rateLimitRetries: 0 } : img));
  };

  // 手動修正判斷：保留 ↔ 刪除，待確認點一下先改成保留
  const toggleDecision = (id: string) => {
    setImages(prev => prev.map(img => img.id === id && img.status === "success"
      ? { ...img, decision: img.decision === "keep" ? "delete" : "keep", manual: true }
      : img));
  };

  const handleTileClick = (img: ImageFile) => {
    if (img.status === "success") toggleDecision(img.id);
    else if (img.status === "error") retryImage(img.id);
  };

  const exportZip = async () => {
    const kept = images.filter(img => img.status === "success" && img.decision === "keep");
    if (kept.length === 0) return;
    setIsExporting(true);
    try {
      const zip = await buildZip(kept.map(img => img.file));
      downloadBlob(zip, `slides-keep-${timestamp()}.zip`);
    } catch (error) {
      alert(`打包失敗：${error instanceof Error ? error.message : error}`);
    } finally {
      setIsExporting(false);
    }
  };

  const exportCsv = () => {
    const statusLabel = (img: ImageFile) =>
      img.status === "success" && img.decision ? DECISION_LABEL[img.decision] :
      img.status === "error" ? "錯誤" : "未完成";
    const rows = [
      ["檔名", "判斷", "手動修正", "錯誤訊息"],
      ...images.map(img => [img.file.name, statusLabel(img), img.manual ? "是" : "", img.errorMessage ?? ""]),
    ];
    const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
    // 加上 BOM，Excel 開啟時中文才不會變亂碼
    downloadBlob(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }), `slide-filter-results-${timestamp()}.csv`);
  };

  const visibleImages = images.filter(img =>
    filter === "all" ? true :
    filter === "error" ? img.status === "error" :
    img.status === "success" && img.decision === filter
  );

  const stats = {
    total: images.length,
    processing: images.filter(i => i.status === 'loading' || i.status === 'idle').length,
    retained: images.filter(i => i.decision === 'keep').length,
    deleted: images.filter(i => i.decision === 'delete').length,
    unknown: images.filter(i => i.decision === 'unknown').length,
    errors: images.filter(i => i.status === 'error').length,
  };

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 font-sans">
      <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-8 shadow-sm shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center">
            <div className="w-4 h-4 border-2 border-white"></div>
          </div>
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">簡報畫面篩選助手 <span className="hidden md:inline text-slate-400 font-normal text-sm ml-2">v2.4.1 (Batch)</span></h1>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-blue-500 animate-pulse' : pausedUntil !== null ? 'bg-yellow-400 animate-pulse' : 'bg-green-500'}`}></span>
            <span className="text-sm font-medium text-slate-600 hidden md:inline">{isProcessing ? '批次分析中' : pausedUntil !== null ? '速率限制，稍後自動繼續' : '系統就緒'}</span>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6 overflow-auto">
        <div className="max-w-[1200px] mx-auto h-full grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* LEFT COLUMN - Upload & Gallery */}
          <div className="lg:col-span-8 flex flex-col gap-4">
            {images.length === 0 ? (
              <div 
                className="flex-1 bg-white rounded-xl border-2 border-dashed border-slate-300 p-12 flex flex-col items-center justify-center cursor-pointer hover:border-blue-500 hover:bg-blue-50/50 transition-colors group shadow-sm min-h-[400px]"
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                <div className="bg-slate-100 p-4 rounded-full mb-6 group-hover:scale-110 group-hover:bg-blue-100 group-hover:text-blue-600 transition-all text-slate-400">
                  <Upload className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-medium mb-2 text-slate-700">
                  點擊或拖曳多張圖片至此
                </h3>
                <p className="text-slate-500 text-sm mb-4 text-center max-w-md">
                  支援批次上傳。圖片將會在本機進行壓縮預處理，接著分批傳送至 AI 進行判斷。
                </p>
                <p className="text-slate-400 text-xs">支援 JPG, PNG 格式</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
            ) : (
              <>
                <div 
                  className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-center gap-2 cursor-pointer hover:bg-slate-50 transition-colors shadow-sm shrink-0"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                >
                  <Upload className="w-5 h-5 text-blue-500" />
                  <span className="font-medium text-slate-700">繼續加入圖片</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>
                
                <div className="flex-1 bg-white rounded-xl border border-slate-200 p-4 shadow-sm overflow-auto min-h-[400px]">
                  <div className="flex flex-wrap items-center gap-2 mb-4">
                    {(Object.keys(FILTER_LABEL) as Filter[]).map(key => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setFilter(key)}
                        className={`text-xs font-bold px-3 py-1 rounded-full border transition-colors ${
                          filter === key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {FILTER_LABEL[key]}
                      </button>
                    ))}
                    <span className="text-xs text-slate-400 ml-auto">點縮圖可切換保留／刪除，錯誤的圖點一下重試</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    <AnimatePresence>
                      {visibleImages.map(img => (
                        <motion.div 
                          key={img.id}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          role={img.status === 'success' || img.status === 'error' ? 'button' : undefined}
                          tabIndex={img.status === 'success' || img.status === 'error' ? 0 : undefined}
                          title={img.status === 'error' ? `${img.file.name}\n${img.errorMessage ?? ''}` : img.file.name}
                          onClick={() => handleTileClick(img)}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleTileClick(img); } }}
                          className={`relative rounded-lg ${img.status === 'success' || img.status === 'error' ? 'cursor-pointer' : ''} overflow-hidden border-2 aspect-video bg-black flex items-center justify-center ${
                            img.status === 'success' && img.decision === 'keep' ? 'border-green-500' :
                            img.status === 'success' && img.decision === 'delete' ? 'border-red-500' :
                            img.status === 'success' && img.decision === 'unknown' ? 'border-yellow-400' :
                            img.status === 'error' ? 'border-orange-500' :
                            'border-slate-200'
                          }`}
                        >
                          <img src={img.previewSrc} alt={img.file.name} className="w-full h-full object-cover opacity-60" />
                          
                          <div className="absolute inset-0 flex items-center justify-center p-2">
                            {img.status === 'idle' && (
                              <span className="bg-slate-800/80 text-white text-xs px-2 py-1 rounded backdrop-blur-sm shadow-sm">等待中</span>
                            )}
                            {img.status === 'loading' && (
                              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                            )}
                            {img.status === 'success' && img.decision && (
                              <span className={`text-sm font-bold px-2 py-1 rounded backdrop-blur-md shadow-lg ${
                                img.decision === 'keep' ? 'bg-green-500/90 text-white' :
                                img.decision === 'delete' ? 'bg-red-500/90 text-white' :
                                'bg-yellow-400/90 text-slate-900'
                              }`}>
                                {DECISION_LABEL[img.decision]}{img.manual && <span className="ml-1 text-[10px] font-normal opacity-80">手動</span>}
                              </span>
                            )}
                            {img.status === 'error' && (
                              <div className="flex flex-col items-center gap-1 text-center">
                                <AlertCircle className="text-orange-500 w-8 h-8" />
                                <span className="text-[10px] leading-tight text-white bg-slate-900/70 px-1.5 py-0.5 rounded line-clamp-2">{img.errorMessage}</span>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* RIGHT COLUMN - Analysis Result & Rules */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            <div className="bg-white rounded-xl border border-slate-200 p-6 flex-1 flex flex-col shadow-sm">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">批次處理狀態 Status</h2>
              
              <div className="flex-1 flex flex-col w-full">
                <div className="grid grid-cols-2 gap-4 mb-6">
                   <div className="bg-slate-50 p-4 rounded-lg border border-slate-100 flex flex-col items-center">
                     <span className="text-slate-500 text-xs font-bold mb-1">總數 TOTAL</span>
                     <span className="text-3xl font-black text-slate-700">{stats.total}</span>
                   </div>
                   <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 flex flex-col items-center">
                     <span className="text-blue-500 text-xs font-bold mb-1">處理中 QUEUE</span>
                     <span className="text-3xl font-black text-blue-700">{stats.processing}</span>
                   </div>
                   <div className="bg-green-50 p-4 rounded-lg border border-green-100 flex flex-col items-center">
                     <span className="text-green-600 text-xs font-bold mb-1">保留 RETAINED</span>
                     <span className="text-3xl font-black text-green-700">{stats.retained}</span>
                   </div>
                   <div className="bg-red-50 p-4 rounded-lg border border-red-100 flex flex-col items-center">
                     <span className="text-red-500 text-xs font-bold mb-1">刪除 DELETED</span>
                     <span className="text-3xl font-black text-red-700">{stats.deleted}</span>
                   </div>
                </div>

                {(stats.unknown > 0 || stats.errors > 0) && (
                  <div className="flex gap-4 justify-center text-xs font-bold mb-4">
                    {stats.unknown > 0 && <span className="text-yellow-600">待確認 {stats.unknown}</span>}
                    {stats.errors > 0 && <span className="text-orange-500">錯誤 {stats.errors}</span>}
                  </div>
                )}

                {stats.errors > 0 && (
                  <button
                    type="button"
                    onClick={retryFailed}
                    className="w-full mb-4 py-2 bg-orange-50 text-orange-600 border border-orange-200 text-sm font-bold rounded-lg hover:bg-orange-100 transition-colors flex items-center justify-center gap-2"
                  >
                    <RotateCcw className="w-4 h-4" />
                    重試失敗項目 ({stats.errors})
                  </button>
                )}

                <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden mb-6">
                  {stats.total > 0 && (
                    <div 
                      className="h-full bg-blue-500 transition-all duration-300"
                      style={{ width: `${((stats.total - stats.processing) / stats.total) * 100}%` }}
                    />
                  )}
                </div>
              </div>

              <div className="mt-auto">
                <div className="h-px bg-slate-100 w-full mb-6"></div>
                {stats.processing > 0 && stats.total > 0 && (
                  <p className="text-xs text-slate-400 text-center mb-2">還有 {stats.processing} 張未完成，現在匯出只會包含已完成的結果</p>
                )}
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <button
                    type="button"
                    onClick={exportZip}
                    disabled={stats.retained === 0 || isExporting}
                    className="py-3 bg-green-600 text-white text-sm font-bold rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    {isExporting ? '打包中…' : `下載保留 (${stats.retained})`}
                  </button>
                  <button
                    type="button"
                    onClick={exportCsv}
                    disabled={images.length === 0}
                    className="py-3 bg-white text-slate-700 border border-slate-300 text-sm font-bold rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <FileText className="w-4 h-4" />
                    匯出 CSV
                  </button>
                </div>
                <button
                  onClick={reset}
                  disabled={images.length === 0}
                  className="w-full py-4 bg-slate-900 text-white font-bold rounded-lg hover:bg-slate-800 transition-colors uppercase tracking-wider disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <XCircle className="w-4 h-4" />
                  清空列表 (重設)
                </button>
              </div>
            </div>

            <div className="bg-blue-600 rounded-xl p-6 text-white shadow-lg shrink-0">
              <h3 className="text-sm font-bold mb-2">篩選規則說明</h3>
              <ul className="text-xs space-y-2 opacity-90">
                <li className="flex gap-2">• 完整、放映模式內容 → <span className="font-bold underline">保留</span></li>
                <li className="flex gap-2">• 編輯工具、視訊視窗 → <span className="font-bold underline">刪除</span></li>
                <li className="flex gap-2">• 全黑/全灰過場畫面 → <span className="font-bold underline">刪除</span></li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      <footer className="hidden md:flex h-12 bg-slate-100 border-t border-slate-200 px-8 items-center justify-between text-[11px] text-slate-500 shrink-0">
        <div className="flex gap-4">
          <span>SYSTEM: OK</span>
          <span>MEM: STABLE</span>
        </div>
        <div className="flex gap-4">
          <span>AI STUDIO PREVIEW</span>
        </div>
      </footer>
    </div>
  );
}
