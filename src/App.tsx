/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useRef, useEffect } from "react";
import { Upload, AlertCircle, XCircle, RotateCcw, Download, FileText } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

type Decision = "keep" | "delete" | "unknown";

// idle：等待本機分析，queued：等待送 AI，loading：AI 分析中
type Status = "idle" | "queued" | "loading" | "success" | "error";
// ai：AI 判斷，local：本機判定為過場畫面，duplicate：與前一張相似、沿用其判斷
type DecisionSource = "ai" | "local" | "duplicate";

type ImageFile = {
  id: string;
  file: File;
  previewSrc: string;
  status: Status;
  decision: Decision | null;
  source: DecisionSource | null;
  reason: string | null;
  manual: boolean;
  hash: string | null;
  brightness: number | null;
  duplicateOf: string | null;
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
// 前端同時送出的請求數，與伺服器 GEMINI_MAX_CONCURRENT 的預設值一致
const MAX_PARALLEL_REQUESTS = 2;
// 本機判定過場畫面：與平均亮度差超過 BLANK_PIXEL_DIFF 的像素比例低於 BLANK_MAX_RATIO，就視為單一顏色
const BLANK_PIXEL_DIFF = 16;
const BLANK_MAX_RATIO = 0.001;
// 與前一張的感知雜湊（256 位元）差異不超過 DUPLICATE_MAX_DISTANCE、平均亮度差不超過
// DUPLICATE_MAX_BRIGHTNESS_DIFF，就沿用前一張的判斷（雜湊只看明暗變化，需要亮度輔助）
const DUPLICATE_MAX_DISTANCE = 10;
const DUPLICATE_MAX_BRIGHTNESS_DIFF = 12;

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

const SOURCE_LABEL: Partial<Record<DecisionSource, string>> = {
  local: "本機",
  duplicate: "沿用",
};

let nextImageId = 0;

// ---------- 本機分析（不呼叫 API） ----------
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("無法讀取圖片"));
    };
    img.src = url;
  });
}

function grayscale(img: HTMLImageElement, width: number, height: number): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get canvas context");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  }
  return gray;
}

// 判斷是否為單一顏色的過場畫面，並計算感知雜湊（dHash）供比對相似畫面
async function analyzeLocally(file: File): Promise<{ blank: boolean; hash: string; brightness: number }> {
  const img = await loadImage(file);

  const sampleWidth = 160;
  const sampleHeight = Math.max(1, Math.round((img.height * sampleWidth) / img.width));
  const gray = grayscale(img, sampleWidth, sampleHeight);
  const mean = gray.reduce((sum, v) => sum + v, 0) / gray.length;
  let outliers = 0;
  for (const v of gray) if (Math.abs(v - mean) > BLANK_PIXEL_DIFF) outliers++;
  const blank = outliers / gray.length < BLANK_MAX_RATIO;

  const small = grayscale(img, 17, 16);
  let hash = "";
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) hash += small[y * 17 + x] < small[y * 17 + x + 1] ? "1" : "0";
  }
  return { blank, hash, brightness: mean };
}

function isSimilar(a: { hash: string; brightness: number }, b: { hash: string; brightness: number }): boolean {
  return hammingDistance(a.hash, b.hash) <= DUPLICATE_MAX_DISTANCE
    && Math.abs(a.brightness - b.brightness) <= DUPLICATE_MAX_BRIGHTNESS_DIFF;
}

function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) distance++;
  return distance;
}

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
  const [pausedUntil, setPausedUntil] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 進行中的 AI 請求，key 為圖片 id
  const controllersRef = useRef(new Map<string, AbortController>());
  const localBusyRef = useRef(false);
  // 非同步工作結束時觸發佇列重新檢查
  const [localTick, setLocalTick] = useState(0);
  const [apiTick, setApiTick] = useState(0);

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
      source: null,
      reason: null,
      manual: false,
      hash: null,
      brightness: null,
      duplicateOf: null,
      errorMessage: null,
      rateLimitRetries: 0,
    }));

    setImages(prev => [...prev, ...newItems]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const preprocessImage = async (file: File, maxWidth = 1024, maxHeight = 1024): Promise<string> => {
    const img = await loadImage(file);
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

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get canvas context");
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.8);
  };

  // 速率限制暫停時間到了就恢復處理
  useEffect(() => {
    if (pausedUntil === null) return;
    const timer = setTimeout(() => setPausedUntil(null), Math.max(0, pausedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [pausedUntil]);

  // 第一階段：本機分析，依列表順序逐張進行（相似比對需要前一張的結果）
  useEffect(() => {
    if (localBusyRef.current) return;
    const index = images.findIndex(img => img.status === "idle");
    if (index === -1) return;
    const item = images[index];
    // 往前找最近一張已分析、且不是過場畫面的圖來比對
    const previous = images.slice(0, index).reverse().find(img => img.hash !== null && img.source !== "local");

    localBusyRef.current = true;
    analyzeLocally(item.file)
      .then(({ blank, hash, brightness }) => {
        if (blank) {
          updateImage(item.id, { status: "success", decision: "delete", source: "local", reason: "本機判定：畫面幾乎是單一顏色（過場畫面）", hash, brightness });
        } else if (previous?.hash && previous.brightness !== null && isSimilar({ hash, brightness }, { hash: previous.hash, brightness: previous.brightness })) {
          updateImage(item.id, { status: "queued", hash, brightness, duplicateOf: previous.id });
        } else {
          updateImage(item.id, { status: "queued", hash, brightness });
        }
      })
      .catch(error => {
        updateImage(item.id, { status: "error", errorMessage: error instanceof Error ? error.message : "無法讀取圖片" });
      })
      .finally(() => {
        localBusyRef.current = false;
        setLocalTick(t => t + 1);
      });
  }, [images, localTick]);

  // 第二階段：與前一張相似的圖，等前一張有結果後沿用；前一張失敗就改為自己送 AI
  useEffect(() => {
    const byId = new Map<string, ImageFile>(images.map(img => [img.id, img]));
    const updates = new Map<string, Partial<ImageFile>>();
    for (const img of images) {
      if (img.status !== "queued" || !img.duplicateOf) continue;
      const source = byId.get(img.duplicateOf);
      if (source?.status === "success" && source.decision) {
        updates.set(img.id, { status: "success", decision: source.decision, source: "duplicate", reason: `與「${source.file.name}」畫面相似，沿用其判斷` });
      } else if (!source || source.status === "error") {
        updates.set(img.id, { duplicateOf: null });
      }
    }
    if (updates.size > 0) {
      setImages(prev => prev.map(img => updates.has(img.id) ? { ...img, ...updates.get(img.id) } : img));
    }
  }, [images]);

  const analyzeWithApi = async (item: ImageFile, controller: AbortController) => {
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
      updateImage(item.id, { status: "success", decision, source: "ai", reason: typeof data.reason === "string" ? data.reason : null });
    } catch (error) {
      // 清空列表時取消的請求，結果直接丟掉
      if (controller.signal.aborted) return;
      // 速率限制：整批暫停一段時間，這張放回佇列稍後重送
      if (error instanceof ApiError && error.status === 429 && item.rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        setPausedUntil(Date.now() + (error.retryAfterMs ?? DEFAULT_PAUSE_MS));
        updateImage(item.id, { status: "queued", rateLimitRetries: item.rateLimitRetries + 1 });
        return;
      }
      updateImage(item.id, { status: "error", errorMessage: error instanceof Error ? error.message : "Error" });
    } finally {
      if (controllersRef.current.get(item.id) === controller) {
        controllersRef.current.delete(item.id);
        setApiTick(t => t + 1);
      }
    }
  };

  // 第三階段：送 AI 分析，最多同時 MAX_PARALLEL_REQUESTS 個請求
  useEffect(() => {
    if (pausedUntil !== null) return;
    const slots = MAX_PARALLEL_REQUESTS - controllersRef.current.size;
    if (slots <= 0) return;
    const ready = images
      .filter(img => img.status === "queued" && !img.duplicateOf && !controllersRef.current.has(img.id))
      .slice(0, slots);
    if (ready.length === 0) return;

    const ids = new Set(ready.map(img => img.id));
    setImages(prev => prev.map(img => ids.has(img.id) ? { ...img, status: "loading" } : img));
    for (const item of ready) {
      const controller = new AbortController();
      controllersRef.current.set(item.id, controller);
      analyzeWithApi(item, controller);
    }
  }, [images, pausedUntil, apiTick]);

  const reset = () => {
    controllersRef.current.forEach(controller => controller.abort());
    controllersRef.current.clear();
    images.forEach(img => URL.revokeObjectURL(img.previewSrc));
    setImages([]);
    setPausedUntil(null);
    setFilter("all");
  };

  // 本機分析已完成的圖直接重送 AI，否則從本機分析重新開始
  const retryPatch = (img: ImageFile): ImageFile => ({
    ...img,
    status: img.hash ? "queued" : "idle",
    duplicateOf: null,
    errorMessage: null,
    rateLimitRetries: 0,
  });

  const retryImage = (id: string) => {
    setImages(prev => prev.map(img => img.id === id ? retryPatch(img) : img));
  };

  const retryFailed = () => {
    setImages(prev => prev.map(img => img.status === "error" ? retryPatch(img) : img));
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
      ["檔名", "判斷", "手動修正", "AI 判斷理由", "錯誤訊息"],
      ...images.map(img => [img.file.name, statusLabel(img), img.manual ? "是" : "", img.reason ?? "", img.errorMessage ?? ""]),
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
    processing: images.filter(i => i.status === 'idle' || i.status === 'queued' || i.status === 'loading').length,
    retained: images.filter(i => i.decision === 'keep').length,
    deleted: images.filter(i => i.decision === 'delete').length,
    unknown: images.filter(i => i.decision === 'unknown').length,
    errors: images.filter(i => i.status === 'error').length,
  };

  const isProcessing = stats.processing > 0 && pausedUntil === null;

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
                          title={[img.file.name, img.status === 'error' ? img.errorMessage : img.reason].filter(Boolean).join('\n')}
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
                            {(img.status === 'idle' || img.status === 'queued') && (
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
                                {DECISION_LABEL[img.decision]}{img.manual ? (
                                  <span className="ml-1 text-[10px] font-normal opacity-80">手動</span>
                                ) : img.source && SOURCE_LABEL[img.source] && (
                                  <span className="ml-1 text-[10px] font-normal opacity-80">{SOURCE_LABEL[img.source]}</span>
                                )}
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
