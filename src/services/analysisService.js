// ============================================================
//  analysisService.js
//  Pure JS analysis pipeline for BWTS log data
//  (extracted from geminiService.js — no AI dependencies)
// ============================================================

import {
  ALARM_INFO,
  ALARM_CATEGORIES,
  VALVE_PATTERN,
  VALVE_CODES,
} from "./alarmInfo.js";


// ── JSON parsing (with newline/truncation recovery) ─────────
function robustJsonParse(text) {
  const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

  // 1st: as-is
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // 2nd: remove newlines inside strings
  const noNewline = cleaned.replace(/(?<=[^\\])"((?:[^"\\]|\\.)*)"/g, (_, inner) =>
    `"${inner.replace(/[\r\n\t]+/g, " ")}"`
  );
  try { return JSON.parse(noNewline); } catch { /* continue */ }

  // 3rd: recover truncated JSON
  let partial = noNewline;
  const quoteCount = (partial.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) partial += '"';
  const stack = [];
  for (const ch of partial) {
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  partial += stack.reverse().join("");
  try { return JSON.parse(partial); } catch { /* continue */ }

  throw new Error("JSON 파싱 실패 (3차 복구 시도 모두 실패)");
}


// ── Alarm level normalization ───────────────────────────────
function normalizeAlarmLevels(alarms) {
  const levelMap = { trip: "Trip", alarm: "Alarm", warning: "Warning", normal: "Normal" };
  return alarms.map((a) => ({
    ...a,
    level: levelMap[(a.level || "").toLowerCase()] || a.level,
  }));
}


// ── Repeat alarm grouping ───────────────────────────────────
function groupRepeatAlarms(alarms) {
  const map = new Map();
  for (const a of alarms) {
    const baseDesc = (a.description || "").replace(/\s*[\[\(]\d[\d.]*[\]\)]/g, "").trim();
    if (!a.code && !baseDesc) continue;
    const key = `${a.code ?? ""}|${baseDesc}`;
    if (!map.has(key)) {
      map.set(key, { ...a, description: baseDesc, count: 1,
                     firstDate: a.date, lastDate: a.date, level: a.level });
    } else {
      const g = map.get(key);
      g.count++;
      if ((a.level || "").toLowerCase() === "trip") g.level = "Trip";
      if (a.date && (!g.firstDate || a.date < g.firstDate)) g.firstDate = a.date;
      if (a.date && (!g.lastDate  || a.date > g.lastDate))  g.lastDate  = a.date;
    }
  }
  return Array.from(map.values()).map((g) => {
    const dateRange =
      g.count > 1 && g.firstDate && g.lastDate && g.firstDate !== g.lastDate
        ? `${g.firstDate}~${g.lastDate}`
        : (g.firstDate || null);
    return {
      code:            g.code,
      description:     g.count > 1 ? `${g.description} (×${g.count}회)` : g.description,
      level:           g.level,
      date:            dateRange,
      time:            g.count === 1 ? g.time : null,
      sensor_at_event: g.count === 1 ? g.sensor_at_event : null,
    };
  });
}


// ── Valve warning auto-append ───────────────────────────────
function appendValveWarning(data) {
  const alarms = data.error_alarms || [];
  const valveAlarms = alarms.filter((a) =>
    (VALVE_PATTERN.test(a.description || "") || VALVE_CODES.test(String(a.code || "")))
    && a.code !== "VRCS_ERR"
  );
  if (valveAlarms.length === 0) return;

  const totalCount = valveAlarms.reduce((sum, a) => {
    const m = (a.description || "").match(/×(\d+)회/);
    return sum + (m ? parseInt(m[1]) : 1);
  }, 0);
  if (totalCount < 5) return;

  const codes = [...new Set(valveAlarms.map((a) => a.code).filter(Boolean))].join(", ");
  const isCritical = (data.overall_status === "CRITICAL") || totalCount >= 10;
  const note = isCritical
    ? `CODE(${codes}) 밸브 비정상 동작 총 ${totalCount}회 감지 — [긴급] 해당 밸브 즉각 점검 필요 (CRITICAL 수준).`
    : `CODE(${codes}) 밸브 비정상 동작 총 ${totalCount}회 감지 — 해당 밸브 개도 설정 및 센서 점검 권장.`;
  const remarksArr = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
  if (!remarksArr.some((l) => l.includes("밸브 비정상"))) remarksArr.push(note);
  data.ai_remarks = remarksArr;

  const remarksEnArr = Array.isArray(data.ai_remarks_en) ? data.ai_remarks_en : [];
  const noteEn = isCritical
    ? `CODE(${codes}) Valve abnormal operation detected ${totalCount} times — [URGENT] immediate valve inspection required (CRITICAL level).`
    : `CODE(${codes}) Valve abnormal operation detected ${totalCount} times — recommend checking valve position and feedback sensor.`;
  if (!remarksEnArr.some((l) => l.includes("Valve abnormal"))) remarksEnArr.push(noteEn);
  data.ai_remarks_en = remarksEnArr;
}


// ── TRO range check (placeholder — logic in recalcOverallStatus) ─
function checkTroRange(data) {
  // TRO deviation handled in recalcOverallStatus + autoFillRemarks
}


// ── overall_status full JS recalculation ────────────────────
function recalcOverallStatus(data) {
  const alarms = data.error_alarms || [];
  const tro    = data.tro_data    || {};

  const tripCount = alarms.filter((a) => (a.level || "").toLowerCase() === "trip").length;

  const maxRepeat = alarms.reduce((max, a) => {
    const m = (a.description || "").match(/×(\d+)회/);
    return Math.max(max, m ? parseInt(m[1]) : 1);
  }, 0);

  const troSafetyVal    = tro.ballasting_min ?? tro.ballasting_avg;
  const troBallastBad   = troSafetyVal != null && (troSafetyVal < 5 || troSafetyVal > 10);
  const troDeballastBad = tro.deballasting_max  != null && tro.deballasting_max > 0.1;

  const hasLogOverflow = alarms.some((a) => a.code === "LOG_OVERFLOW");

  const ops          = data.operations || [];
  const hadBallast   = ops.some((o) => /BALLAST/i.test(o.operation_mode || "") && !/DE/i.test(o.operation_mode || ""));
  const hadDeballast = ops.some((o) => /DEBALLAST/i.test(o.operation_mode || ""));
  const troAllNull   = (hadBallast   && tro.ballasting_avg == null && tro.ballasting_min == null)
                    || (hadDeballast && tro.deballasting_max == null);

  let jsStatus;
  if (tripCount >= 1 || maxRepeat >= 5) {
    jsStatus = "CRITICAL";
  } else if (
    maxRepeat >= 3 || alarms.length >= 3 ||
    troBallastBad || troDeballastBad || troAllNull || hasLogOverflow
  ) {
    jsStatus = "WARNING";
  } else {
    jsStatus = "NORMAL";
  }

  data.overall_status = jsStatus;

  if (troAllNull) {
    const remarksArr = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
    const hasTroMention = remarksArr.some((l) => /TRO/i.test(l));
    if (!hasTroMention || remarksArr.length === 0) {
      remarksArr.push("TRO 미수신 — DataReport 확인 필요.");
      data.ai_remarks = remarksArr;
    }
    const remarksEnArr = Array.isArray(data.ai_remarks_en) ? data.ai_remarks_en : [];
    if (!remarksEnArr.some((l) => l.includes("TRO data not received"))) {
      remarksEnArr.push("TRO data not received — please verify DataReport.");
      data.ai_remarks_en = remarksEnArr;
    }
  }
}


// ── Operation date concentration detection ──────────────────
function checkOperationCoverage(data) {
  const ops = data.operations || [];
  if (ops.length === 0) return;

  const dates = ops.map((o) => o.date).filter(Boolean);
  if (dates.length === 0) return;

  const uniqueDates = new Set(dates);
  if (uniqueDates.size === 1 && ops.length >= 2) {
    if (data.overall_status === "NORMAL") data.overall_status = "WARNING";
  }
}


// ── Operation date validation ───────────────────────────────
function validateOperationDates(data) {
  const ops = data.operations || [];
  const invalid = [];
  for (const op of ops) {
    if (!op.date) continue;
    const d = new Date(op.date);
    if (isNaN(d.getTime())) {
      invalid.push(op.date);
      op.date = null;
      continue;
    }
    const normalized = d.toISOString().slice(0, 10);
    const parts = op.date.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (parts) {
      const [, y, m, day] = parts;
      if (d.getFullYear() !== +y || d.getMonth() + 1 !== +m || d.getDate() !== +day) {
        invalid.push(op.date);
        op.date = null;
        continue;
      }
    }
    op.date = normalized;
  }
  if (invalid.length > 0) {
    console.warn("[validateOperationDates] 유효하지 않은 날짜 감지:", invalid.join(", "));
  }
}


// ── Zero-operations handling ────────────────────────────────
function checkZeroOperations(data) {
  const ops    = data.operations || [];
  const alarms = data.error_alarms || [];
  if (ops.length > 0) return;

  const opsNote   = "[운전 현황] 당월 운전 기록이 없습니다.";
  const opsNoteEn = "[Operations] No ballasting/deballasting operations recorded this month.";

  if (alarms.length > 0) {
    const existingRemarks = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
    const alarmLines = existingRemarks.filter((l) =>
      /^\[CODE|^\[VRCS|^\[LOG_OVERFLOW|^\[알람/i.test(l)
    );
    const fallbackLines = existingRemarks.filter((l) =>
      /알람|alarm|Trip|trip/i.test(l) && !/TRO 미수신|TRO.*미수신|not received/i.test(l)
    );
    data.ai_remarks    = [opsNote, ...(alarmLines.length > 0 ? alarmLines : fallbackLines)];
    const existingEnRemarks = Array.isArray(data.ai_remarks_en) ? data.ai_remarks_en : [];
    const alarmEnLines = existingEnRemarks.filter((l) =>
      /^\[CODE|^\[VRCS|^\[LOG_OVERFLOW|^\[No Alarm|^\[Alarm/i.test(l)
    );
    const fallbackEnLines = existingEnRemarks.filter((l) =>
      /alarm|Trip/i.test(l) && !/TRO.*not received|not received.*TRO/i.test(l)
    );
    data.ai_remarks_en = [opsNoteEn, ...(alarmEnLines.length > 0 ? alarmEnLines : fallbackEnLines)];
  } else {
    data.ai_remarks    = [opsNote, "[알람없음] 이상 알람 없음."];
    data.ai_remarks_en = [opsNoteEn, "[No Alarms] No abnormal alarms detected."];
  }
}


// ── TRO sanity check (bad units / extraction errors) ────────
function sanitizeTroValues(data) {
  const tro = data.tro_data;
  if (!tro) return;
  if (tro.ballasting_avg != null && tro.ballasting_avg > 100) {
    const val = tro.ballasting_avg;
    tro.ballasting_avg = null;
    const note = `[TRO 이상] 주입 TRO ${val}ppm — 비정상 수치(센서 오류 또는 단위 오류 의심). Data Log 원본 재확인 필요.`;
    const arr = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
    if (!arr.some((l) => l.includes("비정상 수치"))) arr.push(note);
    data.ai_remarks = arr;
  }
  if (tro.deballasting_max != null && tro.deballasting_max > 100) {
    const val = tro.deballasting_max;
    tro.deballasting_max = null;
    const note = `[TRO 이상] 배출 TRO 최댓값 ${val}ppm — 비정상 수치(센서 오류 또는 단위 오류 의심). Data Log 원본 재확인 필요.`;
    const arr = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
    if (!arr.some((l) => l.includes("비정상 수치"))) arr.push(note);
    data.ai_remarks = arr;
  }
  if (tro.deballasting_max != null && tro.deballasting_max > 1.0) {
    tro._deballasting_warning = `배출 TRO ${tro.deballasting_max}ppm — IMO 기준(0.1ppm) 대폭 초과. TRO 센서 교차오염, Ballast/Deballast 컬럼 혼동, 또는 중화 불량 가능성`;
  }
}


// ── Event Log page overflow detection (TOTAL LOG only) ──────
function checkEventLogPages(data, sections) {
  if (!sections?.op_time_start || !sections?.event_log_start) return;
  const eventLogPages = sections.op_time_start - sections.event_log_start;
  if (eventLogPages > 100) {
    const alarms = data.error_alarms || [];
    if (!alarms.some((a) => a.code === "LOG_OVERFLOW")) {
      alarms.push({
        code: "LOG_OVERFLOW",
        description: `Event Log ${eventLogPages}페이지 — 밸브 오작동 또는 반복 알람 지속 가능성. 전체 로그 상세 검토 필요.`,
        level: "Warning",
        date: null,
        time: null,
      });
      data.error_alarms = alarms;
    }
    if (data.overall_status === "NORMAL") data.overall_status = "WARNING";
  }
}


// ── Auto-fill remarks (comprehensive report) ────────────────
function autoFillRemarks(data) {
  const ops          = data.operations || [];
  const ballastCount = ops.filter(o => /^BALLAST$/i.test(o.operation_mode)).length;
  const deballastCount = ops.filter(o => /^DEBALLAST$/i.test(o.operation_mode)).length;
  const tro          = data.tro_data || {};
  const alarms       = data.error_alarms || [];
  const efficiency   = data.data_log_efficiency || tro.efficiency || null;
  const opStats      = data.op_time_stats || {};
  const opAnomalies  = data.op_time_anomalies || [];
  const gpsAreas     = data.gps_areas || [];
  const evAnalysis   = data.event_log_analysis || {};

  const koLines = [];
  const enLines = [];

  // ─ [운전 현황] ─────────────────────────────────────────────
  const bMin = tro.ballasting_min;
  const bAvg = tro.ballasting_avg;
  const dMax = tro.deballasting_max;
  const bSafe = bMin ?? bAvg;
  const bOk   = bSafe != null && bSafe >= 5 && bSafe <= 10;
  const dOk   = dMax  != null && dMax < 0.1;

  const bTroDetail = bMin != null && bAvg != null
    ? `최솟값 ${bMin}ppm / 평균 ${bAvg}ppm`
    : bMin != null ? `최솟값 ${bMin}ppm` : bAvg != null ? `평균 ${bAvg}ppm` : null;
  const bTroDetailEn = bMin != null && bAvg != null
    ? `min ${bMin}ppm / avg ${bAvg}ppm`
    : bMin != null ? `min ${bMin}ppm` : bAvg != null ? `avg ${bAvg}ppm` : null;

  const bTroKo = bTroDetail != null ? `${bTroDetail}(5~10ppm ${bOk ? "충족" : bSafe < 5 ? "미달" : "초과"})` : "미수신";
  const dTroKo = dMax != null ? `${dMax}ppm(IMO 기준 ${dOk ? "충족" : "초과"})` : "미수신";
  const bTroEn = bTroDetailEn != null ? `${bTroDetailEn}(5~10ppm: ${bOk ? "OK" : bSafe < 5 ? "low" : "high"})` : "N/A";
  const dTroEn = dMax != null ? `${dMax}ppm(IMO: ${dOk ? "compliant" : "exceeded"})` : "N/A";

  const bStats = opStats.BALLAST;
  const dStats = opStats.DEBALLAST;
  let volDetail = '';
  let volDetailEn = '';
  if (bStats || dStats) {
    const parts = [];
    const partsEn = [];
    if (bStats) { parts.push(`주입 ${bStats.total_volume}m³/${bStats.total_runtime}h`); partsEn.push(`ballast ${bStats.total_volume}m³/${bStats.total_runtime}h`); }
    if (dStats) { parts.push(`배출 ${dStats.total_volume}m³/${dStats.total_runtime}h`); partsEn.push(`deballast ${dStats.total_volume}m³/${dStats.total_runtime}h`); }
    volDetail = ` 총 처리량: ${parts.join(', ')}.`;
    volDetailEn = ` Total: ${partsEn.join(', ')}.`;
  }

  koLines.push(`[운전 현황] 주입 ${ballastCount}회 / 배출 ${deballastCount}회. 주입 TRO ${bTroKo}. 배출 TRO 최댓값 ${dTroKo}.${volDetail}`);
  enLines.push(`[Operations] ${ballastCount} ballasting / ${deballastCount} deballasting. Ballasting TRO ${bTroEn}. Deballasting TRO max ${dTroEn}.${volDetailEn}`);

  // ─ [ECU/FMU 분석] ──────────────────────────────────────────
  if (tro.ecu_current_avg != null || tro.fmu_flow_avg != null || tro.anu_status) {
    const parts = [
      tro.ecu_current_avg != null ? `전류 ${tro.ecu_current_avg}A` : null,
      tro.fmu_flow_avg    != null ? `유량 ${tro.fmu_flow_avg}m³/h` : null,
      tro.anu_status               ? `ANU ${tro.anu_status}`        : null,
    ].filter(Boolean).join(" / ");

    let correlation = '';
    let correlationEn = '';
    if (tro.ecu_current_avg != null && tro.fmu_flow_avg != null && bAvg != null) {
      if (tro.ecu_current_avg > 500 && tro.fmu_flow_avg > 10 && (bAvg < 1 || bAvg === 0)) {
        correlation = ' — ⚠️ 전류·유량 정상이나 TRO 미생성: 전극 열화 또는 TRO 센서 고장 의심';
        correlationEn = ' — Warning: Current/flow normal but TRO not generated: possible electrode degradation or TRO sensor failure';
      } else if (tro.ecu_current_avg > 500 && tro.fmu_flow_avg > 10 && bOk) {
        correlation = ' — 전류·유량·TRO 정상 상관관계 확인';
        correlationEn = ' — Current/flow/TRO correlation normal';
      }
    }
    let effNote = '';
    let effNoteEn = '';
    if (efficiency) {
      if (efficiency.current_level === 'LOW') { effNote += ` ⚠️ ${efficiency.current_detail}.`; effNoteEn += ` Warning: ${efficiency.current_detail}.`; }
      if (efficiency.salinity_impact === 'LOW' || efficiency.salinity_impact === 'ULTRA_LOW') { effNote += ` ⚠️ ${efficiency.salinity_detail}.`; effNoteEn += ` Warning: ${efficiency.salinity_detail}.`; }
    }

    koLines.push(`[ECU] ${parts}${correlation}.${effNote}`);
    enLines.push(`[ECU] ${parts}${correlationEn}.${effNoteEn}`);
  }

  // ─ [TRO 이상 경고] ─────────────────────────────────────────
  if (tro._deballasting_warning) {
    koLines.push(`[TRO 경고] ${tro._deballasting_warning}. Data Log 원본 확인 권장.`);
    enLines.push(`[TRO Warning] Deballasting TRO ${dMax}ppm — significantly exceeds IMO limit (0.1ppm). Possible sensor cross-contamination or column mismatch. Verify raw Data Log.`);
  }

  // ─ Alarm category grouping ────────────────────────────────
  const alarmSummary = [];

  if (alarms.length === 0) {
    koLines.push("[알람없음] 이상 알람 없음.");
    enLines.push("[No Alarms] No abnormal alarms detected.");
  } else {
    const codeMap = new Map();
    for (const a of alarms) {
      const code = a.code || "(코드없음)";
      if (!codeMap.has(code)) codeMap.set(code, { trips: 0, alarms: 0, total: 0 });
      const g = codeMap.get(code);
      const cnt = a.count || 1;
      if ((a.level || "").toLowerCase() === "trip") g.trips += cnt;
      else g.alarms += cnt;
      g.total += cnt;
    }

    const catGroups = new Map();
    for (const [code, g] of codeMap) {
      const info = ALARM_INFO[code];
      const cat = info?.cat || "OTHER";
      if (!catGroups.has(cat)) catGroups.set(cat, { trips: 0, alarms: 0, codes: [], actions: [], actionsEn: [] });
      const cg = catGroups.get(cat);
      cg.trips += g.trips;
      cg.alarms += g.alarms;
      const codeLabel = info ? `${info.title}(${code})` : code;
      const cnt = g.total > 1 ? ` ×${g.total}` : '';
      cg.codes.push(`${codeLabel}${cnt}`);
      cg.actions.push(info?.action || "상세 원인 확인 후 제조사 기술지원 요청");
      cg.actionsEn.push(info?.actionEn || "Identify root cause and contact manufacturer");
    }

    for (const [cat, cg] of catGroups) {
      const catInfo = ALARM_CATEGORIES[cat] || ALARM_CATEGORIES.OTHER;
      const cntStr = [cg.trips && `Trip ${cg.trips}건`, cg.alarms && `Alarm ${cg.alarms}건`].filter(Boolean).join(" / ");
      const cntStrEn = [cg.trips && `Trip×${cg.trips}`, cg.alarms && `Alarm×${cg.alarms}`].filter(Boolean).join("+");
      const uniqueActions = [...new Set(cg.actions)].slice(0, 2);
      const uniqueActionsEn = [...new Set(cg.actionsEn)].slice(0, 2);

      alarmSummary.push({
        cat, icon: catInfo.icon, label: catInfo.label, labelEn: catInfo.labelEn,
        trips: cg.trips, alarms: cg.alarms,
        codes: cg.codes,
        action: uniqueActions.join(' / '),
        actionEn: uniqueActionsEn.join(' / '),
      });

      koLines.push(`${catInfo.icon} ${catInfo.label} (${cntStr}) — ${uniqueActions[0]}`);
      enLines.push(`${catInfo.icon} ${catInfo.labelEn} (${cntStrEn}) — ${uniqueActionsEn[0]}`);
    }

    const repeated = evAnalysis.repeated_alarms || [];
    if (repeated.length > 0) {
      const repCodes = repeated.map(r => `${r.code}(${r.total}회)`).join(', ');
      koLines.push(`⚠️ 반복 알람: ${repCodes} — 근본 원인 분석(RCA) 필요`);
      enLines.push(`⚠️ Repeated: ${repeated.map(r => `${r.code}(${r.total}x)`).join(', ')} — RCA required`);
    }
  }

  data.alarm_summary = alarmSummary;

  // ─ [운전 이상] (OpTime anomalies) ─────────────────────────
  if (opAnomalies.length > 0) {
    const flagCounts = {};
    for (const a of opAnomalies) { flagCounts[a.flag] = (flagCounts[a.flag] || 0) + 1; }
    const flagStr = Object.entries(flagCounts).map(([f, c]) => `${f} ${c}건`).join(', ');
    koLines.push(`[운전 이상] ${flagStr}.`);
    enLines.push(`[Operation Anomalies] ${Object.entries(flagCounts).map(([f, c]) => `${f} ${c} case(s)`).join(', ')}.`);
  }

  // ─ [운항 해역] ─────────────────────────────────────────────
  if (gpsAreas.length > 0) {
    koLines.push(`[운항 해역] ${gpsAreas.join(', ')}.`);
    enLines.push(`[Operating Area] ${gpsAreas.join(', ')}.`);
  }

  // ─ [종합] ─────────────────────────────────────────────────
  const status = (data.overall_status || "NORMAL").toUpperCase();
  const tripCount = alarms.filter(a => (a.level || "").toLowerCase() === "trip").reduce((s, a) => s + (a.count || 1), 0);
  const alarmCount = alarms.reduce((s, a) => s + (a.count || 1), 0) - tripCount;

  const issues = [];
  const issuesEn = [];
  if (tripCount > 0) { issues.push(`Trip ${tripCount}건 발생`); issuesEn.push(`${tripCount} trip(s)`); }
  if (!bOk && bSafe != null) { issues.push(`주입 TRO ${bSafe < 5 ? '미달' : '초과'}`); issuesEn.push(`ballasting TRO ${bSafe < 5 ? 'low' : 'high'}`); }
  if (!dOk && dMax != null) { issues.push(`배출 TRO 기준 초과`); issuesEn.push(`deballasting TRO exceeded`); }
  if (tro._deballasting_warning) { issues.push('배출 TRO 이상값 확인 필요'); issuesEn.push('deballasting TRO anomaly detected'); }

  if (status === "CRITICAL") {
    koLines.push(`[종합] ${issues.join(', ')}. 즉각적인 장비 점검 및 원인 분석이 필요합니다. ${alarmCount > 5 ? '알람 다발 — 정비 이력 확인 권장.' : ''}`);
    enLines.push(`[Summary] ${issuesEn.join(', ')}. Immediate equipment inspection and root cause analysis required. ${alarmCount > 5 ? 'Multiple alarms — review maintenance history.' : ''}`);
  } else if (status === "WARNING") {
    koLines.push(`[종합] ${issues.length > 0 ? issues.join(', ') + '. ' : ''}주의 필요 — 알람 내역 및 TRO 수치를 모니터링하시기 바랍니다.`);
    enLines.push(`[Summary] ${issuesEn.length > 0 ? issuesEn.join(', ') + '. ' : ''}Attention required — monitor alarm records and TRO values.`);
  } else {
    koLines.push("[종합] 전반적으로 정상 운전 중. 특이사항 없음.");
    enLines.push("[Summary] Overall normal operation. No significant issues detected.");
  }

  data.ai_remarks    = koLines;
  data.ai_remarks_en = enLines;
}


// ── Main validation & normalization pipeline ────────────────
export function validateAndNormalizeResult(data, sections = null) {
  if (!data || typeof data !== "object") return {};
  const s = (data.overall_status || "").toUpperCase();
  if (!["NORMAL", "WARNING", "CRITICAL"].includes(s)) data.overall_status = null;
  if (!Array.isArray(data.error_alarms)) data.error_alarms = [];
  if (!Array.isArray(data.operations))   data.operations  = [];
  if (!Array.isArray(data.ai_remarks))
    data.ai_remarks    = data.ai_remarks    ? [String(data.ai_remarks)]    : [];
  if (!Array.isArray(data.ai_remarks_en))
    data.ai_remarks_en = data.ai_remarks_en ? [String(data.ai_remarks_en)] : [];
  // 0. Event Log page overflow
  checkEventLogPages(data, sections);
  // 1. Date validation
  validateOperationDates(data);
  // 0-1. TRO sanity check
  sanitizeTroValues(data);
  // 1. Alarm level normalization
  data.error_alarms = normalizeAlarmLevels(data.error_alarms);
  // 2. Repeat alarm grouping
  data.error_alarms = groupRepeatAlarms(data.error_alarms);
  // 3. Valve warning
  appendValveWarning(data);
  // 4. TRO range check
  checkTroRange(data);
  // 5. overall_status JS recalculation
  recalcOverallStatus(data);
  // 6. Operation date concentration
  checkOperationCoverage(data);
  // 7. Zero-operations warning
  checkZeroOperations(data);
  // 8. Auto-fill remarks
  autoFillRemarks(data);
  return data;
}


// ── ECS file type detection (filename-based) ────────────────
export function detectEcsFileType(filename) {
  const n = (filename || "").toUpperCase();
  if (/DATA.?(LOG|REPORT)/i.test(n)) return "data";
  if (/EVENT.?(LOG|REPORT)/i.test(n)) return "event";
  if (/OPERATION.?TIME|OPTIME|OP.?TIME/i.test(n)) return "optime";
  if (/TOTAL/i.test(n)) return "total";
  if (/REPORT/i.test(n)) return "total";
  return "unknown";
}


// ── Drive file download ─────────────────────────────────────
async function downloadDriveFile(fileId, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Drive 다운로드 실패 (${fileId}): ${res.status}`);
  return res.blob();
}


// ── CSV analysis pipeline (replaces analyzePdfFromDrive) ────
export async function analyzeCsvFromDrive(files, accessToken, vessel = {}) {
  const normalizedFiles = Array.isArray(files)
    ? files.map(f => typeof f === "string" ? { id: f, name: "" } : f)
    : [typeof files === "string" ? { id: files, name: "" } : files];

  const csvFiles = normalizedFiles.filter(
    f => (f.name || '').toUpperCase().endsWith('.CSV')
  );
  if (csvFiles.length === 0) {
    console.warn('[analyzeCsvFromDrive] CSV 파일 없음');
    return validateAndNormalizeResult({
      vessel_name: vessel.name || null,
      operations: [], tro_data: {}, error_alarms: [],
      overall_status: null, ai_remarks: [], ai_remarks_en: [],
    }, null);
  }

  console.log('[CSV] CSV 파일 감지:', csvFiles.map(f => f.name).join(', '));
  const opFile   = csvFiles.find(f => detectEcsFileType(f.name) === 'optime');
  const dataFile = csvFiles.find(f => detectEcsFileType(f.name) === 'data');
  const evFile   = csvFiles.find(f => detectEcsFileType(f.name) === 'event');

  const readCsv = async (file) => {
    if (!file) return null;
    try {
      const blob = await downloadDriveFile(file.id, accessToken);
      return await blob.text();
    } catch (e) {
      console.warn(`[CSV] ${file.name} 읽기 실패:`, e.message);
      return null;
    }
  };

  const [opText, dataText, evText] = await Promise.all([
    readCsv(opFile), readCsv(dataFile), readCsv(evFile)
  ]);

  const { combineCsvResults } = await import('./csvService.js');
  const parsed = combineCsvResults(opText, dataText, evText, vessel);
  console.log('[CSV] 파싱 완료 — ops:', parsed.operations.length,
    '/ tro:', parsed.tro_data ? 'OK' : 'null',
    '/ alarms:', parsed.error_alarms.length,
    '/ eventLogMissing:', parsed._event_log_missing);
  return validateAndNormalizeResult(parsed, null);
}
