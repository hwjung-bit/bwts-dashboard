// ============================================================
//  logParser.js  ─  Stage 0: ECS 로그 결정론적 파싱
//
//  pdfjs TextItem의 X/Y 좌표를 이용해 표 구조를 복원.
//  TRO 수치·운전 횟수를 JS 코드로 직접 계산 → AI 오추출 방지.
//
//  exports:
//    parseEcsLogStructured(pdfDoc, sections, totalPages)
//      → { operations, tro_data } 또는 null
// ============================================================

// ── 페이지 → 행(row) 배열 변환 ─────────────────────────────
// 같은 Y 좌표 ± Y_TOL 내 아이템을 한 행으로 묶고,
// 행 내부는 X(좌→우) 순으로 정렬.
const Y_TOL = 2; // pt tolerance for same-row grouping

async function extractPageRows(pdfDoc, pageNum) {
  try {
    const page    = await pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();

    const yMap = new Map();
    for (const item of content.items) {
      const str = (item.str || '').trim();
      if (!str) continue;
      const y = Math.round(item.transform[5] / Y_TOL) * Y_TOL;
      if (!yMap.has(y)) yMap.set(y, []);
      yMap.get(y).push({ str, x: item.transform[4] });
    }

    // 위→아래 순서 (PDF 좌표 = 아래가 0이므로 Y 내림차순)
    return Array.from(yMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([y, cells]) => ({
        y,
        cells: cells.sort((a, b) => a.x - b.x),
      }));
  } catch {
    return [];
  }
}

async function extractPagesRows(pdfDoc, startPage, endPage) {
  const allRows = [];
  const end = Math.min(endPage, pdfDoc.numPages);
  for (let p = startPage; p <= end; p++) {
    allRows.push(...(await extractPageRows(pdfDoc, p)));
  }
  return allRows;
}

// ── Voronoi 컬럼 매처 ──────────────────────────────────────
// 헤더 행의 각 컬럼 X 중심점 사이의 중간값을 경계로 삼아
// 임의 X 좌표를 가장 가까운 컬럼명으로 매핑.
function buildColMatcher(headerRow) {
  // 헤더 셀을 X 오름차순으로 정렬
  const cols = headerRow.cells
    .map(c => ({ name: c.str.trim().toUpperCase(), x: c.x }))
    .sort((a, b) => a.x - b.x);

  if (cols.length === 0) return () => null;

  // 이웃 컬럼 사이 경계(midpoint) 계산
  const bounds = [];
  for (let i = 0; i < cols.length - 1; i++) {
    bounds.push((cols[i].x + cols[i + 1].x) / 2);
  }

  return function matchCol(x) {
    for (let i = 0; i < bounds.length; i++) {
      if (x < bounds[i]) return cols[i].name;
    }
    return cols[cols.length - 1].name;
  };
}

// 행의 셀들을 { 컬럼명: 값 } 맵으로 변환
// 같은 컬럼에 여러 셀(GPS 등)이 있으면 공백으로 합침
function rowToMap(row, matchCol) {
  const result = {};
  for (const cell of row.cells) {
    const col = matchCol(cell.x);
    if (col) {
      result[col] = result[col] ? result[col] + ' ' + cell.str : cell.str;
    }
  }
  return result;
}

// ── ECS Data Log 파서 ──────────────────────────────────────
function isDataLogHeader(row) {
  const text = row.cells.map(c => c.str.toUpperCase()).join(' ');
  return text.includes('INDEX') && text.includes('OPERATION') &&
    (text.includes('TRO') || text.includes('REC'));
}

export function parseDataLog(rows) {
  // 1. 헤더 행 탐색 (첫 번째만 사용)
  let hIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (isDataLogHeader(rows[i])) { hIdx = i; break; }
  }
  if (hIdx < 0) { console.warn('[Stage0/DataLog] Header not found'); return null; }

  const headerRow = rows[hIdx];
  const colNames  = headerRow.cells.map(c => c.str.trim().toUpperCase());
  const matchCol  = buildColMatcher(headerRow);
  console.log('[Stage0/DataLog] cols:', colNames.join(' | '));

  // 2. 관련 컬럼명 식별
  const troBNames = colNames.filter(n =>
    /^TRO_B\d*$/.test(n) || n === 'TRO1' || n === 'T1' || n === 'TRO');
  const troDNames = colNames.filter(n =>
    /^TRO_D\d*$/.test(n) || /^TRO_S\d*$/.test(n) || n === 'TRO2' || n === 'T2');
  const opName    = 'OPERATION';
  const ecuName   = colNames.find(n => /REC1_CURRENT|REC_CURRENT|ECU_I|CURRENT/.test(n) && !n.includes('VOLTAGE')) ?? null;
  const fmuName   = colNames.find(n => /^FMU\d*$/.test(n) && !n.includes('_ST')) ?? null;
  const anuName   = colNames.find(n => /^ANU_D\d*$|^ANU_S\d*$/.test(n)) ?? null;

  if (!colNames.includes(opName)) { console.warn('[Stage0/DataLog] No OPERATION col'); return null; }

  // 3. 데이터 행 파싱
  const ballastTROs   = [];
  const deballastTROs = [];
  const ecuValues     = [];
  const fmuValues     = [];
  let anuOp = 0, anuAll = 0;
  let counted = 0;
  let seenHeaders = 0; // 페이지마다 헤더 반복 → 스킵용

  for (let i = hIdx + 1; i < rows.length; i++) {
    const cells = rows[i].cells;
    if (cells.length < 4) continue;

    // 헤더 반복 감지 (페이지 상단마다 재등장) → 스킵
    if (isDataLogHeader(rows[i])) { seenHeaders++; continue; }

    // 첫 셀이 정수(INDEX)여야 함
    if (!/^\d+$/.test(cells[0].str)) continue;

    const row = rowToMap(rows[i], matchCol);
    const op  = (row[opName] || '').trim().toUpperCase();

    const isBallast   = op === 'BALLAST'   || /^\d+-?B$/.test(op);
    const isDeballast = op === 'DEBALLAST' || /^\d+-?D$/.test(op);
    const isStripping = op === 'STRIPPING' || /^\d+-?S$/.test(op);
    if (!isBallast && !isDeballast && !isStripping) continue;
    counted++;

    // TRO 추출
    if (isBallast) {
      for (const n of troBNames) {
        const v = parseFloat(row[n]);
        if (!isNaN(v) && v >= 0.1 && v <= 15) ballastTROs.push(v);
      }
    }
    if (isDeballast || isStripping) {
      for (const n of troDNames) {
        const v = parseFloat(row[n]);
        if (!isNaN(v) && v >= 0 && v <= 15) deballastTROs.push(v);
      }
    }

    // ECU 전류 (>50A = 실제 운전 중)
    if (ecuName) {
      const v = parseFloat(row[ecuName]);
      if (!isNaN(v) && v > 50) ecuValues.push(v);
    }

    // FMU 유량
    if (fmuName) {
      const v = parseFloat(row[fmuName]);
      if (!isNaN(v) && v > 0) fmuValues.push(v);
    }

    // ANU 상태
    if (anuName) {
      const v = parseFloat(row[anuName]);
      if (!isNaN(v)) { anuAll++; if (v > 0) anuOp++; }
    }
  }

  console.log(`[Stage0/DataLog] ${counted} op rows | B-TRO:${ballastTROs.length}건 | D-TRO:${deballastTROs.length}건 | headers repeated:${seenHeaders}`);

  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
  const max = arr => arr.length ? +(Math.max(...arr)).toFixed(2) : null;

  return {
    ballasting_avg:   avg(ballastTROs),
    deballasting_max: max(deballastTROs),
    ecu_current_avg:  avg(ecuValues),
    fmu_flow_avg:     avg(fmuValues),
    anu_status: anuAll > 0 ? (anuOp / anuAll > 0.3 ? 'Operating' : 'Standby') : null,
  };
}

// ── Event Log VRCS 밸브 채터링 감지 ────────────────────────
const VRCS_MIN_COUNT    = 10;  // 10회 이상 반복 시 채터링 판정
const VRCS_SAMPLE_PAGES = 50;  // 이벤트로그 마지막 N페이지 샘플

/** Event Log 행에서 밸브 채터링 패턴 감지
 *  "Valve Opened.[BA008F,]" / "Valve Closed.[BA008F,]" 반복 집계
 *  반환: [{ valve, count }, ...] count 내림차순
 */
function parseEventLogForVrcs(rows) {
  const counts = {};
  for (const row of rows) {
    const text = row.cells.map(c => c.str).join(' ');
    const m = text.match(/Valve\s+(?:Opened|Closed)\.\[([^\],]+)/i);
    if (m) {
      const valve = m[1].trim();
      counts[valve] = (counts[valve] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .filter(([, cnt]) => cnt >= VRCS_MIN_COUNT)
    .sort((a, b) => b[1] - a[1])
    .map(([valve, count]) => ({ valve, count }));
}

// ── ECS Op Time Log 파서 ───────────────────────────────────
function isOpTimeLogHeader(row) {
  const text = row.cells.map(c => c.str.toUpperCase()).join(' ');
  return text.includes('OPERATION') &&
    (text.includes('START') || text.includes('RUNNING') || text.includes('RUN TIME'));
}

function parseRunTime(str) {
  if (!str) return null;
  // "0:46", "1:05:22", "0:46:00"
  const m = (str.trim()).match(/^(\d+):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  return +(parseInt(m[1]) + parseInt(m[2]) / 60).toFixed(2);
}

function extractDateTime(str) {
  if (!str) return { date: null, time: null };
  const dt = str.match(/(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2})/);
  if (dt) return { date: dt[1].replace(/-(\d)-/, '-0$1-').replace(/-(\d)$/, '-0$1'), time: dt[2] };
  const t = str.match(/(\d{1,2}:\d{2})/);
  if (t) return { date: null, time: t[1] };
  return { date: null, time: null };
}

export function parseOpTimeLog(rows) {
  // 헤더 탐색
  let hIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (isOpTimeLogHeader(rows[i])) { hIdx = i; break; }
  }
  if (hIdx < 0) { console.warn('[Stage0/OpTime] Header not found'); return null; }

  const headerRow = rows[hIdx];
  const colNames  = headerRow.cells.map(c => c.str.trim().toUpperCase());
  const matchCol  = buildColMatcher(headerRow);
  console.log('[Stage0/OpTime] cols:', colNames.join(' | '));

  // 컬럼 키 식별
  const opKey  = colNames.find(n => n === 'OPERATION' || n === 'OP' || n === 'MODE') ?? null;
  const stKey  = colNames.find(n => n.includes('START')) ?? null;
  const etKey  = colNames.find(n => n.includes('END')) ?? null;
  const rtKey  = colNames.find(n => n.includes('RUNNING') || n === 'RUN TIME' || n === 'RT') ?? null;
  const volKey = colNames.find(n => n.includes('VOLUME') || n === 'VOL' || n === 'TON') ?? null;
  const gpsKey = colNames.find(n => n.includes('POSITION') || n.includes('GPS') || n.includes('LOC')) ?? null;

  const operations = [];

  for (let i = hIdx + 1; i < rows.length; i++) {
    // 헤더 반복 → 스킵
    if (isOpTimeLogHeader(rows[i])) continue;

    const row   = rowToMap(rows[i], matchCol);
    const cells = rows[i].cells;

    // 전체 행 텍스트로 운전 종류 판별 (가장 확실한 방법)
    const allText = cells.map(c => c.str).join(' ').toUpperCase();
    const isBallast   = /\bBALLAST\b/.test(allText) && !/\bDE.?BALLAST\b/.test(allText);
    const isDeballast = /\bDE.?BALLAST\b/.test(allText);
    const isStripping = /\bSTRIPP/i.test(allText);
    if (!isBallast && !isDeballast && !isStripping) continue;

    const mode = isBallast ? 'BALLAST' : isDeballast ? 'DEBALLAST' : 'STRIPPING';

    // 시작 시간 (START 컬럼 또는 전체 텍스트에서 날짜 패턴 검색)
    const stRaw = stKey ? (row[stKey] || '') : '';
    const { date, time: startTime } = extractDateTime(stRaw);

    // 종료 시간
    const etRaw = etKey ? (row[etKey] || '') : '';
    const { time: endTime } = extractDateTime(etRaw);

    // 운전 시간
    const rtRaw = rtKey ? (row[rtKey] || '') : '';
    const runTime = parseRunTime(rtRaw);

    // 볼륨
    const volRaw = volKey ? (row[volKey] || '') : '';
    const volume = parseFloat(volRaw);
    const volNum = isNaN(volume) ? null : volume;

    // 유효성 검사: 시간이나 볼륨이 전혀 없으면 잘못된 행
    if (!startTime && !runTime && !volNum) continue;

    operations.push({
      operation_mode:   mode,
      date,
      start_time:       startTime,
      end_time:         endTime,
      run_time:         runTime,
      ballast_volume:   isBallast   ? volNum : null,
      deballast_volume: isDeballast ? volNum : null,
      location_gps:     gpsKey ? (row[gpsKey] || null) : null,
    });
  }

  console.log(`[Stage0/OpTime] ${operations.length} operations`);
  return operations;
}

// ── 메인 진입점 ────────────────────────────────────────────
export async function parseEcsLogStructured(pdfDoc, sections, totalPages) {
  if (!sections?.op_time_start) {
    console.warn('[Stage0] Section info missing, skip');
    return null;
  }

  const total  = totalPages ?? pdfDoc.numPages;
  const opEnd  = (sections.data_log_start ?? sections.op_time_start + 15) - 1;

  const result = { operations: null, tro_data: null, vrcs_data: null };

  // Op Time Log 파싱
  try {
    console.log(`[Stage0] Op Time Log: p.${sections.op_time_start}~${opEnd}`);
    const rows = await extractPagesRows(pdfDoc, sections.op_time_start, opEnd);
    result.operations = parseOpTimeLog(rows);
  } catch (e) {
    console.warn('[Stage0] Op Time parse failed:', e.message);
  }

  // Data Log 파싱 — 전체 페이지 (AI 컨텍스트 제한 없음!)
  if (sections.data_log_start) {
    try {
      console.log(`[Stage0] Data Log: p.${sections.data_log_start}~${total} (ALL pages)`);
      const rows = await extractPagesRows(pdfDoc, sections.data_log_start, total);
      result.tro_data = parseDataLog(rows);
    } catch (e) {
      console.warn('[Stage0] Data Log parse failed:', e.message);
    }
  }

  // Event Log VRCS 채터링 감지 (마지막 N페이지 샘플)
  if (sections.event_log_start && sections.op_time_start) {
    try {
      const evEnd   = sections.op_time_start - 1;
      const evStart = Math.max(sections.event_log_start, evEnd - VRCS_SAMPLE_PAGES + 1);
      console.log(`[Stage0] Event Log VRCS 감지: p.${evStart}~${evEnd}`);
      const evRows = await extractPagesRows(pdfDoc, evStart, evEnd);
      const vrcs   = parseEventLogForVrcs(evRows);
      if (vrcs.length > 0) {
        result.vrcs_data = vrcs;
        console.log('[Stage0] VRCS 감지:', vrcs.map(v => `${v.valve}×${v.count}`).join(', '));
      }
    } catch (e) {
      console.warn('[Stage0] VRCS 감지 실패:', e.message);
    }
  }

  return result;
}
