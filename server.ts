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

// 要求模型只回傳 keep / delete，避免自由文字造成判斷錯誤；reason 放前面，讓模型先說明再下結論
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    reason: { type: Type.STRING },
    decision: { type: Type.STRING, enum: ["keep", "delete"] },
  },
  required: ["reason", "decision"],
  propertyOrdering: ["reason", "decision"],
};

const PROMPT = `你是簡報截圖篩選助手。請判斷這張截圖是否以「投影片內容」為主體。

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
reason 請用一句繁體中文簡述判斷依據。`;

type Decision = "keep" | "delete" | "unknown";

function parseDecision(text: string | undefined): { decision: Decision; reason: string } {
  const raw = text?.trim() || "";
  try {
    const parsed = JSON.parse(raw);
    const reason = typeof parsed?.reason === "string" ? parsed.reason.slice(0, 200) : "";
    if (parsed?.decision === "keep" || parsed?.decision === "delete") {
      return { decision: parsed.decision, reason };
    }
  } catch {
    // 不是 JSON，改用關鍵字判斷
  }
  const hasKeep = /保留|keep/i.test(raw);
  const hasDelete = /刪除|delete/i.test(raw);
  const reason = raw.slice(0, 200);
  if (hasKeep && !hasDelete) return { decision: "keep", reason };
  if (hasDelete && !hasKeep) return { decision: "delete", reason };
  return { decision: "unknown", reason };
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

  app.use(express.json({ limit: "50mb" }));

  app.post("/api/analyze-slide", async (req, res) => {
    const { imageBase64, mimeType } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "No image provided" });
    }

    const deadline = Date.now() + MAX_TOTAL_WAIT_MS;
    await acquireSlot();
    try {
      const response = await generateWithRetry([
        {
          text: PROMPT,
        },
        {
          inlineData: {
            mimeType: mimeType || "image/png",
            data: imageBase64,
          },
        },
      ], deadline);

      res.json(parseDecision(response.text));
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