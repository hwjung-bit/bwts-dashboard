/**
 * BWTS LOG DATA 자동 저장 + CSV 변환 스크립트
 *
 * [처리 흐름]
 * 1. Gmail에서 BWTS 로그 메일 검색 (최근 2개월)
 * 2. 이미 처리된 메일은 (수신) 폴더 존재 여부로 판단
 * 3. 첨부파일명이 표준 형식이면 파일명에서 직접 파싱
 * 4. 비표준이면 기존 방식(제목/본문)으로 선박·날짜 추출
 * 5. 연도 > 월 > 선박 폴더 구조로 저장
 *    - PDF 파일명을 표준 형식으로 통일: {코드}_{연도}_{월}_{로그타입}.pdf
 * 6. PDF 저장 후 Cloud Function 호출 → CSV 자동 생성
 * 7. ZIP 처리 (5개 이하 해제, 6개 이상 유지)
 */

// ── 설정 ──────────────────────────────────────────────────────────────────────
const CONFIG = {
  MAIN_ROOT_ID:       '1uyWbZUdTIkegHJUBnC5MQs4QEWQanBxE',
  SHIP_REF_FOLDER_ID: '1UouETwPdXvyYCHFI5F40O-rvy3vwE-JS',
  BASE_QUERY:         'subject:(BWTS LOG DATA OR "BWTS LOG" OR "BWTS LOG DATA")',
  CLOUD_FUNCTION_URL: 'https://asia-northeast3-bwts-log-analysis.cloudfunctions.net/convert-pdf',
  MONTH_MAP: {
    'JAN':'01','JANUARY':'01','1월':'01',
    'FEB':'02','FEBRUARY':'02','2월':'02',
    'MAR':'03','MARCH':'03','3월':'03',
    'APR':'04','APRIL':'04','4월':'04',
    'MAY':'05','5월':'05',
    'JUN':'06','JUNE':'06','6월':'06',
    'JUL':'07','JULY':'07','7월':'07',
    'AUG':'08','AUGUST':'08','8월':'08',
    'SEP':'09','SEPTEMBER':'09','9월':'09',
    'OCT':'10','OCTOBER':'10','10월':'10',
    'NOV':'11','NOVEMBER':'11','11월':'11',
    'DEC':'12','DECEMBER':'12','12월':'12'
  }
};

// ── 선박 목록 ────────────────────────────────────────────────────────────────
const SHIP_LIST = [
  { number:'01', code:'KPS', name:'KMTC PUSAN'       },
  { number:'02', code:'KUS', name:'KMTC ULSAN'       },
  { number:'03', code:'KKL', name:'KMTC KEELUNG'     },
  { number:'04', code:'KSG', name:'KMTC SINGAPORE'   },
  { number:'05', code:'KJT', name:'KMTC JAKARTA'     },
  { number:'06', code:'KSH', name:'KMTC SHANGHAI'    },
  { number:'07', code:'KQD', name:'KMTC QINGDAO'     },
  { number:'08', code:'KTJ', name:'KMTC TIANJIN'     },
  { number:'09', code:'KHM', name:'KMTC HOCHIMINH'   },
  { number:'10', code:'KNB', name:'KMTC NINGBO'      },
  { number:'11', code:'KSZ', name:'KMTC SHENZHEN'    },
  { number:'12', code:'KMB', name:'KMTC MUMBAI'      },
  { number:'13', code:'KDB', name:'KMTC DUBAI'       },
  { number:'14', code:'KCN', name:'KMTC CHENNAI'     },
  { number:'15', code:'KJA', name:'KMTC JEBEL ALI'   },
  { number:'16', code:'KNH', name:'KMTC NHAVA SHEVA' },
  { number:'17', code:'KMN', name:'KMTC MANILA'      },
  { number:'18', code:'KMU', name:'KMTC MUNDRA'      },
  { number:'19', code:'KCB', name:'KMTC COLOMBO'     },
  { number:'20', code:'KSL', name:'KMTC SEOUL'       },
  { number:'21', code:'KDE', name:'KMTC DELHI'       }
];

// ── 메인 ─────────────────────────────────────────────────────────────────────
function main() {
  const searchBaseDate = new Date();
  searchBaseDate.setMonth(searchBaseDate.getMonth() - 2);
  const afterDate = `${searchBaseDate.getFullYear()}/${(searchBaseDate.getMonth()+1).toString().padStart(2,'0')}/01`;
  const finalQuery = `${CONFIG.BASE_QUERY} after:${afterDate}`;
  Logger.log(`검색 쿼리: ${finalQuery}`);

  const threads = GmailApp.search(finalQuery);
  if (threads.length === 0) { Logger.log('처리할 메일 없음'); return; }

  const folderCache = {};
  let savedCount = 0;
  let skippedCount = 0;

  threads.forEach(thread => {
    let isSaved = false;

    thread.getMessages().forEach(message => {
      const subject     = message.getSubject();
      const attachments = message.getAttachments();
      if (attachments.length === 0) return;

      attachments.forEach(att => {
        const fileName = att.getName();
        if (!fileName.toLowerCase().endsWith('.pdf') &&
            !fileName.toLowerCase().endsWith('.zip')) return;

        // BWRB 파일 제외
        if (fileName.toUpperCase().includes('BWRB')) {
          Logger.log(`[BWRB 제외] ${fileName}`);
          return;
        }

        // [1순위] 표준 파일명 파싱 시도
        const parsed = parseStandardFilename(fileName);

        if (parsed) {
          Logger.log(`[표준 파싱 성공] ${fileName}`);
          saveAttachments([att], parsed.ship, parsed.year, parsed.month + '월', parsed.logType, folderCache);
          isSaved = true;
        } else {
          // [2순위] 기존 방식: 제목·본문 분석 + 파일명에서 로그타입 감지
          Logger.log(`[폴백 방식] ${fileName}`);
          const extracted = extractDateFromEmail(message);
          const ship      = findShipInSubject(subject) || findShipInFilename(fileName);
          const logType   = detectLogTypeFromFilename(fileName);
          if (ship) {
            saveAttachments([att], ship, extracted.year, extracted.month, logType, folderCache);
            isSaved = true;
          } else {
            Logger.log(`선박 식별 불가: ${subject} / ${fileName}`);
          }
        }
      });
    });

    if (isSaved) {
      Logger.log(`저장 완료: ${thread.getFirstMessageSubject()}`);
      savedCount++;
    } else {
      skippedCount++;
    }
  });

  Logger.log(`[완료] 총 ${threads.length}건 검색 / 저장 ${savedCount}건 / 스킵 ${skippedCount}건`);
}

// ── 표준 파일명 파싱 (KPS_2026_01_EVENTLOG.pdf) ──────────────────────────────
function parseStandardFilename(fileName) {
  const base = fileName
    .replace(/\.(pdf|zip)$/i, '')
    .replace(/[\s\-]+/g, '_')
    .toUpperCase();

  const match = base.match(/^([A-Z]{2,4})_(\d{4})_(\d{1,2})_(.+)/);
  if (!match) return null;

  const [, code, year, month, typeStr] = match;

  const ship = SHIP_LIST.find(s => s.code === code);
  if (!ship) return null;

  const logType = normalizeLogType(typeStr);
  if (!logType) return null;

  return {
    ship,
    year,
    month: month.padStart(2, '0'),
    logType
  };
}

// ── 로그 타입 정규화 ──────────────────────────────────────────────────────────
function normalizeLogType(str) {
  const t = str.replace(/[\s_\-]/g, '').toUpperCase();
  if (/EVENT/.test(t))                              return 'EVENTLOG';
  if (/OPERATIONTIME|OPTIME|OPERTIME/.test(t))      return 'OPERATIONTIMELOG';
  if (/^DATA$|DATALOG|DATAREPORT|DATAREP/.test(t))  return 'DATALOG';
  if (/TOTALLOG|^TOTAL$/.test(t))                   return 'TOTALLOG';
  return null;
}

// ── 비표준 파일명에서 로그타입 감지 ───────────────────────────────────────────
// 예: "ECS_KMTC PUSAN_DataReport_2026-3-7.pdf" → DATALOG
//     "KMTC TIANJIN_EventLogReport_2026-04-01.pdf" → EVENTLOG
//     "KMTC SHANGHAI_ECS_Operation_Time_2026-03-31.pdf" → OPERATIONTIMELOG
function detectLogTypeFromFilename(fileName) {
  const name = fileName.replace(/[\s_\-]+/g, '').toUpperCase();
  if (/EVENTLOG|EVENTREPORT/.test(name))             return 'EVENTLOG';
  if (/OPERATIONTIME|OPTIME/.test(name))             return 'OPERATIONTIMELOG';
  if (/DATALOG|DATAREPORT|DATAREP/.test(name))       return 'DATALOG';
  if (/TOTALLOG|TOTAL/.test(name))                   return 'TOTALLOG';
  // 기본값: 단일 파일이면 TOTALLOG로 간주
  return 'TOTALLOG';
}

// ── 파일명에서 선박 찾기 (폴백) ─────────────────────────────────────────────
// "ECS_KMTC PUSAN_DataReport.pdf" → KPS
function findShipInFilename(fileName) {
  const norm = fileName.replace(/\s+/g, '').toUpperCase();
  return SHIP_LIST.find(ship =>
    norm.includes(ship.code.toUpperCase()) ||
    norm.includes(ship.name.replace(/\s+/g, '').toUpperCase())
  ) || null;
}

// ── 이메일에서 날짜 추출 (가중치 방식) ───────────────────────────────────────
function extractDateFromEmail(message) {
  const subject     = message.getSubject();
  const body        = message.getPlainBody();
  const attachments = message.getAttachments();
  const messageDate = message.getDate();
  const candidates  = [];

  const datePatterns = [
    /(20\d{2}|\d{2})[.\/\-\s]+(\d{1,2})[.\/\-\s]+(\d{1,2})/g,
    /(20\d{2}|\d{2})[.\/\-\s]+(\d{1,2})/g,
    /(\d{4})년(?:도)?\s*(\d{1,2})월/g
  ];

  const sortedKeywords = Object.entries(CONFIG.MONTH_MAP)
    .sort((a, b) => b[0].length - a[0].length);

  function getSmartDate(y, m, d) {
    let year  = parseInt(y.length === 2 ? '20' + y : y);
    let month = parseInt(m);
    let day   = d ? parseInt(d) : 20;
    if (day <= 15) { month--; if (month === 0) { month = 12; year--; } }
    return { year: year.toString(), month: month.toString().padStart(2,'0') + '월' };
  }

  function collect(text, score, isPattern) {
    if (!text) return;
    if (isPattern) {
      datePatterns.forEach(p => {
        p.lastIndex = 0;
        let m;
        while ((m = p.exec(text)) !== null)
          candidates.push({ ...getSmartDate(m[1], m[2], m[3]), score });
      });
    } else {
      const upper = text.toUpperCase();
      sortedKeywords.forEach(([key, val]) => {
        if (upper.includes(key)) {
          let yr  = messageDate.getFullYear();
          let mon = parseInt(val);
          if (mon > messageDate.getMonth() + 1) yr--;
          candidates.push({ year: yr.toString(), month: val + '월', score });
        }
      });
    }
  }

  attachments.forEach(att => {
    collect(att.getName(), 5.0, true);
    collect(att.getName(), 4.5, false);
  });
  collect(subject, 4.0, true);
  collect(subject, 3.5, false);
  collect(body,    2.0, true);
  collect(body,    1.5, false);

  const backup = getSmartDate(
    messageDate.getFullYear().toString(),
    (messageDate.getMonth() + 1).toString(),
    messageDate.getDate().toString()
  );
  candidates.push({ ...backup, score: 0.5 });

  const scoreMap = {};
  candidates.forEach(c => {
    const key = `${c.year}-${c.month}`;
    if (!scoreMap[key]) scoreMap[key] = { ...c, score: 0 };
    scoreMap[key].score += c.score;
  });
  const result = Object.values(scoreMap).reduce((best, curr) =>
    (!best || curr.score > best.score) ? curr : best, null);

  Logger.log(`[날짜 분석] 최종결정: ${result.year}-${result.month}`);
  return result;
}

// ── 제목에서 선박 찾기 ────────────────────────────────────────────────────────
function findShipInSubject(subject) {
  const norm = subject.replace(/\s+/g, '').toUpperCase();
  return SHIP_LIST.find(ship =>
    norm.includes(ship.code.toUpperCase()) ||
    norm.includes(ship.name.replace(/\s+/g, '').toUpperCase())
  ) || null;
}

// ── 첨부파일 저장 + CSV 자동 변환 ─────────────────────────────────────────────
function saveAttachments(attachments, ship, year, month, logType, cache) {
  const missingFolderName  = `${ship.number} ${ship.code} (미수신)`;
  const receivedFolderName = `${ship.number} ${ship.code} (수신)`;
  const rootFolder = DriveApp.getFolderById(CONFIG.MAIN_ROOT_ID);

  // 월 문자열 정규화: "03월" → "03월", "3월" → "03월"
  const monthNum = month.replace(/\D/g, '').padStart(2, '0');
  const monthStr = monthNum + '월';

  const cacheKeyY = `Y_${year}`;
  const cacheKeyM = `M_${year}_${monthStr}`;

  if (!cache[cacheKeyY]) cache[cacheKeyY] = getOrCreateFolder(rootFolder, year);
  if (!cache[cacheKeyM]) cache[cacheKeyM] = getOrCreateFolder(cache[cacheKeyY], monthStr);

  const monthFolder = cache[cacheKeyM];

  // (수신) 이미 있으면 스킵
  if (monthFolder.getFoldersByName(receivedFolderName).hasNext()) {
    Logger.log(`스킵 (이미 수신): ${receivedFolderName}`);
    return;
  }

  // (미수신) 있으면 → (수신)으로 변경 / 없으면 → (수신) 바로 생성
  let shipFolder;
  const missingFolders = monthFolder.getFoldersByName(missingFolderName);
  if (missingFolders.hasNext()) {
    shipFolder = missingFolders.next();
    shipFolder.setName(receivedFolderName);
    Logger.log(`폴더명 변경: ${missingFolderName} → ${receivedFolderName}`);
  } else {
    shipFolder = getOrCreateFolder(monthFolder, receivedFolderName);
    Logger.log(`폴더 생성: ${receivedFolderName}`);
  }

  const cacheKeyS = `S_${year}_${monthStr}_${receivedFolderName}`;
  cache[cacheKeyS] = shipFolder;

  // ── 파일 저장 헬퍼 ──────────────────────────────────────────────────────
  function saveBlob(blob, name) {
    if (!shipFolder.getFilesByName(name).hasNext()) {
      const file = shipFolder.createFile(blob).setName(name);
      Logger.log(`저장: ${year}/${monthStr}/${receivedFolderName} > ${name}`);
      return file;
    } else {
      Logger.log(`건너뜀(이미 존재): ${name}`);
      return null;
    }
  }

  function deleteDriveFile(name) {
    const files = shipFolder.getFilesByName(name);
    if (files.hasNext()) {
      files.next().setTrashed(true);
      Logger.log(`ZIP 삭제: ${year}/${monthStr}/${receivedFolderName} > ${name}`);
    }
  }

  attachments.forEach(att => {
    const fileName    = att.getName();
    const contentType = att.getContentType();

    // ── ZIP ─────────────────────────────────────────────────────────────────
    if (fileName.toLowerCase().endsWith('.zip') ||
        contentType === 'application/zip' ||
        contentType === 'application/x-zip-compressed') {
      saveBlob(att.copyBlob(), fileName);
      try {
        const blobs = Utilities.unzip(att.copyBlob());
        Logger.log(`[ZIP] ${fileName} → 내부 파일 ${blobs.length}개`);
        if (blobs.length <= 5) {
          blobs.forEach(b => {
            const innerName = b.getName();
            if (innerName.toLowerCase().endsWith('.pdf')) {
              const innerLogType = logType || detectLogTypeFromFilename(innerName);
              let stdName = buildStandardFilename(ship.code, year, monthNum, innerLogType, 'pdf');
              let sfx = 1;
              while (shipFolder.getFilesByName(stdName).hasNext()) { sfx++; stdName = buildStandardFilename(ship.code, year, monthNum, innerLogType + '_' + sfx, 'pdf'); }
              const savedFile = saveBlob(b, stdName);
              if (savedFile && innerLogType !== 'TOTALLOG') convertToCsv(savedFile.getId(), shipFolder.getId(), ship.code, year, monthNum, innerLogType);
            } else {
              saveBlob(b, innerName);
            }
          });
          deleteDriveFile(fileName);
        } else {
          Logger.log(`[ZIP 유지] 파일 ${blobs.length}개 → ZIP 그대로 보관`);
        }
      } catch(e) {
        Logger.log(`압축 해제 실패(${fileName}): ${e.message} → ZIP 그대로 보관`);
      }
      return;
    }

    // ── PDF ─────────────────────────────────────────────────────────────────
    if (fileName.toLowerCase().endsWith('.pdf')) {
      const finalLogType = logType || detectLogTypeFromFilename(fileName);
      let stdName = buildStandardFilename(ship.code, year, monthNum, finalLogType, 'pdf');

      // 같은 로그타입 중복 시 _2, _3 붙이기
      let suffix = 1;
      while (shipFolder.getFilesByName(stdName).hasNext()) {
        suffix++;
        stdName = buildStandardFilename(ship.code, year, monthNum, finalLogType + '_' + suffix, 'pdf');
      }

      const savedFile = saveBlob(att.copyBlob(), stdName);

      // PDF 저장 성공 → CSV 자동 변환 (TOTALLOG은 너무 크므로 스킵)
      if (savedFile && finalLogType !== 'TOTALLOG') {
        convertToCsv(savedFile.getId(), shipFolder.getId(), ship.code, year, monthNum, finalLogType);
      } else if (savedFile && finalLogType === 'TOTALLOG') {
        Logger.log(`[CSV 스킵] TOTALLOG는 대용량이므로 CSV 변환 제외: ${stdName}`);
      }
      return;
    }

    // ── 기타 파일 ─────────────────────────────────────────────────────────
    saveBlob(att.copyBlob(), fileName);
  });
}

// ── 표준 파일명 생성 ─────────────────────────────────────────────────────────
// buildStandardFilename('KPS', '2026', '03', 'DATALOG', 'pdf')
// → "KPS_2026_03_DATALOG.pdf"
function buildStandardFilename(code, year, month, logType, ext) {
  return `${code}_${year}_${month}_${logType}.${ext}`;
}

// ── Cloud Function 호출 → CSV 자동 변환 + Drive 저장 ─────────────────────────
function convertToCsv(pdfFileId, folderId, shipCode, year, month, logType) {
  const csvName = buildStandardFilename(shipCode, year, month, logType, 'csv');

  // 이미 CSV 존재하면 스킵
  const folder = DriveApp.getFolderById(folderId);
  if (folder.getFilesByName(csvName).hasNext()) {
    Logger.log(`[CSV 스킵] 이미 존재: ${csvName}`);
    return;
  }

  try {
    Logger.log(`[CSV 변환 시작] ${csvName}`);
    const token = ScriptApp.getOAuthToken();

    const response = UrlFetchApp.fetch(CONFIG.CLOUD_FUNCTION_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        file_id: pdfFileId,
        access_token: token
      }),
      muteHttpExceptions: true
    });

    const result = JSON.parse(response.getContentText());

    if (result.status === 'success' && result.csv_content) {
      folder.createFile(csvName, result.csv_content, MimeType.CSV);
      Logger.log(`[CSV 저장 완료] ${csvName} (${result.rows || '?'}행)`);
    } else if (result.status === 'skipped') {
      Logger.log(`[CSV 스킵] ${result.reason || 'BWRB'}`);
    } else {
      Logger.log(`[CSV 변환 실패] ${csvName}: ${result.message || '알 수 없는 오류'}`);
    }
  } catch (e) {
    Logger.log(`[CSV 변환 에러] ${csvName}: ${e.message}`);
  }
}

// ── 폴더 조회/생성 (재시도 포함) ─────────────────────────────────────────────
function getOrCreateFolder(parent, folderName) {
  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      const it = parent.getFoldersByName(folderName);
      if (it.hasNext()) return it.next();
      return parent.createFolder(folderName);
    } catch(e) {
      lastError = e;
      Logger.log(`[Drive 재시도 ${i+1}/3] ${folderName}: ${e.message}`);
      Utilities.sleep(1000 * (i + 1));
    }
  }
  throw new Error(`Drive 오류: ${lastError.message}`);
}
