// ============================================================
//  csvService.js
//  GAS(Google Apps Script)가 변환한 3종 CSV 파일 파싱
//  헤더명이 파일마다 다를 수 있으므로 키워드 기반 유연한 컬럼 탐지
// ============================================================

/**
 * CSV 텍스트를 2D 배열로 파싱
 * 멀티라인 따옴표 처리 지원 (예: "RUNNING TIME\n(HH:MM)")
 */
function parseCsvRows(csvText) {
  if (!csvText || !csvText.trim()) return [];

  const rows = [];
  let cur = '';
  let inQuote = false;
  const cells = [];

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];

    if (ch === '"') {
      if (inQuote && csvText[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      cells.push(cur.trim());
      cur = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      // 줄바꿈 (따옴표 밖) → 행 완료
      if (ch === '\r' && csvText[i + 1] === '\n') i++; // \r\n
      cells.push(cur.trim());
      cur = '';
      if (cells.some(c => c !== '')) rows.push([...cells]);
      cells.length = 0;
    } else if ((ch === '\n' || ch === '\r') && inQuote) {
      // 따옴표 안의 줄바꿈 → 공백으로 치환 (헤더 정규화)
      cur += ' ';
      if (ch === '\r' && csvText[i + 1] === '\n') i++;
    } else {
      cur += ch;
    }
  }
  // 마지막 행
  cells.push(cur.trim());
  if (cells.some(c => c !== '')) rows.push([...cells]);

  return rows;
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
// GPS 파싱 & 해역 분류
// ─────────────────────────────────────────────────────────────────

/**
 * GPS 좌표 문자열 → { lat, lon } (소수점 형식)
 * 지원 형식:
 *   1) [도, 소수분, 방향] → "[8, 27.53, N][105, 25.70, E]"
 *   2) [도, 분, 초, 방향]  → "[24, 48, 18, N][66, 59, 23, E]"
 *   3) TECHCROSS           → "[22, 20.0, N],[114, 7.49, E]"
 */
function parseGpsCoordinate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    // 대괄호 블록 추출: [값들, 방향]
    const blocks = [...raw.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim());
    if (blocks.length < 2) return null;

    function parseBlock(block) {
      const parts = block.split(',').map(s => s.trim());
      const dir = parts[parts.length - 1].toUpperCase();
      if (!/^[NSEW]$/.test(dir)) return null;
      const nums = parts.slice(0, -1).map(Number);
      if (nums.some(isNaN)) return null;

      let decimal;
      if (nums.length === 2) {
        // [도, 소수분] 형식
        decimal = nums[0] + nums[1] / 60;
      } else if (nums.length === 3) {
        // [도, 분, 초] 형식
        decimal = nums[0] + nums[1] / 60 + nums[2] / 3600;
      } else {
        return null;
      }
      if (dir === 'S' || dir === 'W') decimal = -decimal;
      return +decimal.toFixed(4);
    }

    const lat = parseBlock(blocks[0]);
    const lon = parseBlock(blocks[1]);
    if (lat == null || lon == null) return null;
    return { lat, lon };
  } catch { return null; }
}

/**
 * 위도/경도 기반 해역 분류
 */
function classifySeaArea(lat, lon) {
  const absLat = Math.abs(lat);
  const absLon = Math.abs(lon);
  if (lat >= 25 && lat <= 45 && lon >= 115 && lon <= 145) return '동아시아';
  if (lat >= -10 && lat <= 25 && lon >= 95 && lon <= 140) return '동남아시아';
  if (lat >= -40 && lat <= 25 && lon >= 30 && lon <= 100) return '인도양/중동';
  if (lon < -100 || lon > 140 || absLon > 140) return '태평양';
  return '기타';
}

/**
 * GPS 문자열 → { lat, lon, area }
 */
function parseGpsFromRow(rawStr) {
  const coord = parseGpsCoordinate(rawStr);
  if (!coord) return null;
  return { ...coord, area: classifySeaArea(coord.lat, coord.lon) };
}

// ─────────────────────────────────────────────────────────────────
// OpTime 이상 탐지 & 모드별 집계
// ─────────────────────────────────────────────────────────────────

/**
 * Operation Time 이상 데이터 탐지
 */
function detectOpTimeAnomalies(operations) {
  const anomalies = [];
  const startTimes = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const vol = op.ballast_volume ?? op.deballast_volume ?? null;
    const rt  = op.run_time;

    // Volume=0 + Runtime>0
    if ((vol === 0 || vol === null) && rt > 0) {
      anomalies.push({ index: i, mode: op.operation_mode, flag: '[볼륨 미기록 의심]', detail: `runtime=${rt}h, volume=${vol}` });
    }
    // END TIME 누락
    if (!op.end_time || op.end_time === '-') {
      anomalies.push({ index: i, mode: op.operation_mode, flag: '[종료시간 누락]', detail: `start=${op.start_time}` });
    }
    // Runtime=0 + Volume>0
    if ((rt === 0 || rt === null) && vol > 0) {
      anomalies.push({ index: i, mode: op.operation_mode, flag: '[운전시간 오류]', detail: `runtime=${rt}, volume=${vol}` });
    }
    // 음수 Volume
    if (vol !== null && vol < 0) {
      anomalies.push({ index: i, mode: op.operation_mode, flag: '[데이터 오류]', detail: `negative volume=${vol}` });
    }
    // 중복 기록 (START TIME 1분 이내)
    if (op.start_time) {
      const ts = new Date(op.start_time).getTime();
      if (!isNaN(ts)) {
        for (const prev of startTimes) {
          if (Math.abs(ts - prev.ts) < 60000 && op.operation_mode === prev.mode) {
            anomalies.push({ index: i, mode: op.operation_mode, flag: '[중복기록 의심]', detail: `start=${op.start_time}` });
            break;
          }
        }
        startTimes.push({ ts, mode: op.operation_mode });
      }
    }
  }
  return anomalies;
}

/**
 * 모드별 집계 (횟수, 처리량, 운전시간)
 */
function aggregateByMode(operations) {
  const result = {};
  for (const op of operations) {
    const mode = op.operation_mode;
    if (!mode || mode === 'STOP') continue;
    if (!result[mode]) result[mode] = { count: 0, total_volume: 0, total_runtime: 0 };
    const g = result[mode];
    g.count++;
    const vol = op.ballast_volume ?? op.deballast_volume ?? 0;
    if (vol > 0) g.total_volume += vol;
    if (op.run_time > 0) g.total_runtime += op.run_time;
  }
  // 소수점 정리
  for (const g of Object.values(result)) {
    g.total_volume  = +g.total_volume.toFixed(2);
    g.total_runtime = +g.total_runtime.toFixed(2);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────
// 처리 효율 평가
// ─────────────────────────────────────────────────────────────────

/**
 * ECU 전류 & 염분도 기반 처리 효율 판정
 */
function evaluateTreatmentEfficiency(ecuAvg, csuAvg, flags = {}) {
  const result = { current_level: null, current_detail: null, salinity_impact: null, salinity_detail: null, anomalies: [] };

  if (ecuAvg != null) {
    if (ecuAvg >= 1500 && ecuAvg <= 3000) {
      result.current_level = 'NORMAL';
      result.current_detail = `평균 ${ecuAvg}A (정상 범위 1500~3000A)`;
    } else if (ecuAvg < 1000) {
      result.current_level = 'LOW';
      result.current_detail = `평균 ${ecuAvg}A (저전류 — 처리 성능 저하 가능)`;
      result.anomalies.push('[저전류 주의]');
    } else if (ecuAvg === 0) {
      result.current_level = 'ZERO';
      result.current_detail = `전류 미공급 — Bypass 의심`;
      result.anomalies.push('[전류 미공급 의심]');
    } else {
      result.current_level = 'NORMAL';
      result.current_detail = `평균 ${ecuAvg}A`;
    }
  }

  if (csuAvg != null) {
    if (csuAvg >= 35) {
      result.salinity_impact = 'NORMAL';
      result.salinity_detail = `평균 ${csuAvg}ppt (고염분 정상)`;
    } else if (csuAvg >= 10) {
      result.salinity_impact = 'NORMAL';
      result.salinity_detail = `평균 ${csuAvg}ppt`;
    } else if (csuAvg >= 5) {
      result.salinity_impact = 'LOW';
      result.salinity_detail = `평균 ${csuAvg}ppt (저염분 — 처리 효율 저하 가능)`;
      result.anomalies.push('[저염분 해역]');
    } else {
      result.salinity_impact = 'ULTRA_LOW';
      result.salinity_detail = `평균 ${csuAvg}ppt (초저염분 — 처리 불가 수준)`;
      result.anomalies.push('[초저염분 해역]');
    }
  }

  if (flags.gasDetectedCount > 0) result.anomalies.push(`[가스 감지] ${flags.gasDetectedCount}건`);
  if (flags.bypassCount > 0)      result.anomalies.push(`[Bypass 운전] ${flags.bypassCount}건`);
  if (flags.zeroVoltageCount > 0)  result.anomalies.push(`[전압 미인가 의심] ${flags.zeroVoltageCount}건`);
  if (flags.zeroCurrentCount > 0)  result.anomalies.push(`[전류 미공급 의심] ${flags.zeroCurrentCount}건`);

  return result;
}

// ─────────────────────────────────────────────────────────────────
// EventLog 분석 헬퍼
// ─────────────────────────────────────────────────────────────────

/**
 * 알람 코드별 빈도 분석
 */
function analyzeAlarmFrequency(alarms) {
  const codeMap = new Map();
  for (const a of alarms) {
    const code = a.code || '(코드없음)';
    if (!codeMap.has(code)) codeMap.set(code, { code, total: 0, Trip: 0, Alarm: 0, Warning: 0 });
    const g = codeMap.get(code);
    g.total++;
    if (a.level === 'Trip')    g.Trip++;
    else if (a.level === 'Alarm')  g.Alarm++;
    else if (a.level === 'Warning') g.Warning++;
  }
  const code_frequency = [...codeMap.values()].sort((a, b) => b.total - a.total);
  const repeated_alarms = code_frequency.filter(c => c.total >= 5);
  return { code_frequency, repeated_alarms };
}

/**
 * 장치별 Alarm+TRIP 빈도 순위 (TOP 5)
 */
function rankDeviceFrequency(alarms) {
  const devMap = new Map();
  for (const a of alarms) {
    const dev = a.device || '(불명)';
    if (!devMap.has(dev)) devMap.set(dev, { device: dev, alarm_count: 0, trip_count: 0 });
    const g = devMap.get(dev);
    if (a.level === 'Trip') g.trip_count++;
    else g.alarm_count++;
  }
  return [...devMap.values()]
    .sort((a, b) => (b.alarm_count + b.trip_count) - (a.alarm_count + a.trip_count))
    .slice(0, 5);
}

/**
 * 주요 패턴 분석
 */
function analyzeEventPatterns(alarms, counts) {
  const code727 = alarms.filter(a => a.code === 'CODE727');
  const commFail = alarms.filter(a => a.code === 'CODE701' || a.code === 'CODE703');
  const critical_flags = [];
  if (code727.length > 0) critical_flags.push(`[IMO 위반 가능성] 미처리수 배출 감지 ${code727.length}건`);
  if (commFail.length > 5) critical_flags.push(`[통신 장애 다발] CODE701/703 총 ${commFail.length}건`);

  return {
    untreated_water: { detected: code727.length > 0, count: code727.length },
    sensor_comm_failures: { count: commFail.length, codes: [...new Set(commFail.map(a => a.code))] },
    ecs_start_stop_mismatch: counts.powerOnCount !== (counts.wrongTerminationCount + counts.properTerminationCount),
    critical_flags,
  };
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

    const gpsRaw = get('position') || null;
    const op = {
      operation_mode:   mode,
      date:             get('date') || null,
      start_time:       get('start') || null,
      end_time:         get('end') || null,
      run_time:         parseRunTime(get('runtime')),   // 시간(소수)
      location_gps:     gpsRaw,
      parsed_gps:       parseGpsFromRow(gpsRaw),        // { lat, lon, area } 또는 null
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

  // ── Format B (TECHCROSS/KHM) 감지 ─────────────────────────────
  // 복수 지표로 판별: REC1_STATE_*, GDS1, BP1 등
  const formatBIndicators = upper.filter(h =>
    /REC\d*_STATE_/.test(h) || h === 'GDS1' || h === 'BP1' || h === 'BP2' || h === 'TE02V'
  ).length;
  const isFormatB = formatBIndicators >= 2;

  // ── 시계열 모드 판별 ──────────────────────────────────────────
  const opColIdx = upper.findIndex(h => h === 'OPERATION' || h === 'OP');
  if (opColIdx >= 0) {
    if (isFormatB) {
      console.log('[CSV/DataLog] Format B (TECHCROSS) 감지');
      return _parseDataLogFormatB(rows, upper, opColIdx);
    }
    return _parseDataLogTimeSeries(rows, upper, opColIdx);
  }

  // ── 요약 1행 모드 ─────────────────────────────────────────────
  return _parseDataLogSummary(rows, upper);
}

/** 셀 값이 '-' 또는 빈문자열이면 NaN 반환 (센서 미장착) */
function safeParse(cell) {
  if (!cell || cell === '-' || cell === '') return NaN;
  return parseFloat(cell);
}

/** 배열 통계 유틸 */
const _avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
const _max = arr => arr.length ? +(Math.max(...arr)).toFixed(2) : null;
const _min = arr => arr.length ? +(Math.min(...arr)).toFixed(2) : null;
function _stats(arr) { return { avg: _avg(arr), max: _max(arr), min: _min(arr), count: arr.length }; }

/** 시계열 원본 방식: 행별로 BALLAST/DEBALLAST 판별 후 TRO 수집 */
function _parseDataLogTimeSeries(rows, upper, opColIdx) {
  // ── TRO 컬럼 동적 탐색 ─────────────────────────────────────
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

  // ── 센서 컬럼 탐색 ─────────────────────────────────────────
  const ecuIdx     = upper.findIndex(h => /REC\d*_?(STATE_)?CURRENT/.test(h) && !h.includes('VOLTAGE'));
  const voltIdx    = upper.findIndex(h => /REC\d*_?(STATE_)?VOLTAGE/.test(h));
  const rec2CurIdx = upper.findIndex(h => /REC2_?(STATE_)?CURRENT/.test(h));
  const rec2VoltIdx= upper.findIndex(h => /REC2_?(STATE_)?VOLTAGE/.test(h));
  const fmuIdx     = upper.findIndex(h => /^FMU\d*$/.test(h) && !h.includes('_ST') && !h.includes('_DT'));
  const anuDIdx    = upper.findIndex(h => /^ANU[_-]?D\d*/.test(h));
  const anuSIdx    = upper.findIndex(h => /^ANU[_-]?S\d*/.test(h));
  const gasIdx     = upper.findIndex(h => /^GAS\d*$|^GDS\d*$/.test(h));
  const bypassIdx  = upper.findIndex(h => /^BV\d*$|^TE02V$/.test(h));
  const csuIdx     = upper.findIndex(h => /^CSU\d*$/.test(h));
  const ftsIdx     = upper.findIndex(h => /^FTS\d*$/.test(h));
  const pump1Idx   = upper.findIndex(h => /^PUMP1$|^BP1$/.test(h));
  const pump2Idx   = upper.findIndex(h => /^PUMP2$|^BP2$/.test(h));

  // ── 수집 배열 ─────────────────────────────────────────────
  const ballastTROs   = [];
  const deballastTROs = [];
  const ecuValues     = [];
  const fmuValues     = [];
  const csuValues     = [];
  const ftsValues     = [];
  const rec2CurValues = [];
  const rec2VoltValues = [];

  // 모드별 센서값 파티션 (performance 통계용)
  const modeData = { BALLAST: { volt: [], cur: [], csu: [], fmu: [], fts: [], anu_d: [] },
                     DEBALLAST: { volt: [], cur: [], csu: [], fmu: [], fts: [], anu_d: [] } };

  let anuOp = 0, anuAll = 0;
  let gasDetectedCount = 0;
  let bypassCount = 0;
  let zeroVoltageCount = 0;
  let zeroCurrentCount = 0;
  let ultraLowSalinityCount = 0;
  let fmuZeroPumpRunning = 0;
  let pumpNotRunning = 0;
  let fmuSum = 0;
  let operatingRowCount = 0;
  const dashCols = new Set(); // 센서 미장착 컬럼

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[opColIdx]) continue;

    const op          = row[opColIdx].trim().toUpperCase();
    const isBallast   = op === 'BALLAST'   || op === 'N-B' || /^\d+-?B$/i.test(op);
    const isDeballast = op === 'DEBALLAST' || op === 'N-D' || /^\d+-?D$/i.test(op);
    const isStripping = op === 'STRIPPING' || op === 'N-S' || /^\d+-?S$/i.test(op);
    if (!isBallast && !isDeballast && !isStripping) continue;
    operatingRowCount++;

    const modeKey = isBallast ? 'BALLAST' : 'DEBALLAST';
    const md = modeData[modeKey];

    // TRO 수집
    for (const col of troCols) {
      const v = safeParse(row[col.idx]);
      if (isNaN(v) || v < 0 || v > 15) { if (row[col.idx] === '-') dashCols.add(upper[col.idx]); continue; }
      const effectiveType = col.type === 'auto' ? (isBallast ? 'ballast' : 'deballast') : col.type;
      if (effectiveType === 'ballast'   && isBallast              && v >= 0.1) ballastTROs.push(v);
      if (effectiveType === 'deballast' && (isDeballast || isStripping))       deballastTROs.push(v);
    }

    // 전압/전류
    if (voltIdx >= 0) {
      const v = safeParse(row[voltIdx]);
      if (!isNaN(v)) { if (v === 0) zeroVoltageCount++; md.volt.push(v); }
      else if (row[voltIdx] === '-') dashCols.add(upper[voltIdx]);
    }
    if (ecuIdx >= 0) {
      const v = safeParse(row[ecuIdx]);
      if (!isNaN(v)) {
        if (v > 50) ecuValues.push(v);
        if (v === 0) zeroCurrentCount++;
        md.cur.push(v);
      } else if (row[ecuIdx] === '-') dashCols.add(upper[ecuIdx]);
    }
    // REC2 (2호기)
    if (rec2CurIdx >= 0) { const v = safeParse(row[rec2CurIdx]); if (!isNaN(v) && v > 0) rec2CurValues.push(v); }
    if (rec2VoltIdx >= 0) { const v = safeParse(row[rec2VoltIdx]); if (!isNaN(v) && v > 0) rec2VoltValues.push(v); }

    // FMU 유량
    if (fmuIdx >= 0) {
      const v = safeParse(row[fmuIdx]);
      if (!isNaN(v)) {
        if (v > 0) { fmuValues.push(v); fmuSum += v; }
        md.fmu.push(v);
        // FMU=0 + PUMP 운전 중
        if (v === 0) {
          const p1 = pump1Idx >= 0 ? safeParse(row[pump1Idx]) : NaN;
          const p2 = pump2Idx >= 0 ? safeParse(row[pump2Idx]) : NaN;
          if (p1 === 1 || p2 === 1) fmuZeroPumpRunning++;
        }
      }
    }
    // ANU
    if (anuDIdx >= 0) {
      const v = safeParse(row[anuDIdx]);
      if (!isNaN(v)) { anuAll++; if (v > 0) anuOp++; md.anu_d.push(v); }
    }
    // CSU (염분)
    if (csuIdx >= 0) {
      const v = safeParse(row[csuIdx]);
      if (!isNaN(v) && v > 0) {
        csuValues.push(v); md.csu.push(v);
        if (v < 5) ultraLowSalinityCount++;
      } else if (row[csuIdx] === '-') dashCols.add(upper[csuIdx]);
    }
    // FTS (수온)
    if (ftsIdx >= 0) {
      const v = safeParse(row[ftsIdx]);
      if (!isNaN(v) && v > 0) { ftsValues.push(v); md.fts.push(v); }
    }
    // GAS
    if (gasIdx >= 0) {
      const v = safeParse(row[gasIdx]);
      if (!isNaN(v) && v > 0) gasDetectedCount++;
    }
    // Bypass
    if (bypassIdx >= 0) {
      const v = safeParse(row[bypassIdx]);
      if (!isNaN(v) && v === 1) bypassCount++;
    }
    // PUMP 미작동 감지
    if (pump1Idx >= 0 || pump2Idx >= 0) {
      const p1 = pump1Idx >= 0 ? safeParse(row[pump1Idx]) : NaN;
      const p2 = pump2Idx >= 0 ? safeParse(row[pump2Idx]) : NaN;
      if ((isNaN(p1) || p1 === 0) && (isNaN(p2) || p2 === 0)) pumpNotRunning++;
    }
  }

  // Warm-up 첫 5행 제외 후 최솟값
  const stableArr = ballastTROs.slice(5);

  // 모드별 성능 통계
  const performance = {};
  for (const [mode, d] of Object.entries(modeData)) {
    if (d.volt.length === 0 && d.cur.length === 0) continue;
    performance[mode] = {
      voltage:     _stats(d.volt),
      current:     _stats(d.cur),
      salinity:    _stats(d.csu),
      flow:        _stats(d.fmu),
      temperature: _stats(d.fts),
      anu_d1:      _stats(d.anu_d),
    };
  }

  // 이상값 종합
  const data_anomalies = [];
  if (fmuZeroPumpRunning > 0) data_anomalies.push({ flag: '[유량 없음 주의]', count: fmuZeroPumpRunning });
  if (pumpNotRunning > 0)     data_anomalies.push({ flag: '[펌프 미작동]', count: pumpNotRunning });

  // 월간 총 유량 (1분 간격 기준: 행 수 × 평균 유량 / 60)
  const monthly_total_flow_m3 = fmuValues.length > 0
    ? +(fmuSum / 60).toFixed(2)  // FMU는 m³/h 단위, 1분 간격이므로 /60
    : null;

  const ecuAvg = _avg(ecuValues);
  const csuAvg = _avg(csuValues);

  console.log(`[CSV/DataLog] ballastTRO:${ballastTROs.length}건 / deballastTRO:${deballastTROs.length}건 / gas:${gasDetectedCount} / bypass:${bypassCount} / rows:${operatingRowCount}`);

  return {
    // 기존 필드 (하위 호환)
    ballasting_avg:        _avg(ballastTROs),
    ballasting_min:        _min(stableArr.length > 0 ? stableArr : ballastTROs),
    deballasting_max:      _max(deballastTROs),
    ecu_current_avg:       ecuAvg,
    fmu_flow_avg:          _avg(fmuValues),
    anu_status:            anuAll > 0 ? (anuOp / anuAll > 0.3 ? 'Operating' : 'Standby') : null,
    csu_avg:               csuAvg,
    fts_avg:               _avg(ftsValues),
    gasDetectedCount,
    bypassCount,
    zeroVoltageCount,
    zeroCurrentCount,
    ultraLowSalinityCount,
    // 신규 필드
    performance,
    efficiency:            evaluateTreatmentEfficiency(ecuAvg, csuAvg, { gasDetectedCount, bypassCount, zeroVoltageCount, zeroCurrentCount }),
    monthly_total_flow_m3,
    rec2_current_avg:      _avg(rec2CurValues),
    rec2_voltage_avg:      _avg(rec2VoltValues),
    data_anomalies,
    sensors_not_installed: [...dashCols],
    format_detected:       'A',
    operating_row_count:   operatingRowCount,
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

/**
 * Format B (TECHCROSS/KHM) 시계열 파싱
 * 컬럼명 매핑: REC1_STATE_CURRENT→전류, GDS1→가스, BP1/BP2→펌프, TE02V→bypass
 * '-' 값 = 센서 미장착/미측정 → 건너뜀
 */
function _parseDataLogFormatB(rows, upper, opColIdx) {
  // 컬럼 매핑 (Format B 전용)
  const ecuIdx     = upper.findIndex(h => /REC1_STATE_CURRENT/.test(h));
  const voltIdx    = upper.findIndex(h => /REC1_STATE_VOLTAGE/.test(h));
  const rec2CurIdx = upper.findIndex(h => /REC2_STATE_CURRENT/.test(h));
  const rec2VoltIdx= upper.findIndex(h => /REC2_STATE_VOLTAGE/.test(h));
  const fmuIdx     = upper.findIndex(h => /^FMU\d*$/.test(h));
  const anuDIdx    = upper.findIndex(h => /^ANU[_-]?D\d*/.test(h));
  const gasIdx     = upper.findIndex(h => /^GDS\d*$/.test(h));
  const bypassIdx  = upper.findIndex(h => /^TE02V$/.test(h));
  const csuIdx     = upper.findIndex(h => /^CSU\d*$/.test(h));
  const ftsIdx     = upper.findIndex(h => /^FTS\d*$/.test(h));
  const pump1Idx   = upper.findIndex(h => /^BP1$/.test(h));
  const pump2Idx   = upper.findIndex(h => /^BP2$/.test(h));

  // TRO 컬럼은 Format B에서도 동일 패턴
  const troCols = [];
  for (let i = 0; i < upper.length; i++) {
    const h = upper[i];
    if (!h.includes('TRO') && h !== 'T1' && h !== 'T2') continue;
    if (/TRO[_-]?B\d*/i.test(h))      troCols.push({ idx: i, type: 'ballast'   });
    else if (/TRO[_-]?D\d*/i.test(h)) troCols.push({ idx: i, type: 'deballast' });
    else if (/TRO[_-]?S\d*/i.test(h)) troCols.push({ idx: i, type: 'deballast' });
    else                               troCols.push({ idx: i, type: 'auto'      });
  }

  const ballastTROs = [], deballastTROs = [];
  const ecuValues = [], fmuValues = [], csuValues = [], ftsValues = [];
  const rec2CurValues = [], rec2VoltValues = [];
  const modeData = { BALLAST: { volt: [], cur: [], csu: [], fmu: [], fts: [], anu_d: [] },
                     DEBALLAST: { volt: [], cur: [], csu: [], fmu: [], fts: [], anu_d: [] } };
  let anuOp = 0, anuAll = 0;
  let gasDetectedCount = 0, bypassCount = 0, zeroVoltageCount = 0, zeroCurrentCount = 0;
  let ultraLowSalinityCount = 0, fmuZeroPumpRunning = 0, pumpNotRunning = 0, fmuSum = 0;
  let operatingRowCount = 0;
  const dashCols = new Set();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[opColIdx]) continue;
    const op = row[opColIdx].trim().toUpperCase();
    const isBallast   = op === 'BALLAST'   || op === 'N-B' || /^\d+-?B$/i.test(op);
    const isDeballast = op === 'DEBALLAST' || op === 'N-D' || /^\d+-?D$/i.test(op);
    const isStripping = op === 'STRIPPING' || op === 'N-S' || /^\d+-?S$/i.test(op);
    if (!isBallast && !isDeballast && !isStripping) continue;
    operatingRowCount++;
    const modeKey = isBallast ? 'BALLAST' : 'DEBALLAST';
    const md = modeData[modeKey];

    for (const col of troCols) {
      const v = safeParse(row[col.idx]);
      if (isNaN(v) || v < 0 || v > 15) { if (row[col.idx] === '-') dashCols.add(upper[col.idx]); continue; }
      const effectiveType = col.type === 'auto' ? (isBallast ? 'ballast' : 'deballast') : col.type;
      if (effectiveType === 'ballast' && isBallast && v >= 0.1) ballastTROs.push(v);
      if (effectiveType === 'deballast' && (isDeballast || isStripping)) deballastTROs.push(v);
    }

    if (voltIdx >= 0) { const v = safeParse(row[voltIdx]); if (!isNaN(v)) { if (v === 0) zeroVoltageCount++; md.volt.push(v); } else if (row[voltIdx] === '-') dashCols.add(upper[voltIdx]); }
    if (ecuIdx >= 0) { const v = safeParse(row[ecuIdx]); if (!isNaN(v)) { if (v > 50) ecuValues.push(v); if (v === 0) zeroCurrentCount++; md.cur.push(v); } else if (row[ecuIdx] === '-') dashCols.add(upper[ecuIdx]); }
    if (rec2CurIdx >= 0) { const v = safeParse(row[rec2CurIdx]); if (!isNaN(v) && v > 0) rec2CurValues.push(v); }
    if (rec2VoltIdx >= 0) { const v = safeParse(row[rec2VoltIdx]); if (!isNaN(v) && v > 0) rec2VoltValues.push(v); }
    if (fmuIdx >= 0) {
      const v = safeParse(row[fmuIdx]);
      if (!isNaN(v)) {
        if (v > 0) { fmuValues.push(v); fmuSum += v; }
        md.fmu.push(v);
        if (v === 0) { const p1 = pump1Idx >= 0 ? safeParse(row[pump1Idx]) : NaN; const p2 = pump2Idx >= 0 ? safeParse(row[pump2Idx]) : NaN; if (p1 === 1 || p2 === 1) fmuZeroPumpRunning++; }
      }
    }
    if (anuDIdx >= 0) { const v = safeParse(row[anuDIdx]); if (!isNaN(v)) { anuAll++; if (v > 0) anuOp++; md.anu_d.push(v); } }
    if (csuIdx >= 0) { const v = safeParse(row[csuIdx]); if (!isNaN(v) && v > 0) { csuValues.push(v); md.csu.push(v); if (v < 5) ultraLowSalinityCount++; } else if (row[csuIdx] === '-') dashCols.add(upper[csuIdx]); }
    if (ftsIdx >= 0) { const v = safeParse(row[ftsIdx]); if (!isNaN(v) && v > 0) { ftsValues.push(v); md.fts.push(v); } }
    if (gasIdx >= 0) { const v = safeParse(row[gasIdx]); if (!isNaN(v) && v > 0) gasDetectedCount++; }
    if (bypassIdx >= 0) { const v = safeParse(row[bypassIdx]); if (!isNaN(v) && v === 1) bypassCount++; }
    if (pump1Idx >= 0 || pump2Idx >= 0) {
      const p1 = pump1Idx >= 0 ? safeParse(row[pump1Idx]) : NaN;
      const p2 = pump2Idx >= 0 ? safeParse(row[pump2Idx]) : NaN;
      if ((isNaN(p1) || p1 === 0) && (isNaN(p2) || p2 === 0)) pumpNotRunning++;
    }
  }

  const stableArr = ballastTROs.slice(5);
  const performance = {};
  for (const [mode, d] of Object.entries(modeData)) {
    if (d.volt.length === 0 && d.cur.length === 0) continue;
    performance[mode] = { voltage: _stats(d.volt), current: _stats(d.cur), salinity: _stats(d.csu), flow: _stats(d.fmu), temperature: _stats(d.fts), anu_d1: _stats(d.anu_d) };
  }
  const data_anomalies = [];
  if (fmuZeroPumpRunning > 0) data_anomalies.push({ flag: '[유량 없음 주의]', count: fmuZeroPumpRunning });
  if (pumpNotRunning > 0)     data_anomalies.push({ flag: '[펌프 미작동]', count: pumpNotRunning });

  const ecuAvg = _avg(ecuValues);
  const csuAvg = _avg(csuValues);

  console.log(`[CSV/DataLog/FormatB] ballastTRO:${ballastTROs.length}건 / deballastTRO:${deballastTROs.length}건 / gas:${gasDetectedCount} / rows:${operatingRowCount}`);

  return {
    ballasting_avg: _avg(ballastTROs), ballasting_min: _min(stableArr.length > 0 ? stableArr : ballastTROs),
    deballasting_max: _max(deballastTROs), ecu_current_avg: ecuAvg, fmu_flow_avg: _avg(fmuValues),
    anu_status: anuAll > 0 ? (anuOp / anuAll > 0.3 ? 'Operating' : 'Standby') : null,
    csu_avg: csuAvg, fts_avg: _avg(ftsValues),
    gasDetectedCount, bypassCount, zeroVoltageCount, zeroCurrentCount, ultraLowSalinityCount,
    performance, efficiency: evaluateTreatmentEfficiency(ecuAvg, csuAvg, { gasDetectedCount, bypassCount, zeroVoltageCount, zeroCurrentCount }),
    monthly_total_flow_m3: fmuValues.length > 0 ? +(fmuSum / 60).toFixed(2) : null,
    rec2_current_avg: _avg(rec2CurValues), rec2_voltage_avg: _avg(rec2VoltValues),
    data_anomalies, sensors_not_installed: [...dashCols], format_detected: 'B', operating_row_count: operatingRowCount,
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
  let normalCount = 0;
  let alarmCount = 0;
  let tripCount = 0;
  let totalCount = 0;
  let powerOnCount = 0;
  let properTerminationCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 2) continue;
    const get = (f) => (cols[f] != null ? (row[cols[f]] || '').trim() : null);

    const rawLevel = (get('level') || '').toUpperCase();
    const desc     = (get('description') || '').trim();
    totalCount++;

    // Normal 레벨: 패턴 카운트
    if (/^NORMAL$/.test(rawLevel)) {
      normalCount++;
      if (desc.includes('terminated in the wrong way')) wrongTerminationCount++;
      if (desc.includes('GPS Time Set'))                gpsTimeSetCount++;
      if (desc.includes('HMI Power On'))                powerOnCount++;
      if (desc.includes('terminated') && !desc.includes('wrong way')) properTerminationCount++;
      continue;
    }

    let level;
    if (/TRIP|FAULT/.test(rawLevel))      { level = 'Trip';    tripCount++; }
    else if (/ALARM|알람/.test(rawLevel))  { level = 'Alarm';   alarmCount++; }
    else if (/WARN/.test(rawLevel))        { level = 'Warning'; alarmCount++; }
    else continue;

    const codeMatch = desc.match(/\[CODE\s*(\d+)\]/i);
    const code = codeMatch ? `CODE${codeMatch[1]}` : null;
    const cleanDesc = desc.replace(/\[CODE\s*\d+\]/gi, '').replace(/^\s*[-–]\s*/, '').trim();

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
      acked:       ackVal !== '-' && ackVal !== '',
      reset:       resetVal !== '-' && resetVal !== '',
      cleared:     clearVal === 'X',
      count:       1,
    });
  }

  // 레벨별 카운트 & 비율
  const level_counts = {
    normal: normalCount, alarm: alarmCount, trip: tripCount, total: totalCount,
    alarm_trip_ratio: totalCount > 0 ? +((alarmCount + tripCount) / totalCount * 100).toFixed(1) : 0,
  };

  // 코드별 빈도 & 장치별 순위 & 패턴 분석
  const { code_frequency, repeated_alarms } = analyzeAlarmFrequency(alarms);
  const device_ranking = rankDeviceFrequency(alarms);
  const patterns = analyzeEventPatterns(alarms, { powerOnCount, wrongTerminationCount, properTerminationCount });
  const trip_events = alarms.filter(a => a.level === 'Trip');

  return {
    alarms,
    wrongTerminationCount,
    gpsTimeSetCount,
    // 신규
    level_counts,
    code_frequency,
    repeated_alarms,
    device_ranking,
    patterns,
    trip_events,
  };
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

  // parseEventLogCsv 반환값 (확장됨)
  const evResult   = evText   ? parseEventLogCsv(evText)  : null;
  const error_alarms = evResult ? evResult.alarms : [];

  // 이벤트 로그 기본 통계 (기존 호환)
  const event_log_stats = evResult ? {
    unacknowledged:       error_alarms.filter(a => !a.acked).length,
    unreset:              error_alarms.filter(a => !a.reset).length,
    incomplete:           error_alarms.filter(a => !a.cleared).length,
    wrongTermination:     evResult.wrongTerminationCount || 0,
    gpsTimeSet:           evResult.gpsTimeSetCount || 0,
    overflow:             evResult._overflow || false,
  } : null;

  // 데이터 로그 이상값 플래그 (기존 호환)
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

  // ── 신규: OpTime 집계 & 이상 탐지 ──
  const op_time_stats     = aggregateByMode(operations);
  const op_time_anomalies = detectOpTimeAnomalies(operations);
  const gps_areas         = [...new Set(operations.map(o => o.parsed_gps?.area).filter(Boolean))];

  // ── 신규: DataLog 모드별 성능 & 효율 ──
  const data_log_performance = tro_data?.performance || null;
  const data_log_efficiency  = tro_data?.efficiency  || null;

  // ── 신규: EventLog 종합 분석 ──
  const event_log_analysis = evResult ? {
    level_counts:     evResult.level_counts,
    code_frequency:   evResult.code_frequency,
    repeated_alarms:  evResult.repeated_alarms,
    device_ranking:   evResult.device_ranking,
    patterns:         evResult.patterns,
    trip_events:      evResult.trip_events,
  } : null;

  return {
    // 기존 필드 (하위 호환)
    vessel_name:        vessel.name || vessel.vesselFolderName || null,
    imo_number:         vessel.imo  || null,
    period,
    operations,
    tro_data,
    error_alarms,
    event_log_stats,
    data_log_flags,
    _event_log_missing: evText == null,
    // 신규 필드
    op_time_stats,
    op_time_anomalies,
    gps_areas,
    data_log_performance,
    data_log_efficiency,
    event_log_analysis,
  };
}
