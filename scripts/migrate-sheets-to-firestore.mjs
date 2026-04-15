// ============================================================
//  Sheets → Firestore 일회성 마이그레이션 스크립트
//
//  실행 방법:
//    1. 로컬에서 firebase service account JSON 키 다운로드
//       → Firebase Console → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성
//    2. 다운받은 JSON 파일을 scripts/service-account.json 으로 저장 (.gitignore 처리 필수)
//    3. 웹에서 로그인하여 accessToken 획득 후 환경변수로 전달:
//       GOOGLE_ACCESS_TOKEN=<token> node scripts/migrate-sheets-to-firestore.mjs
// ============================================================

import { readFileSync } from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// ── 설정 ────────────────────────────────────────────────────
const SHEETS_ID = "1RwSr4jjGNfoQ-pKS-f-O-udY510yTJXnOwqcdm6Su9k";
const SERVICE_ACCOUNT_PATH = "./scripts/service-account.json";
const ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error("❌ GOOGLE_ACCESS_TOKEN 환경변수 필요");
  console.error("   웹에서 로그인 후 브라우저 devtools에서 accessToken 복사");
  process.exit(1);
}

// ── Firebase Admin 초기화 ───────────────────────────────────
const serviceAccount = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Sheets API 호출 ─────────────────────────────────────────
async function fetchSheetRange(range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Sheets ${range}: ${res.status}`);
  const json = await res.json();
  return json.values || [];
}

// ── 1. Vessels 마이그레이션 ─────────────────────────────────
async function migrateVessels() {
  console.log("\n📋 Vessels 마이그레이션 시작...");
  const rows = await fetchSheetRange("Vessels!A2:H");
  let count = 0;
  const batch = db.batch();
  for (const row of rows) {
    const [id, name, vesselCode, imoNumber, manufacturer, model, contactEmail, note] = row;
    if (!id) continue;
    batch.set(db.collection("vessels").doc(String(id)), {
      name: name || "",
      vesselCode: vesselCode || "",
      imoNumber: imoNumber || "",
      manufacturer: manufacturer || "",
      model: model || "",
      contactEmail: contactEmail || "",
      note: note || "",
      updatedAt: FieldValue.serverTimestamp(),
    });
    count++;
  }
  await batch.commit();
  console.log(`✅ Vessels ${count}건 마이그레이션 완료`);
}

// ── 2. MonthlyData 마이그레이션 ─────────────────────────────
async function migrateMonthlyData() {
  console.log("\n📊 MonthlyData 마이그레이션 시작...");
  const rows = await fetchSheetRange("MonthlyData!A2:H");
  const grouped = {};
  for (const row of rows) {
    const [vesselId, year, month, status, error, lastAnalyzed, pdfCount, resultJson] = row;
    if (!vesselId || !year || !month) continue;
    const periodId = `${year}_${String(month).padStart(2, "0")}`;
    if (!grouped[periodId]) grouped[periodId] = [];
    let analysisResult = null;
    try { analysisResult = resultJson ? JSON.parse(resultJson) : null; } catch { /* 무시 */ }
    grouped[periodId].push({
      vesselId: String(vesselId),
      data: {
        analysisStatus: status || "NO_DATA",
        analysisError: error || null,
        lastAnalyzed: lastAnalyzed || null,
        pdfCount: Number(pdfCount) || 0,
        analysisResult,
        year: Number(year),
        month: Number(month),
        updatedAt: FieldValue.serverTimestamp(),
      },
    });
  }

  let totalCount = 0;
  for (const [periodId, entries] of Object.entries(grouped)) {
    const batch = db.batch();
    for (const { vesselId, data } of entries) {
      batch.set(
        db.collection("analyses").doc(periodId).collection("vessels").doc(vesselId),
        data
      );
      totalCount++;
    }
    await batch.commit();
    console.log(`  ${periodId}: ${entries.length}건`);
  }
  console.log(`✅ MonthlyData ${totalCount}건 마이그레이션 완료`);
}

// ── 메인 실행 ───────────────────────────────────────────────
(async () => {
  try {
    await migrateVessels();
    await migrateMonthlyData();
    console.log("\n🎉 마이그레이션 전체 완료");
    process.exit(0);
  } catch (e) {
    console.error("❌ 마이그레이션 실패:", e);
    process.exit(1);
  }
})();
