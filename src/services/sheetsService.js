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
  const res = await fetch(`${BASE}/${sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Sheets readVessels: ${res.status}`);
  const json = await res.json();
  const rows = json.values || [];

  let needWriteBack = false;
  const vessels = rows
    .filter((r) => r.some((cell) => cell)) // 완전히 빈 행 skip
    .map((rawRow) => {
      // 행 길이 보장 (trailing empty cells 누락 방지)
      const r = [...rawRow, ...Array(VESSEL_COLS.length).fill("")].slice(0, VESSEL_COLS.length);
      const obj = {};
      VESSEL_COLS.forEach((col, i) => { obj[col] = String(r[i] ?? ""); });
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
  const res = await fetch(`${BASE}/${sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Sheets readMonthlyData: ${res.status}`);
  const json = await res.json();
  const rows = json.values || [];

  const result = {};
  for (const rawRow of rows) {
    // 행 길이 보장 (trailing empty cells 누락 방지)
    const r = [...rawRow, ...Array(MONTHLY_COLS.length).fill("")].slice(0, MONTHLY_COLS.length);
    const vesselId = String(r[0] ?? "");
    const rowYear  = String(r[1] ?? "");
    const rowMonth = String(r[2] ?? "");
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
  const readRes = await fetch(`${BASE}/${sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
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

  // 빈 행 제외하고 실제 시트 행 번호를 직접 추적 (빈 행 끼면 rowIndex+2 오계산 방지)
  const dataRows = rows
    .map((r, i) => ({ r, sheetRow: i + 2 }))
    .filter(({ r }) => r.length > 0 && r[0]);
  const match = dataRows.find(
    ({ r }) => String(r[0]) === vesselId && String(r[1]) === String(year) && String(r[2]) === String(month)
  );

  if (match) {
    // 기존 행 update
    const sheetRow = match.sheetRow;
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

// ── Calibration History ───────────────────────────────────────

/**
 * 스프레드시트의 모든 탭 이름 조회 (디버그용)
 * @returns {Promise<string[]>}
 */
export async function listSheetNames(spreadsheetId, accessToken) {
  const res = await fetch(
    `${BASE}/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return [];
  const json = await res.json();
  return (json.sheets || []).map((s) => s.properties.title);
}

/**
 * GID로 시트 탭명 조회
 * @returns {Promise<string|null>}
 */
export async function getSheetNameByGid(spreadsheetId, gid, accessToken) {
  const res = await fetch(
    `${BASE}/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`getSheetNameByGid: ${res.status}`);
  const json = await res.json();
  const sheet = (json.sheets || []).find(
    (s) => s.properties.sheetId === Number(gid)
  );
  return sheet?.properties?.title ?? null;
}

/**
 * 검교정 데이터 읽기 — batchGet + URLSearchParams 방식으로 인코딩 문제 회피
 * @returns {Promise<Array<{rowIndex,vesselCode,note,date,status}>>}
 */
export async function readCalibration(spreadsheetId, sheetName, accessToken) {
  const rangeStr = `'${sheetName}'!A1:D23`;
  const params = new URLSearchParams({
    ranges: rangeStr,
    valueRenderOption: "FORMATTED_VALUE",  // 날짜 셀을 "2025. 9. 6." 형태 문자열로 반환
  });
  const res = await fetch(
    `${BASE}/${spreadsheetId}/values:batchGet?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`readCalibration: ${res.status}`);
  const json = await res.json();
  const rows = json.valueRanges?.[0]?.values || [];
  // 헤더 2행 skip → index 2 이후가 데이터
  return rows.slice(2).map((r, i) => ({
    rowIndex:   i + 3,
    vesselCode: r[0] || "",
    note:       r[1] || "",
    date:       r[2] || "",
    status:     r[3] || "",
  }));
}

/**
 * 단일 셀 업데이트
 * @param {string} col - 'B'(특이사항) | 'C'(날짜) | 'D'(진행상황)
 */
export async function updateCalibCell(spreadsheetId, sheetName, rowIndex, col, value, accessToken) {
  const rangeStr = `'${sheetName}'!${col}${rowIndex}`;
  const params = new URLSearchParams({ valueInputOption: "USER_ENTERED" });
  const res = await fetch(
    `${BASE}/${spreadsheetId}/values/${encodeURIComponent(rangeStr)}?${params}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[value]] }),
    }
  );
  if (!res.ok) throw new Error(`updateCalibCell: ${res.status}`);
}

/**
 * 특정 년/월의 MonthlyData 행 전체를 NO_DATA로 초기화
 * (Sheets API는 행 삭제가 복잡하므로 내용만 비움)
 */
export async function clearMonthlyData(sheetId, year, month, accessToken) {
  const range = encodeURIComponent("MonthlyData!A2:H");
  const readRes = await fetch(`${BASE}/${sheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!readRes.ok) return; // 실패해도 조용히 무시

  const json = await readRes.json();
  const rows = json.values || [];

  // batchUpdate로 해당 년/월 행을 빈 값으로 덮어씀
  const requests = [];
  rows.forEach((r, i) => {
    if (String(r[1] ?? "") === String(year) && String(r[2] ?? "") === String(month)) {
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
