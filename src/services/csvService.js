// ============================================================
//  csvService.js
//  GAS(Google Apps Script)가 변환한 3종 CSV 파일 파싱
//  헤더명이 파일마다 다를 수 있으므로 키워드 기반 유연한 컬럼 탐지
// ============================================================

/**
 * CSV 텍스트를 2D 배열로 파싱 (기본 따옴표 처리 포함)
 */
function parseCsvRows(csvText) {
  if (!csvText || !csvText.trim()) return [];
  return csvText.split(/\r?\n/).map(line => {
    const cells = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  }).filter(row => row.some(c => c !== ''));
}

/**
 * 헤더 행에서 패턴(RegExp | string[] | Function)으로 컬럼 인덱스를 탐색
 */
function detectColumns(headerRow, colPatterns) {
  const upper = headerRow.map(h => (h || '').toUpperCase().trim());
  const result = {};
  for (const [field, pattern] of Object.entries(colPatterns)) {
    let idx;
    if (typeof pattern === 'function') {
      idx = upper.findIndex(pattern);
    } else if (pattern instanceof RegExp) {
      idx = upper.findIndex(h => pattern.test(h));
    } else {
      idx = upper.findIndex(h => pattern.some(kw => h.includes(kw.toUpperCase())));
    }
    result[field] = idx >= 0 ? idx : null;
  }
  return result;
}

/**
 * 운전 시간 문자열 → 시간(소수)
 * "0:16" → 0.27, "1:30:00" → 1.5, "2.50" → 2.50
 */
function parseRunTime(str) {
  if (!str) return null;
  const s = String(str).trim();
  const hms = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    const h = parseInt(hms[1]);
    const m = parseInt(hms[2]);
    const sec = hms[3] ? parseInt(hms[3]) : 0;
    return +((h + m / 60 + sec / 3600).toFixed(2));
  }
  const num = parseFloat(s);
  return isNaN(num) ? null : +num.toFixed(2);
}

/**
 * 운전 모드 정규화
 * N-B / 1-B / 2-B / 밸러스트 → "BALLAST"
 * N-D / 1-D / 2-D / 디발라스트 → "DEBALLAST"
 * N-S / 1-S / 2-S / 스트리핑 → "STRIPPING"
 */
function normalizeMode(raw) {
  if (!raw) return null;
  const u = raw.trim().toUpperCase();
  if (/^BALLAST(ING)?$/.test(u) || /^N-B$/.test(u) || /^\d+-?B$/.test(u) ||
      u.includes('밸러스트')) return 'BALLAST';
  if (/^DEBALLAST(ING)?$/.test(u) || /^N-D$/.test(u) || /^\d+-?D$/.test(u) ||
      u.includes('디발라스') || u.includes('디밸러스')) return 'DEBALLAST';
  if (/^STRIPP/.test(u) || /^N-S$/.test(u) || /^\d+-?S$/.test(u) ||
      u.includes('스트리핑')) return 'STRIPPING';
  if (/^STOP$/.test(u) || u.includes('정지')) return 'STOP';
  return u || null;
}

// ─────────────────────────────────────────────────────────────────
// OPERATIONTIMELOG.CSV → operations[]
// ─────────────────────────────────────────────────────────────────

/**
 * OPERATIONTIMELOG.CSV → operations[]
 * 필드명은 STAGE1_TEXT_SCHEMA와 일치시킴:
 *   run_time, location_gps, ballast_volume, deballast_volume
 */
export function parseOpTimeCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const headerRow = rows[0];
  const cols = detectColumns(headerRow, {
    mode:     ['OPERATION', 'OP MODE', 'OP_MODE', 'MODE', '운전모드'],
    date:     ['DATE', '날짜', 'DAY'],
    start:    ['START', '시작'],
    end:      ['END', '종료'],
    runtime:  ['RUNNING', 'RUNTIME', 'RUN_TIME', 'RUN TIME', '운전시간', 'DURATION'],
    position: ['POSITION', 'GPS', 'LOC', '위치'],
    volume:   ['VOLUME', 'VOL', 'TON', '처리량'],
  });

  const operations = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 2) continue;
    const get = (f) => (cols[f] != null ? (row[cols[f]] || '').trim() : null);

    const mode = normalizeMode(get('mode'));
    if (!mode || mode === 'STOP') continue;

    const volNum = parseFloat(get('volume') || '');
    const vol    = isNaN(volNum) ? null : volNum;

    const op = {
      operation_mode:   mode,
      date:             get('date') || null,
      start_time:       get('start') || null,
      end_time:         get('end') || null,
      run_time:         parseRunTime(get('runtime')),   // 시간(소수)
      location_gps:     get('position') || null,
    };
    // 모드에 따라 볼륨 필드 구분 (STAGE1_TEXT_SCHEMA 일치)
    if (mode === 'BALLAST')   op.ballast_volume   = vol;
    else if (mode === 'DEBALLAST') op.deballast_volume = vol;
    else                      op.ballast_volume   = vol; // STRIPPING 등 fallback

    operations.push(op);
  }
  return operations;
}

// ─────────────────────────────────────────────────────────────────
// DATALOG.CSV → tro_data
// 시계열 형식(TRO_B1, TRO_B2, TRO_D1, TRO_S1, OPERATION 컬럼)과
// 요약 1행 형식 모두 지원
// ─────────────────────────────────────────────────────────────────

/**
 * DATALOG.CSV → tro_data
 *
 * GAS가 시계열 원본을 그대로 CSV로 변환하는 경우:
 *   OPERATION 컬럼 존재 → 행별 처리 (logParser.parseDataLog과 동일 방식)
 *   TRO_B1/TRO_B2 → ballast TRO
 *   TRO_D1/TRO_S1 → deballast TRO
 *
 * GAS가 요약 통계 1행을 출력하는 경우:
 *   헤더에 AVG/MIN/MAX 포함 → 단순 읽기
 */
export function parseDataLogCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return null;

  const headerRow = rows[0];
  const upper     = headerRow.map(h => (h || '').toUpperCase().trim());

  // ── 시계열 모드 판별 ──────────────────────────────────────────
  // OPERATION 컬럼이 있으면 → 시계열 원본
  const opColIdx = upper.findIndex(h => h === 'OPERATION' || h === 'OP');
  if (opColIdx >= 0) {
    return _parseDataLogTimeSeries(rows, upper, opColIdx);
  }

  // ── 요약 1행 모드 ─────────────────────────────────────────────
  return _parseDataLogSummary(rows, upper);
}

/** 시계열 원본 방식: 행별로 BALLAST/DEBALLAST 판별 후 TRO 수집 */
function _parseDataLogTimeSeries(rows, upper, opColIdx) {
  // TRO_B* 컬럼 인덱스 (ballast TRO)
  const troBIdx = upper.reduce((acc, h, i) => {
    if (/^TRO[_-]?B\d*$/.test(h) || h === 'TRO1' || h === 'T1') acc.push(i);
    return acc;
  }, []);
  // TRO_D* / TRO_S* 컬럼 인덱스 (deballast/stripping TRO)
  const troDIdx = upper.reduce((acc, h, i) => {
    if (/^TRO[_-]?D\d*$/.test(h) || /^TRO[_-]?S\d*$/.test(h) || h === 'TRO2' || h === 'T2') acc.push(i);
    return acc;
  }, []);
  // ECU 전류 컬럼
  const ecuIdx = upper.findIndex(h => /REC\d*_?CURRENT|ECU_?I$|^ECU$/.test(h) && !h.includes('VOLTAGE'));
  // FMU 유량 컬럼
  const fmuIdx = upper.findIndex(h => /^FMU\d*$/.test(h) && !h.includes('_ST'));
  // ANU 컬럼
  const anuIdx = upper.findIndex(h => /^ANU[_-]?[DS]\d+/.test(h));

  const ballastTROs   = [];
  const deballastTROs = [];
  const ecuValues     = [];
  const fmuValues     = [];
  let anuOp = 0, anuAll = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[opColIdx]) continue;

    const op         = row[opColIdx].trim().toUpperCase();
    const isBallast  = op === 'BALLAST'   || op === 'N-B' || /^\d+-?B$/i.test(op);
    const isDeballast= op === 'DEBALLAST' || op === 'N-D' || /^\d+-?D$/i.test(op);
    const isStripping= op === 'STRIPPING' || op === 'N-S' || /^\d+-?S$/i.test(op);
    if (!isBallast && !isDeballast && !isStripping) continue;

    if (isBallast) {
      for (const ci of troBIdx) {
        const v = parseFloat(row[ci]);
        if (!isNaN(v) && v >= 0.1 && v <= 15) ballastTROs.push(v);
      }
    }
    if (isDeballast || isStripping) {
      for (const ci of troDIdx) {
        const v = parseFloat(row[ci]);
        if (!isNaN(v) && v >= 0 && v <= 15) deballastTROs.push(v);
      }
    }
    if (ecuIdx >= 0) {
      const v = parseFloat(row[ecuIdx]);
      if (!isNaN(v) && v > 50) ecuValues.push(v);
    }
    if (fmuIdx >= 0) {
      const v = parseFloat(row[fmuIdx]);
      if (!isNaN(v) && v > 0) fmuValues.push(v);
    }
    if (anuIdx >= 0) {
      const v = parseFloat(row[anuIdx]);
      if (!isNaN(v)) { anuAll++; if (v > 0) anuOp++; }
    }
  }

  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
  const max = arr => arr.length ? +(Math.max(...arr)).toFixed(2) : null;
  const min = arr => arr.length ? +(Math.min(...arr)).toFixed(2) : null;

  // Warm-up 첫 5행 제외 후 최솟값
  const stableArr = ballastTROs.slice(5);

  console.log(`[CSV/DataLog] ballastTRO:${ballastTROs.length}건 / deballastTRO:${deballastTROs.length}건`);

  return {
    ballasting_avg:   avg(ballastTROs),
    ballasting_min:   min(stableArr.length > 0 ? stableArr : ballastTROs),
    deballasting_max: max(deballastTROs),
    ecu_current_avg:  avg(ecuValues),
    fmu_flow_avg:     avg(fmuValues),
    anu_status: anuAll > 0 ? (anuOp / anuAll > 0.3 ? 'Operating' : 'Standby') : null,
  };
}

/** 요약 1행 방식: 헤더에 AVG/MIN/MAX 키워드 포함된 컬럼에서 직접 읽기 */
function _parseDataLogSummary(rows, upper) {
  const cols = {
    ballasting_avg:   upper.findIndex(h => !h.includes('DEBALLAST') && h.includes('BALLAST') && h.includes('AVG')),
    ballasting_min:   upper.findIndex(h => !h.includes('DEBALLAST') && h.includes('BALLAST') && (h.includes('MIN') || h.includes('최소'))),
    deballasting_max: upper.findIndex(h => h.includes('DEBALLAST') && (h.includes('MAX') || h.includes('최대'))),
    ecu_current_avg:  upper.findIndex(h => /ECU|CURRENT|전류|REC1_CURRENT/.test(h)),
    fmu_flow_avg:     upper.findIndex(h => /FMU|FLOW|유량/.test(h)),
    anu_status:       upper.findIndex(h => h.includes('ANU')),
  };

  const row = rows[1];
  const get = (f) => (cols[f] >= 0 ? (row[cols[f]] || '').trim() : null);
  const pf  = v => { const n = parseFloat(v); return isNaN(n) ? null : +n.toFixed(2); };

  return {
    ballasting_avg:   pf(get('ballasting_avg')),
    ballasting_min:   pf(get('ballasting_min')),
    deballasting_max: pf(get('deballasting_max')),
    ecu_current_avg:  pf(get('ecu_current_avg')),
    fmu_flow_avg:     pf(get('fmu_flow_avg')),
    anu_status:       get('anu_status') || null,
  };
}

// ─────────────────────────────────────────────────────────────────
// EVENTLOG.CSV → error_alarms[] (Trip / Alarm / Warning만 수집)
// ─────────────────────────────────────────────────────────────────

/**
 * EVENTLOG.CSV → error_alarms[]
 * Normal 레벨은 제외 — Trip / Alarm / Warning만 수집
 */
export function parseEventLogCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const headerRow = rows[0];
  const cols = detectColumns(headerRow, {
    date:        ['DATE', '날짜'],
    time:        ['TIME', '시간'],
    level:       ['LEVEL', 'TYPE', '종류'],
    code:        ['CODE', '코드'],
    description: ['DESC', 'DETAIL', '내용', 'DESCRIPTION'],
    device:      ['DEVICE', '장치', 'MODULE'],
  });

  const alarms = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 2) continue;
    const get = (f) => (cols[f] != null ? (row[cols[f]] || '').trim() : null);

    // 레벨 정규화
    const rawLevel = (get('level') || '').toUpperCase();
    let level;
    if (/TRIP|FAULT/.test(rawLevel))    level = 'Trip';
    else if (/ALARM|알람/.test(rawLevel)) level = 'Alarm';
    else if (/WARN/.test(rawLevel))      level = 'Warning';
    else continue; // Normal / 기타 → 무시

    // 코드 정규화: "200" / "[CODE200]" / "CODE 200" / "CODE200" → "CODE200"
    const rawCode = get('code') || '';
    const m = rawCode.match(/CODE\s*(\d+)/i) || rawCode.match(/^\[?(\d+)\]?$/);
    const code = m ? `CODE${m[1]}` : (rawCode || null);

    const desc = get('description');
    if (!code && !desc) continue;

    alarms.push({
      date:        get('date') || null,
      time:        get('time') || null,
      level,
      code,
      description: desc || null,
      device:      get('device') || null,
      count:       1,
    });
  }
  return alarms;
}

// ─────────────────────────────────────────────────────────────────
// 3종 결합 → validateAndNormalizeResult() 입력용 JSON
// ─────────────────────────────────────────────────────────────────

/**
 * 3종 CSV 텍스트 → 분析 결과 JSON
 * @param {string|null} opText    - OPERATIONTIMELOG CSV
 * @param {string|null} dataText  - DATALOG CSV
 * @param {string|null} evText    - EVENTLOG CSV (없으면 null → _event_log_missing: true)
 * @param {object}      vessel    - { name, year, month, imo, vesselFolderName }
 */
export function combineCsvResults(opText, dataText, evText, vessel = {}) {
  const operations   = opText   ? parseOpTimeCsv(opText)   : [];
  const tro_data     = dataText ? parseDataLogCsv(dataText) : null;
  const error_alarms = evText   ? parseEventLogCsv(evText)  : [];

  const period = (vessel.year && vessel.month)
    ? `${vessel.year}-${String(vessel.month).padStart(2, '0')}`
    : null;

  return {
    vessel_name:        vessel.name || vessel.vesselFolderName || null,
    imo_number:         vessel.imo  || null,
    period,
    operations,
    tro_data,
    error_alarms,
    _event_log_missing: evText == null,
  };
}
