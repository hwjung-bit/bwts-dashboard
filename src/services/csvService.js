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
  // ── TRO 컬럼 동적 탐색 ─────────────────────────────────────
  // 헤더에서 'TRO' 포함된 컬럼을 모두 찾아 접미사로 분류
  //   TRO_B* → 주입 전용 센서 (type: 'ballast')
  //   TRO_D* → 배출 전용 센서 (type: 'deballast')
  //   TRO_S* → 스트리핑 전용 (type: 'deballast' 로 합산)
  //   TRO_1, TRO_2, TRO 등 숫자/무접미사 → OPERATION 컬럼 값으로 판단 (type: 'auto')
  const troCols = [];
  for (let i = 0; i < upper.length; i++) {
    const h = upper[i];
    if (!h.includes('TRO') && h !== 'T1' && h !== 'T2') continue;
    if (/TRO[_-]?B\d*/i.test(h))      troCols.push({ idx: i, type: 'ballast'   });
    else if (/TRO[_-]?D\d*/i.test(h)) troCols.push({ idx: i, type: 'deballast' });
    else if (/TRO[_-]?S\d*/i.test(h)) troCols.push({ idx: i, type: 'deballast' });
    else                               troCols.push({ idx: i, type: 'auto'      });
  }
  console.log('[CSV/DataLog] TRO 컬럼 탐지:', troCols.map(c => `${upper[c.idx]}(${c.type})`).join(', ') || '없음');

  // ECU 전류 / 전압 / FMU 유량 / ANU / 가스 / Bypass / CSU / FTS 컬럼
  const ecuIdx     = upper.findIndex(h => /REC\d*_?(STATE_)?CURRENT/.test(h) && !h.includes('VOLTAGE'));
  const voltIdx    = upper.findIndex(h => /REC\d*_?(STATE_)?VOLTAGE/.test(h));
  const fmuIdx     = upper.findIndex(h => /^FMU\d*$/.test(h) && !h.includes('_ST') && !h.includes('_DT'));
  const anuIdx     = upper.findIndex(h => /^ANU[_-]?[DS]\d+/.test(h));
  const gasIdx     = upper.findIndex(h => /^GAS\d*$|^GDS\d*$/.test(h));
  const bypassIdx  = upper.findIndex(h => /^BV\d*$|^TE02V$/.test(h));
  const csuIdx     = upper.findIndex(h => /^CSU\d*$/.test(h));
  const ftsIdx     = upper.findIndex(h => /^FTS\d*$/.test(h));

  const ballastTROs   = [];
  const deballastTROs = [];
  const ecuValues     = [];
  const fmuValues     = [];
  const csuValues     = [];
  const ftsValues     = [];
  let anuOp = 0, anuAll = 0;
  let gasDetectedCount = 0;
  let bypassCount = 0;
  let zeroVoltageCount = 0;
  let zeroCurrentCount = 0;
  let ultraLowSalinityCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[opColIdx]) continue;

    const op          = row[opColIdx].trim().toUpperCase();
    const isBallast   = op === 'BALLAST'   || op === 'N-B' || /^\d+-?B$/i.test(op);
    const isDeballast = op === 'DEBALLAST' || op === 'N-D' || /^\d+-?D$/i.test(op);
    const isStripping = op === 'STRIPPING' || op === 'N-S' || /^\d+-?S$/i.test(op);
    if (!isBallast && !isDeballast && !isStripping) continue;

    // TRO 수집: type='auto'는 현재 OPERATION으로 판단
    for (const col of troCols) {
      const v = parseFloat(row[col.idx]);
      if (isNaN(v) || v < 0 || v > 15) continue;

      const effectiveType = col.type === 'auto'
        ? (isBallast ? 'ballast' : 'deballast')
        : col.type;

      if (effectiveType === 'ballast'   && isBallast              && v >= 0.1) ballastTROs.push(v);
      if (effectiveType === 'deballast' && (isDeballast || isStripping))       deballastTROs.push(v);
    }

    if (ecuIdx >= 0) {
      const v = parseFloat(row[ecuIdx]);
      if (!isNaN(v) && v > 50) ecuValues.push(v);
      // 전류=0 이면서 운전 중 → 이상
      if (!isNaN(v) && v === 0) zeroCurrentCount++;
    }
    if (voltIdx >= 0) {
      const v = parseFloat(row[voltIdx]);
      // 전압=0 이면서 운전 중 → 이상
      if (!isNaN(v) && v === 0) zeroVoltageCount++;
    }
    if (fmuIdx >= 0) {
      const v = parseFloat(row[fmuIdx]);
      if (!isNaN(v) && v > 0) fmuValues.push(v);
    }
    if (anuIdx >= 0) {
      const v = parseFloat(row[anuIdx]);
      if (!isNaN(v)) { anuAll++; if (v > 0) anuOp++; }
    }
    if (gasIdx >= 0) {
      const v = parseFloat(row[gasIdx]);
      if (!isNaN(v) && v > 0) gasDetectedCount++;
    }
    if (bypassIdx >= 0) {
      const v = parseFloat(row[bypassIdx]);
      if (!isNaN(v) && v === 1) bypassCount++;
    }
    if (csuIdx >= 0) {
      const v = parseFloat(row[csuIdx]);
      if (!isNaN(v) && v > 0) {
        csuValues.push(v);
        if (v < 5) ultraLowSalinityCount++;
      }
    }
    if (ftsIdx >= 0) {
      const v = parseFloat(row[ftsIdx]);
      if (!isNaN(v) && v > 0) ftsValues.push(v);
    }
  }

  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
  const max = arr => arr.length ? +(Math.max(...arr)).toFixed(2) : null;
  const min = arr => arr.length ? +(Math.min(...arr)).toFixed(2) : null;

  // Warm-up 첫 5행 제외 후 최솟값
  const stableArr = ballastTROs.slice(5);

  console.log(`[CSV/DataLog] ballastTRO:${ballastTROs.length}건 / deballastTRO:${deballastTROs.length}건 / gas:${gasDetectedCount} / bypass:${bypassCount}`);

  return {
    ballasting_avg:        avg(ballastTROs),
    ballasting_min:        min(stableArr.length > 0 ? stableArr : ballastTROs),
    deballasting_max:      max(deballastTROs),
    ecu_current_avg:       avg(ecuValues),
    fmu_flow_avg:          avg(fmuValues),
    anu_status:            anuAll > 0 ? (anuOp / anuAll > 0.3 ? 'Operating' : 'Standby') : null,
    // 이상값 탐지 (분析 프롬프트에서 활용)
    csu_avg:               avg(csuValues),
    fts_avg:               avg(ftsValues),
    gasDetectedCount,
    bypassCount,
    zeroVoltageCount,
    zeroCurrentCount,
    ultraLowSalinityCount,
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
// EVENTLOG.CSV → { alarms[], wrongTerminationCount, gpsTimeSetCount }
//
// 실제 CSV 구조:
//   DATE, DEVICE, LEVEL, DESCRIPTION, ACK.TIME(또는 Ack.Time), RESET.TIME(또는 Reset.Time), CLEAR
//   알람코드는 별도 컬럼 없이 DESCRIPTION 안에 "[CODE201]..." 형식으로 포함
//   CLEAR: 'X' = 완료, 'O' = 미완료
// ─────────────────────────────────────────────────────────────────

/**
 * EVENTLOG.CSV → { alarms, wrongTerminationCount, gpsTimeSetCount }
 * - Trip / Alarm / Warning만 alarms에 수집
 * - Normal 중 비정상종료·GPS시간보정 횟수 별도 카운트
 * - 미확인(acked=false), 미리셋(reset=false), 미완료(cleared=false) 플래그 포함
 */
export function parseEventLogCsv(csvText) {
  const rows = parseCsvRows(csvText);

  // 페이지 과도 CSV (KCN 등 대용량)
  if (rows.length <= 2) {
    const firstCell = (rows[0]?.[0] || '').trim();
    if (firstCell.includes('페이지 과도')) {
      return { alarms: [], wrongTerminationCount: 0, gpsTimeSetCount: 0, _overflow: true };
    }
  }
  if (rows.length < 2) return { alarms: [], wrongTerminationCount: 0, gpsTimeSetCount: 0 };

  const headerRow = rows[0];
  const cols = detectColumns(headerRow, {
    date:        ['DATE', '날짜'],
    level:       ['LEVEL', 'TYPE', '종류'],
    description: ['DESCRIPTION', 'DESC', 'DETAIL', '내용'],
    device:      ['DEVICE', '장치', 'MODULE'],
    ack:         h => /ACK/i.test(h),          // ACK.TIME / Ack.Time
    reset:       h => /RESET/i.test(h),        // RESET.TIME / Reset.Time
    clear:       h => /^CLEAR$/i.test(h),      // CLEAR
  });

  const alarms = [];
  let wrongTerminationCount = 0;
  let gpsTimeSetCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 2) continue;
    const get = (f) => (cols[f] != null ? (row[cols[f]] || '').trim() : null);

    const rawLevel = (get('level') || '').toUpperCase();
    const desc     = (get('description') || '').trim();

    // Normal 레벨: 특이 패턴만 카운트
    if (/^NORMAL$/.test(rawLevel)) {
      if (desc.includes('terminated in the wrong way')) wrongTerminationCount++;
      if (desc.includes('GPS Time Set'))                gpsTimeSetCount++;
      continue;
    }

    let level;
    if (/TRIP|FAULT/.test(rawLevel))      level = 'Trip';
    else if (/ALARM|알람/.test(rawLevel))  level = 'Alarm';
    else if (/WARN/.test(rawLevel))        level = 'Warning';
    else continue;

    // DESCRIPTION에서 [CODE###] 패턴 추출 (실제 데이터: "[CODE201]TRO Concentration High.[0.11]")
    const codeMatch = desc.match(/\[CODE(\d+)\]/i);
    const code = codeMatch ? `CODE${codeMatch[1]}` : null;

    // 코드 제거한 순수 설명
    const cleanDesc = desc.replace(/\[CODE\d+\]/gi, '').replace(/^\s*[-–]\s*/, '').trim();

    const ackVal   = get('ack')   || '-';
    const resetVal = get('reset') || '-';
    const clearVal = get('clear') || '';

    if (!code && !cleanDesc) continue;

    alarms.push({
      date:        get('date') || null,
      level,
      code,
      description: cleanDesc || desc,
      device:      get('device') || null,
      acked:       ackVal !== '-' && ackVal !== '',    // false = 미확인
      reset:       resetVal !== '-' && resetVal !== '', // false = 미리셋
      cleared:     clearVal === 'X',                   // false = 미완료(O)
      count:       1,
    });
  }

  return { alarms, wrongTerminationCount, gpsTimeSetCount };
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
  const operations = opText   ? parseOpTimeCsv(opText)   : [];
  const tro_data   = dataText ? parseDataLogCsv(dataText) : null;

  // parseEventLogCsv 반환값: { alarms, wrongTerminationCount, gpsTimeSetCount, _overflow? }
  const evResult   = evText   ? parseEventLogCsv(evText)  : null;
  const error_alarms = evResult ? evResult.alarms : [];

  // 이벤트 로그 통계 (ANALYSIS_PROMPT에서 활용)
  const event_log_stats = evResult ? {
    unacknowledged:       error_alarms.filter(a => !a.acked).length,
    unreset:              error_alarms.filter(a => !a.reset).length,
    incomplete:           error_alarms.filter(a => !a.cleared).length,
    wrongTermination:     evResult.wrongTerminationCount || 0,
    gpsTimeSet:           evResult.gpsTimeSetCount || 0,
    overflow:             evResult._overflow || false,
  } : null;

  // 데이터 로그 이상값 플래그 (tro_data에서 분리)
  const data_log_flags = tro_data ? {
    gasDetectedCount:      tro_data.gasDetectedCount      || 0,
    bypassCount:           tro_data.bypassCount           || 0,
    zeroVoltageCount:      tro_data.zeroVoltageCount      || 0,
    zeroCurrentCount:      tro_data.zeroCurrentCount      || 0,
    ultraLowSalinityCount: tro_data.ultraLowSalinityCount || 0,
    csu_avg:               tro_data.csu_avg               || null,
    fts_avg:               tro_data.fts_avg               || null,
  } : null;

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
    event_log_stats,
    data_log_flags,
    _event_log_missing: evText == null,
  };
}
