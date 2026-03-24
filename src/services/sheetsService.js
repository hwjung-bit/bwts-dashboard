// ============================================================
//  Google Sheets API v4 — BWTS 데이터 공유 저장소
//  Sheet1 "Vessels"    : id | name | vesselCode | imoNumber | manufacturer | model | contactEmail | note
//  Sheet2 "MonthlyData": vesselId | year | month | analysisStatus | analysisError | lastAnalyzed | pdfCount | resultJson
// ============================================================

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

// ── Vessels (Sheet1) ─────────────────────────────────────────

const VESSEL_COLS = ["id", "name", "vesselCode", "imoNumber", "manufacturer", "model", "contactEmail", "note"];

/** Sheet1 A2:H 전체 읽기 → Vessel[] */
export async function readVessels(sheetId, accessToken) {
  const range = encodeURIComponent("Vessels!A2:H");
  const res = await fetch(`${BASE}/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Sheets readVessels: ${res.status}`);
  const json = await res.json();
  const rows = json.values || [];

  let needWriteBack = false;
  const vessels = rows
    .filter((r) => r.some((cell) => cell)) // 완전히 빈 행 skip
    .map((r) => {
      const obj = {};
      VESSEL_COLS.forEach((col, i) => { obj[col] = r[i] || ""; });
      // A열(id)이 비어있으면 자동 생성
      if (!obj.id) {
        obj.id = `vessel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        needWriteBack = true;
      }
      return obj;
    });

  // id가 새로 생성된 경우 Sheets에 다시 기록
  if (needWriteBack) {
    writeVessels(sheetId, vessels, accessToken).catch(console.warn);
  }

  return vessels;
}

/** Sheet1 전체 덮어쓰기 (clear → write) */
export async function writeVessels(sheetId, vessels, accessToken) {
  // 1. 기존 데이터 clear
  await fetch(`${BASE}/${sheetId}/values/${encodeURIComponent("Vessels!A2:H")}:clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });

  if (vessels.length === 0) return;

  // 2. 전체 재기록
  const values = vessels.map((v) => VESSEL_COLS.map((col) => v[col] ?? ""));
  const res = await fetch(
    `${BASE}/${sheetId}/values/${encodeURIComponent("Vessels!A2")}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`Sheets writeVessels: ${res.status}`);
}

// ── MonthlyData (Sheet2) ──────────────────────────────────────

const MONTHLY_COLS = ["vesselId", "year", "month", "analysisStatus", "analysisError", "lastAnalyzed", "pdfCount", "resultJson"];

/** Sheet2 전체 읽기 → 해당 년/월 선박별 Map { [vesselId]: entry } */
export async function readMonthlyData(sheetId, year, month, accessToken) {
  const range = encodeURIComponent("MonthlyData!A2:H");
  const res = await fetch(`${BASE}/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Sheets readMonthlyData: ${res.status}`);
  const json = await res.json();
  const rows = json.values || [];

  const result = {};
  for (const r of rows) {
    const vesselId = r[0];
    const rowYear  = r[1];
    const rowMonth = r[2];
    if (!vesselId || rowYear !== String(year) || rowMonth !== String(month)) continue;

    let analysisResult = null;
    try { analysisResult = r[7] ? JSON.parse(r[7]) : null; } catch { /* ignore */ }

    let status = r[3] || "NO_DATA";
    // LOADING 중단 복구
    if (status === "LOADING") {
      status = "RECEIVED";
    }

    result[vesselId] = {
      analysisStatus: status,
      analysisError:  r[4] || null,
      lastAnalyzed:   r[5] || null,
      pdfCount:       r[6] ? Number(r[6]) : 0,
      analysisResult,
    };
  }
  return result;
}

/**
 * (vesselId, year, month) 행 upsert
 * 이미 존재하면 해당 행 update, 없으면 append
 */
export async function upsertMonthlyEntry(sheetId, vesselId, year, month, entry, accessToken) {
  // 1. 전체 읽어서 해당 행 찾기
  const range = encodeURIComponent("MonthlyData!A2:H");
  const readRes = await fetch(`${BASE}/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!readRes.ok) throw new Error(`Sheets upsert read: ${readRes.status}`);
  const json = await readRes.json();
  const rows = json.values || [];

  // Sheets 셀 50,000자 제한 — 초과 시 핵심 필드만 slim 저장
  const SHEETS_CELL_LIMIT = 48000;
  let resultJson = "";
  if (entry.analysisResult != null) {
    const full = JSON.stringify(entry.analysisResult);
    if (full.length <= SHEETS_CELL_LIMIT) {
      resultJson = full;
    } else {
      const r = entry.analysisResult;
      const slim = {
        overall_status: r.overall_status,
        ai_remarks:     r.ai_remarks,
        ai_remarks_en:  r.ai_remarks_en,
        error_alarms:   r.error_alarms,
        tro_avg:        r.tro_avg,
        tro_null_ratio: r.tro_null_ratio,
        op_count:       r.op_count,
        op_hours:       r.op_hours,
        _truncated:     true,
      };
      resultJson = JSON.stringify(slim);
    }
  }
  const newRow = [
    vesselId,
    String(year),
    String(month),
    entry.analysisStatus || "NO_DATA",
    entry.analysisError  || "",
    entry.lastAnalyzed   || "",
    String(entry.pdfCount ?? ""),
    resultJson,
  ];

  // 행 인덱스 찾기 (0-based, 헤더 제외 → 실제 시트 행 = index + 2)
  const rowIndex = rows.findIndex(
    (r) => r[0] === vesselId && r[1] === String(year) && r[2] === String(month)
  );

  if (rowIndex >= 0) {
    // 기존 행 update
    const sheetRow = rowIndex + 2; // A2부터 시작
    const updateRange = encodeURIComponent(`MonthlyData!A${sheetRow}:H${sheetRow}`);
    await fetch(`${BASE}/${sheetId}/values/${updateRange}?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [newRow] }),
    });
  } else {
    // 새 행 append
    const appendRange = encodeURIComponent("MonthlyData!A:H");
    await fetch(`${BASE}/${sheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [newRow] }),
    });
  }
}

/**
 * 특정 년/월의 MonthlyData 행 전체를 NO_DATA로 초기화
 * (Sheets API는 행 삭제가 복잡하므로 내용만 비움)
 */
export async function clearMonthlyData(sheetId, year, month, accessToken) {
  const range = encodeURIComponent("MonthlyData!A2:H");
  const readRes = await fetch(`${BASE}/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!readRes.ok) return; // 실패해도 조용히 무시

  const json = await readRes.json();
  const rows = json.values || [];

  // batchUpdate로 해당 년/월 행을 빈 값으로 덮어씀
  const requests = [];
  rows.forEach((r, i) => {
    if (r[1] === String(year) && r[2] === String(month)) {
      const sheetRow = i + 2;
      requests.push({
        range: `MonthlyData!A${sheetRow}:H${sheetRow}`,
        values: [["", "", "", "", "", "", "", ""]],
      });
    }
  });

  if (requests.length === 0) return;

  await fetch(
    `${BASE}/${sheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "RAW", data: requests }),
    }
  );
}
