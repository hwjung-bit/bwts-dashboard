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
 * 헤더 행에서 패턴(RegExp 또는 키워드 배열 또는 함수)으로 컬럼 인덱스를 탐색
 * @param {string[]} headerRow
 * @param {{ [fieldName]: RegExp | string[] | Function }} colPatterns
 * @returns {{ [fieldName]: number|null }}
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
      // string[] — any keyword match
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
 * OPERATIONTIMELOG.CSV 텍스트를 파싱해 운전 기록 배열로 변환
 * @param {string} csvText
 * @returns {Array<object>} operations
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

    const volStr = get('volume');
    operations.push({
      operation_mode: mode,
      date:           get('date') || null,
      start_time:     get('start') || null,
      end_time:       get('end') || null,
      running_time_h: parseRunTime(get('runtime')),
      position:       get('position') || null,
      volume_ton:     volStr ? (parseFloat(volStr) || null) : null,
    });
  }
  return operations;
}

// ─────────────────────────────────────────────────────────────────
// DATALOG.CSV → tro_data
// ─────────────────────────────────────────────────────────────────

/**
 * DATALOG.CSV 텍스트를 파싱해 TRO 요약 데이터로 변환
 * 단일 요약 행(헤더 + 값 1행) 구조 가정. 행이 여러 개면 첫 번째 데이터 행 사용.
 * @param {string} csvText
 * @returns {object|null} tro_data
 */
export function parseDataLogCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return null;

  const headerRow = rows[0];
  // 헤더 함수로 구분 (DEBALLAST 포함 여부를 함수로 정밀 제어)
  const cols = detectColumns(headerRow, {
    ballasting_avg:   h => !h.includes('DEBALLAST') && h.includes('BALLAST') && h.includes('AVG'),
    ballasting_min:   h => !h.includes('DEBALLAST') && h.includes('BALLAST') && (h.includes('MIN') || h.includes('최소')),
    deballasting_max: h => h.includes('DEBALLAST') && (h.includes('MAX') || h.includes('최대')),
    ecu_current_avg:  h => /ECU|CURRENT|전류|REC1_CURRENT/.test(h),
    fmu_flow_avg:     h => /FMU|FLOW|유량/.test(h),
    anu_status:       h => h.includes('ANU'),
  });

  const row = rows[1];
  const get = (f) => (cols[f] != null ? (row[cols[f]] || '').trim() : null);
  const pf  = (v) => { const n = parseFloat(v); return isNaN(n) ? null : +n.toFixed(2); };

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
// EVENTLOG.CSV → error_alarms[]
// ─────────────────────────────────────────────────────────────────

/**
 * EVENTLOG.CSV (또는 수동 입력 텍스트) → error_alarms[]
 * CODE 정규화: "200", "[CODE200]", "CODE200" → "CODE200"
 * LEVEL 정규화: TRIP/FAULT → "Trip", ALARM → "Alarm", WARN → "Warning"
 * @param {string} csvText
 * @returns {Array<object>} error_alarms
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
    if (/TRIP|FAULT/.test(rawLevel)) level = 'Trip';
    else if (/ALARM|알람/.test(rawLevel)) level = 'Alarm';
    else if (/WARN/.test(rawLevel)) level = 'Warning';
    else level = rawLevel || 'Alarm';

    // 코드 정규화: "200" / "[CODE200]" / "CODE 200" / "CODE200" → "CODE200"
    const rawCode = get('code') || '';
    let code;
    const m = rawCode.match(/CODE\s*(\d+)/i) || rawCode.match(/^\[?(\d+)\]?$/);
    code = m ? `CODE${m[1]}` : (rawCode || null);

    // 설명이 없는 행은 건너뜀
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
 * 3종 CSV 텍스트를 파싱해 결합된 분析 객체 반환
 * @param {string|null} opText    - OPERATIONTIMELOG CSV 텍스트
 * @param {string|null} dataText  - DATALOG CSV 텍스트
 * @param {string|null} evText    - EVENTLOG CSV 텍스트 (없으면 null → _event_log_missing: true)
 * @param {object}      vessel    - { name, year, month, imo, vesselFolderName }
 * @returns {object} validateAndNormalizeResult() 입력용 JSON
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
