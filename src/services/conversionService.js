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
  const name = (pdfFileName || "").toUpperCase();
  if (name.includes("EVENTLOG") || name.includes("EVENT_LOG"))           return "EVENTLOG";
  if (name.includes("OPERATIONTIME") || name.includes("OPERATION_TIME")) return "OPERATIONTIMELOG";
  if (name.includes("DATALOG") || name.includes("DATA_LOG") || name.includes("DATAREPORT")) return "DATALOG";
  if (name.includes("TOTALLOG") || name.includes("TOTAL"))              return "TOTAL";
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
