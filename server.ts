import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// 可用環境變數覆蓋，方便切換模型測試（免費層額度可能因模型而異）
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";

// ---------- 簡易併發限制器 ----------
// 免費層通常只允許每分鐘個位數~十幾次請求，
// 這裡限制「同時間最多 N 個請求在飛」，避免瞬間炸開。
const MAX_CONCURRENT = Number(process.env.GEMINI_MAX_CONCURRENT || 2);
// 排隊中的請求上限，超過就直接回 429，避免大量請求卡在伺服器
const MAX_QUEUE = Number(process.env.GEMINI_MAX_QUEUE || 20);
// 單次請求最多幾張圖（前端預設一次送 5 張）
const MAX_BATCH_SIZE = Number(process.env.GEMINI_MAX_BATCH_SIZE || 10);
// Gemini 支援的圖片格式
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
let activeCount = 0;
const queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeCount < MAX_CONCURRENT) {
        activeCount++;
        resolve();
      } else {
        queue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseSlot() {
  activeCount--;
  const next = queue.shift();
  if (next) next();
}

// ---------- 429 重試邏輯 ----------
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SDK 的 ApiError 只有 status 與 message，完整錯誤內容是 message 裡的 JSON 字串
function parseErrorBody(error: any): any {
  if (error?.error) return error;
  try {
    return JSON.parse(error?.message);
  } catch {
    return null;
  }
}

// 從 Google 的錯誤訊息中解析 retryDelay（例如 "43.5s" 或 details 裡的 RetryInfo）
function extractRetryDelayMs(error: any): number | null {
  try {
    const raw =
      error?.retryDelay ??
      parseErrorBody(error)?.error?.details?.find((d: any) =>
        d["@type"]?.includes("RetryInfo")
      )?.retryDelay;

    if (!raw) return null;

    // 格式可能是 "43.537652352s" 或純數字字串
    const match = String(raw).match(/([\d.]+)/);
    if (!match) return null;

    return Math.ceil(parseFloat(match[1]) * 1000);
  } catch {
    return null;
  }
}

function isRateLimitError(error: any): boolean {
  const body = parseErrorBody(error);
  return (
    error?.status === 429 ||
    body?.error?.code === 429 ||
    body?.error?.status === "RESOURCE_EXHAUSTED"
  );
}

const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 4);
// 單一請求（含排隊與重試等待）的總時間上限，超過就直接回 429，避免 HTTP 請求逾時
const MAX_TOTAL_WAIT_MS = Number(process.env.GEMINI_MAX_TOTAL_WAIT_MS || 60000);

// 要求模型逐張回傳 keep / delete，避免自由文字造成判斷錯誤；reason 放前面，讓模型先說明再下結論
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          reason: { type: Type.STRING },
          decision: { type: Type.STRING, enum: ["keep", "delete"] },
        },
        required: ["index", "reason", "decision"],
        propertyOrdering: ["index", "reason", "decision"],
      },
    },
  },
  required: ["results"],
};

const PROMPT = `你是簡報截圖篩選助手。以下有多張截圖，每張前面標有編號。請逐張「獨立」判斷是否以「投影片內容」為主體，不要互相參考。

保留（keep）：投影片內容佔畫面主要部分。即使畫面上同時出現以下元素，也要保留：
- 放映視窗的標題列、視窗按鈕或邊框（沒有全螢幕放映）
- 螢幕分享提示（例如「meet.google.com 正在共用你的畫面」）、會議軟體的浮動工具列或通知
- 角落的小型講者視訊縮圖
- 頁碼、浮水印、滑鼠游標、雷射筆、畫面略有裁切或模糊

刪除（delete）：
- PowerPoint 的「編輯」介面：上方有功能區（常用、插入、設計等分頁與按鈕），或左側有投影片縮圖窗格
- 以視訊為主的畫面：講者或參與者的臉佔畫面大部分，或多人視訊格狀畫面
- 幾乎沒有內容的過場畫面：全黑、全灰、全白、載入中

判斷原則：視窗標題列、分享提示這類元素本身不構成刪除理由。無法確定時，傾向保留。
results 每張圖一筆，index 為該圖的編號；reason 請用一句繁體中文簡述判斷依據。`;

type Decision = "keep" | "delete" | "unknown";

// 依編號把模型回傳的結果對應回每張圖；漏回或格式錯誤的標成 unknown
function parseResults(text: string | undefined, count: number): { decision: Decision; reason: string }[] {
  const results: { decision: Decision; reason: string }[] = Array.from({ length: count }, () => ({
    decision: "unknown",
    reason: "AI 沒有回傳這張的結果",
  }));
  try {
    const parsed = JSON.parse(text?.trim() || "");
    for (const item of parsed?.results ?? []) {
      const i = Number(item?.index) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= count) continue;
      if (item.decision !== "keep" && item.decision !== "delete") continue;
      results[i] = {
        decision: item.decision,
        reason: typeof item.reason === "string" ? item.reason.slice(0, 200) : "",
      };
    }
  } catch {
    // 不是 JSON，全部維持 unknown
  }
  return results;
}

async function generateWithRetry(contents: any, deadline: number) {
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ai.models.generateContent({
        model: MODEL_NAME,
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      });
    } catch (error: any) {
      lastError = error;

      if (!isRateLimitError(error) || attempt === MAX_RETRIES) {
        throw error;
      }

      // 優先使用 API 建議的等待時間，否則用指數退避 (1s, 2s, 4s, 8s...)
      const suggested = extractRetryDelayMs(error);
      const backoff = suggested ?? Math.min(1000 * 2 ** attempt, 30000);
      const jitter = Math.floor(Math.random() * 300);
      const wait = backoff + jitter;

      // 等下去會超過總時間上限，就不再重試，交給前端稍後處理
      if (Date.now() + wait > deadline) {
        throw error;
      }

      console.warn(
        `[429] 觸發速率限制，第 ${attempt + 1} 次重試前等待 ${wait}ms`
      );
      await sleep(wait);
    }
  }

  throw lastError;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // 前端會先把圖片縮到 1024px 的 JPEG，通常只有幾百 KB
  app.use(express.json({ limit: "10mb" }));

  app.post("/api/analyze-slides", async (req, res) => {
    const images: { imageBase64?: string; mimeType?: string }[] = Array.isArray(req.body?.images) ? req.body.images : [];

    if (images.length === 0 || images.some(img => !img?.imageBase64)) {
      return res.status(400).json({ error: "No image provided" });
    }
    if (images.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ error: `Too many images: ${images.length} > ${MAX_BATCH_SIZE}` });
    }
    const badType = images.find(img => img.mimeType && !ALLOWED_MIME_TYPES.includes(img.mimeType));
    if (badType) {
      return res.status(400).json({ error: `Unsupported image type: ${badType.mimeType}` });
    }
    if (queue.length >= MAX_QUEUE) {
      return res.status(429).json({
        error: "伺服器忙碌中，請稍後再試",
        retryAfterMs: 5000,
      });
    }

    const deadline = Date.now() + MAX_TOTAL_WAIT_MS;
    await acquireSlot();
    try {
      // 每張圖前面加上編號，讓模型依編號回傳結果
      const parts: any[] = [{ text: PROMPT }];
      images.forEach((img, i) => {
        parts.push({ text: `圖片 ${i + 1}：` });
        parts.push({ inlineData: { mimeType: img.mimeType || "image/png", data: img.imageBase64 } });
      });

      const response = await generateWithRetry(parts, deadline);

      res.json({ results: parseResults(response.text, images.length) });
    } catch (error: any) {
      console.error("Error analyzing image:", error);

      if (isRateLimitError(error)) {
        return res.status(429).json({
          error: "已達免費層速率限制，請稍後再試",
          retryAfterMs: extractRetryDelayMs(error),
        });
      }

      // 把 Google 回傳的錯誤摘要帶給前端，不用翻伺服器日誌也看得到原因
      const body = parseErrorBody(error)?.error;
      const detail = body
        ? `${body.code ?? error?.status ?? ""} ${body.status ?? ""} ${body.message ?? ""}`
        : error?.message;
      res.status(500).json({
        error: "Failed to analyze image",
        detail: String(detail || "").trim().slice(0, 300),
      });
    } finally {
      releaseSlot();
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(
      `Model: ${MODEL_NAME} | Max concurrent requests: ${MAX_CONCURRENT}`
    );
  });
}

startServer();