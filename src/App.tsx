/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useRef, useEffect } from "react";
import { Upload, AlertCircle, XCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

type Decision = "keep" | "delete" | "unknown";

type ImageFile = {
  id: string;
  file: File;
  previewSrc: string;
  status: "idle" | "loading" | "success" | "error";
  decision: Decision | null;
  errorMessage: string | null;
};

const DECISION_LABEL: Record<Decision, string> = {
  keep: "保留",
  delete: "刪除",
  unknown: "待確認",
};

let nextImageId = 0;

export default function App() {
  const [images, setImages] = useState<ImageFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
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
    const imageFiles = newFiles.filter(f => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    const newItems: ImageFile[] = imageFiles.map(file => ({
      id: String(nextImageId++),
      file,
      previewSrc: URL.createObjectURL(file),
      status: "idle",
      decision: null,
      errorMessage: null,
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

  useEffect(() => {
    if (isProcessing) return;
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

        if (!response.ok) throw new Error("API Error");
        const data = await response.json();
        if (controller.signal.aborted) return;

        const decision: Decision = data.decision === "keep" || data.decision === "delete" ? data.decision : "unknown";
        updateImage(item.id, { status: "success", decision });
      } catch (error) {
        // 清空列表時取消的請求，結果直接丟掉
        if (controller.signal.aborted) return;
        updateImage(item.id, { status: "error", errorMessage: error instanceof Error ? error.message : "Error" });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setIsProcessing(false);
        }
      }
    };

    processItem();
  }, [images, isProcessing]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setImages([]);
    setIsProcessing(false);
  };

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
            <span className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-blue-500 animate-pulse' : 'bg-green-500'}`}></span>
            <span className="text-sm font-medium text-slate-600 hidden md:inline">{isProcessing ? '批次分析中' : '系統就緒'}</span>
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
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    <AnimatePresence>
                      {images.map(img => (
                        <motion.div 
                          key={img.id}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className={`relative rounded-lg overflow-hidden border-2 aspect-video bg-black flex items-center justify-center ${
                            img.status === 'success' && img.decision === 'keep' ? 'border-green-500' :
                            img.status === 'success' && img.decision === 'delete' ? 'border-red-500' :
                            img.status === 'success' && img.decision === 'unknown' ? 'border-yellow-400' :
                            img.status === 'error' ? 'border-orange-500' :
                            'border-slate-200'
                          }`}
                        >
                          <img src={img.previewSrc} className="w-full h-full object-cover opacity-60" />
                          
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
                                {DECISION_LABEL[img.decision]}
                              </span>
                            )}
                            {img.status === 'error' && (
                              <AlertCircle className="text-orange-500 w-8 h-8" />
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
