// ============================================================
//  conversionService.js
//  PDF → CSV 변환 Cloud Function 호출 + Drive 업로드
// ============================================================

import { CONFIG } from "../config.js";

/**
 * PDF 파일명에서 로그 타입 감지
 * @param {string} pdfFileName
 * @returns {"EVENTLOG"|"OPERATIONTIMELOG"|"DATALOG"|"TOTAL"}
 */
export function detectLogType(pdfFileName) {
  // 공백/구분자/마침표 제거 후 대문자 — 파일명 표기 흔들림(오타·제조사 원본명) 흡수
  const name = (pdfFileName || "").toUpperCase().replace(/[\s_\-.]+/g, "");

  // EVENT: EVENTLOG / EVENTREPORT 등
  if (/EVENT/.test(name)) return "EVENTLOG";
  // OPERATION TIME: 오타 내성 — OP로 시작해 TIME으로 끝나는 변형 전부
  //   OPERATIONTIME / OPTIONTIME(오타) / OPETATIONTIME(오타) / OPTIME / OPTIMELOG ...
  if (/OP[A-Z]*TIME/.test(name)) return "OPERATIONTIMELOG";
  // DATA: DATALOG / DATAREPORT 등
  if (/DATA/.test(name)) return "DATALOG";
  // TOTAL / 제조사 원본 합본 리포트(예: ECS_..._Report) → TOTAL로 처리
  if (/TOTAL/.test(name) || /REPORT/.test(name)) return "TOTAL";

  return "TOTAL"; // 기본값
}

/**
 * CSV 파일명 생성
 * @param {string} vesselCode - 예: "KPS"
 * @param {string|number} year
 * @param {string|number} month - 1~12
 * @param {string} logType
 * @returns {string} 예: "KPS_2026_03_EVENTLOG.csv"
 */
export function buildCsvFileName(vesselCode, year, month, logType) {
  const m = String(month).padStart(2, "0");
  return `${vesselCode}_${year}_${m}_${logType}.csv`;
}

/**
 * 폴더명에서 선박코드 추출
 * "01 KPS (수신)" → "KPS"
 * "01. KPS KMTC PUSAN (수신)" → "KPS"
 */
export function extractVesselCode(folderName) {
  const m = (folderName || "").match(/\d+\.?\s+(\S+)/);
  return m ? m[1] : folderName?.replace(/[^A-Z]/gi, "") || "UNKNOWN";
}

/**
 * Cloud Function 호출 — PDF → CSV 변환
 * @param {string} fileId - Google Drive 파일 ID
 * @param {string} accessToken
 * @returns {Promise<{status:string, csv_content?:string, warning?:string, message?:string}>}
 */
export async function callCloudFunction(fileId, accessToken) {
  const res = await fetch(CONFIG.CLOUD_FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId, access_token: accessToken }),
  });

  if (!res.ok) {
    throw new Error(`Cloud Function 응답 오류: ${res.status}`);
  }

  return res.json();
}

/**
 * CSV를 Google Drive에 업로드 (multipart)
 * @param {string} folderId - 업로드 대상 폴더 ID
 * @param {string} csvName - 파일명
 * @param {string} csvContent - CSV 텍스트
 * @param {string} accessToken
 * @returns {Promise<{id:string, name:string}>}
 */
export async function uploadCsvToDrive(folderId, csvName, csvContent, accessToken) {
  const metadata = {
    name: csvName,
    parents: [folderId],
    mimeType: "text/csv",
  };

  const boundary = "---bwts_csv_upload_boundary---";
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csvContent}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive 업로드 실패 (${res.status}): ${text}`);
  }

  return res.json();
}
