// ============================================================
//  index.js — Cloud Function: BWTS 분석 (Gemini 2.5 Flash)
//
//  POST /analyze
//    body: { input: {...정제된 데이터...}, rulebook_version?: string }
//    response: { overall_status, ai_remarks, ai_remarks_en, alarm_summary,
//                _gemini_meta?, _fallback?, _cached? }
//
//  토글: Firestore settings/global.useGeminiAnalysis
//    OFF → 100% JS 폴백
//    ON  → 캐시 조회 → 미스 시 Gemini 호출 → 실패 시 JS 폴백
// ============================================================
import functions from "@google-cloud/functions-framework";
import { Firestore } from "@google-cloud/firestore";
import { GoogleGenAI } from "@google/genai";
import admin from "firebase-admin";
import crypto from "node:crypto";

import { runFallback } from "./fallback.js";
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, RULEBOOK_VERSION } from "./rulebook.js";


// ── 환경 설정 ───────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://hwjung-bit.github.io,http://localhost:5173,http://localhost:4173"
).split(",").map(s => s.trim());

// 크로스 프로젝트 Firestore (settings, cache) — bwts-dashboard에 있음
const FIRESTORE_PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || undefined;
const firestore = FIRESTORE_PROJECT_ID
  ? new Firestore({ projectId: FIRESTORE_PROJECT_ID })
  : new Firestore();
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Firebase Auth ID 토큰 검증용 (대시보드 로그인 사용자만 호출 허용)
// AUTH_PROJECT_ID(=Firebase 프로젝트)로 aud 검증. 미설정 시 인증 비활성(개발용).
const AUTH_PROJECT_ID = process.env.AUTH_PROJECT_ID || FIRESTORE_PROJECT_ID || undefined;
if (AUTH_PROJECT_ID && !admin.apps.length) {
  admin.initializeApp({ projectId: AUTH_PROJECT_ID });
}

// Authorization: Bearer <Firebase ID 토큰> 검증. 통과 시 decoded, 실패 시 null.
async function verifyCaller(req) {
  if (!AUTH_PROJECT_ID) return { skip: true }; // 인증 비활성 환경
  const authz = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer (.+)$/.exec(authz);
  if (!m) return null;
  try {
    return await admin.auth().verifyIdToken(m[1]);
  } catch (e) {
    console.warn("[auth] ID 토큰 검증 실패:", e.message);
    return null;
  }
}


// ── 유틸 ────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "3600",
  };
}

function hashInput(input, rulebookVersion) {
  const stable = JSON.stringify(input, Object.keys(input).sort());
  return crypto.createHash("sha256").update(stable + "|" + rulebookVersion).digest("hex");
}

async function getToggle() {
  try {
    const doc = await firestore.doc("settings/global").get();
    if (!doc.exists) return { useGeminiAnalysis: false };
    return doc.data() || { useGeminiAnalysis: false };
  } catch (e) {
    console.warn("settings/global 읽기 실패 — 폴백 모드로 처리:", e.message);
    return { useGeminiAnalysis: false };
  }
}

async function readCache(hash) {
  try {
    const doc = await firestore.doc(`analyses_cache/${hash}`).get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    console.warn("캐시 읽기 실패:", e.message);
    return null;
  }
}

async function writeCache(hash, result, meta) {
  try {
    await firestore.doc(`analyses_cache/${hash}`).set({
      ...result,
      _gemini_meta: meta,
      _cachedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("캐시 저장 실패:", e.message);
  }
}


// ── Gemini 호출 ─────────────────────────────────────────────
async function callGemini(input) {
  if (!ai) throw new Error("GEMINI_API_KEY 미설정");

  const userPayload = {
    vessel_name: input.vessel_name || null,
    imo_number:  input.imo_number  || null,
    period:      input.period      || null,
    operations:        input.operations        || [],
    tro_data:          input.tro_data          || {},
    error_alarms:      input.error_alarms      || [],
    op_time_stats:     input.op_time_stats     || {},
    op_time_anomalies: input.op_time_anomalies || [],
    event_log_analysis:  input.event_log_analysis  || {},
    data_log_efficiency: input.data_log_efficiency || null,
    gps_areas:         input.gps_areas         || [],
  };

  const t0 = Date.now();
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: "다음 BWTS 운전 로그(JSON)를 분석하라:\n\n" + JSON.stringify(userPayload) }],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });
  const latency = Date.now() - t0;

  const text = response.text || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini JSON 파싱 실패: ${e.message}. raw=${text.slice(0, 300)}`);
  }

  // 스키마 후검증
  if (!["NORMAL", "WARNING", "CRITICAL"].includes(parsed.overall_status)) {
    throw new Error(`Gemini 스키마 위반: overall_status=${parsed.overall_status}`);
  }
  if (!Array.isArray(parsed.ai_remarks) || !Array.isArray(parsed.ai_remarks_en)) {
    throw new Error("Gemini 스키마 위반: remarks가 배열 아님");
  }
  if (!Array.isArray(parsed.alarm_summary)) parsed.alarm_summary = [];

  const meta = {
    model: GEMINI_MODEL,
    prompt_tokens: response.usageMetadata?.promptTokenCount || null,
    output_tokens: response.usageMetadata?.candidatesTokenCount || null,
    latency_ms: latency,
    finish_reason: response.candidates?.[0]?.finishReason || null,
  };

  return { result: parsed, meta };
}


// ── 메인 핸들러 ─────────────────────────────────────────────
functions.http("analyze", async (req, res) => {
  const origin = req.headers.origin || "";
  const headers = corsHeaders(origin);
  Object.entries(headers).forEach(([k, v]) => res.set(k, v));

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // 인증: 로그인 사용자(Firebase ID 토큰)만 허용
    const caller = await verifyCaller(req);
    if (!caller) {
      return res.status(401).json({ error: "Unauthorized — 로그인이 필요합니다." });
    }

    const body = req.body || {};
    const input = body.input;
    if (!input || typeof input !== "object") {
      return res.status(400).json({ error: "input 필드 필요" });
    }
    const rulebookVersion = body.rulebook_version || RULEBOOK_VERSION;

    // 1) 토글 확인
    const settings = await getToggle();
    if (!settings.useGeminiAnalysis) {
      const result = runFallback(input);
      return res.status(200).json({ ...result, _fallback: true, _toggle_off: true });
    }

    // 2) 캐시 조회
    const hash = hashInput(input, rulebookVersion);
    const cached = await readCache(hash);
    if (cached) {
      const { _cachedAt, ...rest } = cached;
      return res.status(200).json({ ...rest, _cached: true });
    }

    // 3) Gemini 호출
    try {
      const { result, meta } = await callGemini(input);
      const finalResult = { ...result, _gemini_meta: meta, _fallback: false };
      // 캐시 저장 (fire-and-forget이 아닌 await — 동일 요청 중복 호출 방지)
      await writeCache(hash, finalResult, meta);
      return res.status(200).json(finalResult);
    } catch (geminiErr) {
      console.error("[Gemini 실패 → 폴백]", {
        vessel: input.vessel_name,
        period: input.period,
        err: geminiErr.message,
      });
      const result = runFallback(input);
      return res.status(200).json({
        ...result,
        _fallback: true,
        _gemini_error: geminiErr.message,
      });
    }
  } catch (e) {
    console.error("[handler 예외]", e);
    return res.status(500).json({ error: "Internal error", message: e.message });
  }
});
