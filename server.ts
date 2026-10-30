import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
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
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ---------- 簡易併發限制器 ----------
// 免費層通常只允許每分鐘個位數~十幾次請求，
// 這裡限制「同時間最多 N 個請求在飛」，避免瞬間炸開。
const MAX_CONCURRENT = Number(process.env.GEMINI_MAX_CONCURRENT || 2);
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

// 從 Google 的錯誤訊息中解析 retryDelay（例如 "43.5s" 或 details 裡的 RetryInfo）
function extractRetryDelayMs(error: any): number | null {
  try {
    const raw =
      error?.retryDelay ??
      error?.error?.details?.find((d: any) =>
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
  return (
    error?.status === 429 ||
    error?.error?.code === 429 ||
    error?.error?.status === "RESOURCE_EXHAUSTED"
  );
}

const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 4);

async function generateWithRetry(contents: any) {
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ai.models.generateContent({
        model: MODEL_NAME,
        contents,
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

      console.warn(
        `[429] 觸發速率限制，第 ${attempt + 1} 次重試前等待 ${
          backoff + jitter
        }ms`
      );
      await sleep(backoff + jitter);
    }
  }

  throw lastError;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "50mb" }));

  app.post("/api/analyze-slide", async (req, res) => {
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "No image provided" });
    }

    await acquireSlot();
    try {
      const response = await generateWithRetry([
        {
          text: `你是一個簡報畫面篩選助手。請分析我上傳的圖片，並嚴格遵循以下規則：
如果畫面是「完整的、放映模式中的投影片/簡報內容」，請回傳 【保留】。
如果畫面是「PowerPoint編輯介面（有左側縮圖或上方工具列）」、「講師或參與者的視訊露臉畫面」、「多人視訊窗格」、「過場全黑/全灰畫面」，請回傳 【刪除】。
請不要說任何廢話，只回傳標籤。`,
        },
        {
          inlineData: {
            mimeType: mimeType || "image/png",
            data: imageBase64,
          },
        },
      ]);

      res.json({ tag: response.text?.trim() || "" });
    } catch (error: any) {
      console.error("Error analyzing image:", error);

      if (isRateLimitError(error)) {
        return res.status(429).json({
          error: "已達免費層速率限制，請稍後再試",
          retryAfterMs: extractRetryDelayMs(error),
        });
      }

      res.status(500).json({ error: "Failed to analyze image" });
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