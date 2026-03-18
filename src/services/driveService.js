// ============================================================
//  driveService.js
//  Google Drive API를 통해 BWTS 로그 PDF를 탐색
//
//  [드라이브 폴더 구조]
//  루트폴더 / 2024 / 03월 / 01. KPS (수신) / *.pdf
// ============================================================

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/**
 * 특정 폴더의 하위 항목을 가져옴
 */
async function listFolderContents(folderId, accessToken, mimeType = null) {
  let q = `'${folderId}' in parents and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;

  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,size)",
    pageSize: "1000",
    orderBy: "name",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const res = await fetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.files || [];
}

/**
 * 연도 폴더 목록 반환 (숫자로만 이루어진 폴더)
 */
export async function listYearFolders(rootFolderId, accessToken) {
  const items = await listFolderContents(
    rootFolderId,
    accessToken,
    "application/vnd.google-apps.folder"
  );
  return items.filter((f) => /^\d{4}$/.test(f.name));
}

/**
 * 특정 연도 폴더 내의 월 폴더 목록 반환
 * 패턴: "03월" 또는 "3월"
 */
async function listMonthFolders(yearFolderId, accessToken) {
  const items = await listFolderContents(
    yearFolderId,
    accessToken,
    "application/vnd.google-apps.folder"
  );
  return items.filter((f) => /^\d{1,2}월$/.test(f.name));
}

/**
 * "수신" 폴더(선박 폴더) 목록 반환
 * 패턴: "01. KPS (수신)" 형태 → "(수신)"이 포함된 폴더
 */
async function listVesselFolders(monthFolderId, accessToken) {
  const items = await listFolderContents(
    monthFolderId,
    accessToken,
    "application/vnd.google-apps.folder"
  );
  return items.filter((f) => f.name.includes("수신"));
}

/**
 * 폴더 내 PDF 파일 목록 반환
 */
async function listPdfFiles(folderId, accessToken) {
  return await listFolderContents(folderId, accessToken, "application/pdf");
}

// ── 월 문자열 정규화 ────────────────────────────────────────
// "3" → "3월", "03" → "3월", "03월" → "3월", "3월" → "3월"
function normalizeMonth(monthStr) {
  const num = parseInt(String(monthStr).replace("월", ""), 10);
  if (isNaN(num) || num < 1 || num > 12) return null;
  return `${num}월`;
}

/**
 * 특정 연도/월의 모든 선박 폴더와 PDF 파일 정보를 수집
 *
 * @returns {Array<{vesselFolderName, pdfs: [{id,name,size}]}>}
 *   - pdfs가 빈 배열이면 "수신" 폴더가 없거나 PDF 없음 → "미수신"
 */
export async function collectMonthData(
  rootFolderId,
  year,
  month,
  accessToken
) {
  // 1. 연도 폴더 탐색
  const yearFolders = await listFolderContents(
    rootFolderId,
    accessToken,
    "application/vnd.google-apps.folder"
  );
  const yearFolder = yearFolders.find((f) => f.name === String(year));
  if (!yearFolder) {
    // 폴더가 없으면 전체 항목(파일 포함)도 확인
    const allItems = await listFolderContents(rootFolderId, accessToken);
    const allNames = allItems.map((f) => `${f.name}(${f.mimeType === "application/vnd.google-apps.folder" ? "폴더" : "파일"})`).join(", ") || "(비어있음)";
    throw new Error(`${year}년 폴더 없음. 루트 폴더 내 항목: [${allNames}]`);
  }

  // 2. 월 폴더 탐색
  const targetMonthStr = normalizeMonth(month);
  const monthFolders = await listMonthFolders(yearFolder.id, accessToken);
  const monthFolder = monthFolders.find(
    (f) => normalizeMonth(f.name) === targetMonthStr
  );
  if (!monthFolder) {
    const names = monthFolders.map((f) => f.name).join(", ") || "(비어있음)";
    throw new Error(`${year}/${month}월 폴더 없음. Drive에 있는 월 폴더: [${names}]`);
  }

  // 3. 선박(수신) 폴더 탐색
  const vesselFolders = await listVesselFolders(monthFolder.id, accessToken);

  // 4. 각 선박 폴더의 PDF 수집
  const results = await Promise.all(
    vesselFolders.map(async (vf) => {
      const pdfs = await listPdfFiles(vf.id, accessToken);
      return { vesselFolderName: vf.name, folderId: vf.id, pdfs };
    })
  );

  return results;
}

/**
 * "전체 연도" 모드: 특정 연도의 1~12월 전체 순회
 *
 * @returns {Object} { "1월": [...], "2월": [...], ... }
 */
export async function collectYearData(rootFolderId, year, accessToken) {
  const yearFolders = await listFolderContents(
    rootFolderId,
    accessToken,
    "application/vnd.google-apps.folder"
  );
  const yearFolder = yearFolders.find((f) => f.name === String(year));
  if (!yearFolder) return {};

  const monthFolders = await listMonthFolders(yearFolder.id, accessToken);
  const result = {};

  await Promise.all(
    monthFolders.map(async (mf) => {
      const vesselFolders = await listVesselFolders(mf.id, accessToken);
      const pdfs = await Promise.all(
        vesselFolders.map(async (vf) => {
          const files = await listPdfFiles(vf.id, accessToken);
          return { vesselFolderName: vf.name, folderId: vf.id, pdfs: files };
        })
      );
      result[normalizeMonth(mf.name)] = pdfs;
    })
  );

  return result;
}

/**
 * Drive 파일의 직접 링크 (Gemini File URI용)
 */
export function getDriveFileUri(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
}
