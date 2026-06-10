// ============================================================
//  fallback.js
//  순수 JS 분석 — Gemini 실패 / 토글 OFF 시 사용
//  analysisService.js의 6~11단계 함수를 그대로 포팅
//  (1~5단계 정제는 클라이언트에서 완료된 상태로 입력 수신)
// ============================================================

import { ALARM_INFO, ALARM_CATEGORIES, VALVE_PATTERN, VALVE_CODES } from "./alarmInfo.js";


// ── overall_status 재계산 ───────────────────────────────────
// 판정 기준 (2026-05 개편):
//   - VRCS_ERR 알람은 BWTS 판정에서 제외
//   - 임계값 완화: Trip 5건+ / 반복 15회+ = CRITICAL (×N회 합산)
//   - 최근 운전 기준: 최근 7일 내 알람·TRO 이상 없으면 NORMAL로 완화
function recalcOverallStatus(data) {
  const allAlarms = data.error_alarms || [];
  const tro       = data.tro_data    || {};
  const ops       = data.operations  || [];

  const bwtsAlarms = allAlarms.filter((a) => a.code !== "VRCS_ERR");

  const parseRepeat = (a) => {
    const m = (a.description || "").match(/×(\d+)회/);
    return m ? parseInt(m[1]) : 1;
  };

  const tripCount = bwtsAlarms
    .filter((a) => (a.level || "").toLowerCase() === "trip")
    .reduce((sum, a) => sum + parseRepeat(a), 0);

  const maxRepeat = bwtsAlarms.reduce((max, a) => Math.max(max, parseRepeat(a)), 0);

  const troSafetyVal    = tro.ballasting_min ?? tro.ballasting_avg;
  const troBallastBad   = troSafetyVal != null && (troSafetyVal < 5 || troSafetyVal > 10);
  const troDeballastBad = tro.deballasting_max  != null && tro.deballasting_max > 0.1;

  const hasLogOverflow = bwtsAlarms.some((a) => a.code === "LOG_OVERFLOW");

  const hadBallast   = ops.some((o) => /BALLAST/i.test(o.operation_mode || "") && !/DE/i.test(o.operation_mode || ""));
  const hadDeballast = ops.some((o) => /DEBALLAST/i.test(o.operation_mode || ""));
  const troAllNull   = (hadBallast   && tro.ballasting_avg == null && tro.ballasting_min == null)
                    || (hadDeballast && tro.deballasting_max == null);

  let jsStatus;
  if (tripCount >= 5 || maxRepeat >= 15) {
    jsStatus = "CRITICAL";
  } else if (
    tripCount >= 1 || maxRepeat >= 5 || bwtsAlarms.length >= 5 ||
    troBallastBad || troDeballastBad || troAllNull || hasLogOverflow
  ) {
    jsStatus = "WARNING";
  } else {
    jsStatus = "NORMAL";
  }

  if (jsStatus !== "NORMAL") {
    const opDates = ops.map((o) => o.date).filter(Boolean).sort();
    const lastOpDate = opDates[opDates.length - 1];
    if (lastOpDate) {
      const RECENT_WINDOW_DAYS = 7;
      const cutoff = new Date(lastOpDate + "T00:00:00Z");
      cutoff.setUTCDate(cutoff.getUTCDate() - RECENT_WINDOW_DAYS);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const getAlarmLastDate = (a) => {
        if (!a.date) return null;
        const m = a.date.match(/~(\d{4}-\d{2}-\d{2})$/);
        return m ? m[1] : a.date;
      };
      const recentAlarms = bwtsAlarms.filter((a) => {
        const last = getAlarmLastDate(a);
        return last && last >= cutoffStr;
      });

      if (recentAlarms.length === 0 && !troBallastBad && !troDeballastBad) {
        jsStatus = "NORMAL";
      }
    }
  }

  data.overall_status = jsStatus;

  if (troAllNull) {
    const remarksArr = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
    if (!remarksArr.some((l) => /TRO/i.test(l))) {
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


// ── 운전 집중도 (단일 날짜 다회 운전) ─────────────────────
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


// ── 운전 0회 처리 ───────────────────────────────────────────
function checkZeroOperations(data) {
  const ops    = data.operations || [];
  const alarms = data.error_alarms || [];
  if (ops.length > 0) return;

  const opsNote   = "[운전 현황] 당월 운전 기록이 없습니다.";
  const opsNoteEn = "[Operations] No ballasting/deballasting operations recorded this month.";

  if (alarms.length > 0) {
    const existing = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
    const alarmLines = existing.filter((l) => /^\[CODE|^\[VRCS|^\[LOG_OVERFLOW|^\[알람/i.test(l));
    const fallbackLines = existing.filter((l) =>
      /알람|alarm|Trip|trip/i.test(l) && !/TRO 미수신|TRO.*미수신|not received/i.test(l)
    );
    data.ai_remarks = [opsNote, ...(alarmLines.length > 0 ? alarmLines : fallbackLines)];
    const existingEn = Array.isArray(data.ai_remarks_en) ? data.ai_remarks_en : [];
    const alarmEnLines = existingEn.filter((l) => /^\[CODE|^\[VRCS|^\[LOG_OVERFLOW|^\[No Alarm|^\[Alarm/i.test(l));
    const fallbackEnLines = existingEn.filter((l) =>
      /alarm|Trip/i.test(l) && !/TRO.*not received|not received.*TRO/i.test(l)
    );
    data.ai_remarks_en = [opsNoteEn, ...(alarmEnLines.length > 0 ? alarmEnLines : fallbackEnLines)];
  } else {
    data.ai_remarks    = [opsNote, "[알람없음] 이상 알람 없음."];
    data.ai_remarks_en = [opsNoteEn, "[No Alarms] No abnormal alarms detected."];
  }
}


// ── 밸브 다발 경고 ──────────────────────────────────────────
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


// ── 종합 요약 (한·영, alarm_summary 동시 산출) ─────────────
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

  // 실운용 일수 (unique date)
  const ballastDates   = new Set(ops.filter(o => /^BALLAST$/i.test(o.operation_mode || "")).map(o => o.date).filter(Boolean));
  const deballastDates = new Set(ops.filter(o => /^DEBALLAST$/i.test(o.operation_mode || "")).map(o => o.date).filter(Boolean));
  const allOpDates     = new Set([...ballastDates, ...deballastDates]);
  const opDays         = allOpDates.size;
  const opDaysKo = opDays > 0 ? `운용 ${opDays}일(발라스팅 ${ballastDates.size}일 / 디발라스팅 ${deballastDates.size}일). ` : '';
  const opDaysEn = opDays > 0 ? `${opDays} day(s) operated (ballast ${ballastDates.size}d / deballast ${deballastDates.size}d). ` : '';

  koLines.push(`[운전 현황] ${opDaysKo}주입 ${ballastCount}회 / 배출 ${deballastCount}회. 주입 TRO ${bTroKo}. 배출 TRO 최댓값 ${dTroKo}.${volDetail}`);
  enLines.push(`[Operations] ${opDaysEn}${ballastCount} ballasting / ${deballastCount} deballasting. Ballasting TRO ${bTroEn}. Deballasting TRO max ${dTroEn}.${volDetailEn}`);

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

  if (tro._deballasting_warning) {
    koLines.push(`[TRO 경고] ${tro._deballasting_warning}. Data Log 원본 확인 권장.`);
    enLines.push(`[TRO Warning] Deballasting TRO ${dMax}ppm — significantly exceeds IMO limit (0.1ppm). Possible sensor cross-contamination or column mismatch. Verify raw Data Log.`);
  }

  const alarmSummary = [];

  if (alarms.length === 0) {
    koLines.push("[알람없음] 이상 알람 없음.");
    enLines.push("[No Alarms] No abnormal alarms detected.");
  } else {
    const codeMap = new Map();
    for (const a of alarms) {
      if (a.code === "VRCS_ERR") continue; // VRCS는 alarm_summary에서 제외
      const code = a.code || "(코드없음)";
      if (!codeMap.has(code)) codeMap.set(code, { trips: 0, alarms: 0, total: 0 });
      const g = codeMap.get(code);
      const m = (a.description || "").match(/×(\d+)회/);
      const cnt = m ? parseInt(m[1]) : (a.count || 1);
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

  if (opAnomalies.length > 0) {
    const flagCounts = {};
    for (const a of opAnomalies) { flagCounts[a.flag] = (flagCounts[a.flag] || 0) + 1; }
    const flagStr = Object.entries(flagCounts).map(([f, c]) => `${f} ${c}건`).join(', ');
    koLines.push(`[운전 이상] ${flagStr}.`);
    enLines.push(`[Operation Anomalies] ${Object.entries(flagCounts).map(([f, c]) => `${f} ${c} case(s)`).join(', ')}.`);
  }

  if (gpsAreas.length > 0) {
    koLines.push(`[운항 해역] ${gpsAreas.join(', ')}.`);
    enLines.push(`[Operating Area] ${gpsAreas.join(', ')}.`);
  }

  // VRCS 별도 라인
  const vrcsCount = alarms.filter(a => a.code === "VRCS_ERR")
    .reduce((s, a) => {
      const m = (a.description || "").match(/×(\d+)회/);
      return s + (m ? parseInt(m[1]) : (a.count || 1));
    }, 0);
  if (vrcsCount > 0) {
    koLines.push(`[VRCS] 밸브 제어 시스템 알람 ${vrcsCount}건 — BWTS 판정과 별개로 별도 조치 필요.`);
    enLines.push(`[VRCS] Valve control system alarms detected ${vrcsCount} time(s) — requires separate action, excluded from BWTS judgment.`);
  }

  const status = (data.overall_status || "NORMAL").toUpperCase();
  // groupRepeatAlarms 이후엔 count 필드가 없고 description에 "×N회"만 남으므로
  // 반드시 ×N회를 파싱해야 실제 발생 건수가 나온다 (count fallback은 미그룹 입력용)
  const parseCount = (a) => {
    const m = (a.description || "").match(/×(\d+)회/);
    return m ? parseInt(m[1]) : (a.count || 1);
  };
  const bwtsForCount = alarms.filter(a => a.code !== "VRCS_ERR");
  const tripCount = bwtsForCount.filter(a => (a.level || "").toLowerCase() === "trip").reduce((s, a) => s + parseCount(a), 0);
  const alarmCount = bwtsForCount.reduce((s, a) => s + parseCount(a), 0) - tripCount;

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


// ── 진입점: 정제된 입력 → 판정 + 요약 결과 ──────────────────
export function runFallback(input) {
  // input을 mutating하지 않도록 얕은 복사
  const data = {
    operations: input.operations || [],
    tro_data: input.tro_data || {},
    error_alarms: input.error_alarms || [],
    op_time_stats: input.op_time_stats || {},
    op_time_anomalies: input.op_time_anomalies || [],
    event_log_analysis: input.event_log_analysis || {},
    data_log_efficiency: input.data_log_efficiency || null,
    gps_areas: input.gps_areas || [],
    ai_remarks: [],
    ai_remarks_en: [],
    overall_status: null,
    alarm_summary: [],
  };

  recalcOverallStatus(data);
  checkOperationCoverage(data);
  checkZeroOperations(data);
  appendValveWarning(data);
  autoFillRemarks(data);

  return {
    overall_status: data.overall_status,
    ai_remarks: data.ai_remarks,
    ai_remarks_en: data.ai_remarks_en,
    alarm_summary: data.alarm_summary,
  };
}
