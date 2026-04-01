// ============================================================
//  geminiService.js
//  Gemini 2.5 Flash API를 통한 BWTS 로그 PDF 자동 분析
//
//  [방식] 2단계 파이프라인:
//    Stage 1 — PDF 첨부, 데이터 추출 전용 (해석/판단 없음)
//    Stage 2 — JSON 입력, 분析/판정/remarks 생성 (PDF 없음)
//  [응답] JSON 강제 파싱 (최대 3회 재시도)
// ============================================================

import { CONFIG } from "../config.js";
import {
  STAGE1_TEXT_SCHEMA,
  STAGE1_RESPONSE_SCHEMA,
  EXTRACTION_PROMPT,
  EXTRACTION_PROMPT_TOTALLOG,
  REMARK_PROMPT_TEMPLATE,
  SECTION_DISCOVERY_PROMPT,
} from "./prompts.js";

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;


// ── JSON 파싱 (개행/특수문자/잘림 보정 포함) ─────────────────
function robustJsonParse(text) {
  const cleaned = text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

  // 1차 시도: 그대로
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // 2차: 문자열 내 개행 제거
  const noNewline = cleaned.replace(/(?<=[^\\])"((?:[^"\\]|\\.)*)"/g, (_, inner) =>
    `"${inner.replace(/[\r\n\t]+/g, " ")}"`
  );
  try { return JSON.parse(noNewline); } catch { /* continue */ }

  // 3차: 잘린 JSON 복구 시도 (닫히지 않은 배열/객체 닫기)
  let partial = noNewline;
  // 열린 따옴표 닫기
  const quoteCount = (partial.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) partial += '"';
  // 닫히지 않은 배열/객체 닫기
  const stack = [];
  for (const ch of partial) {
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  partial += stack.reverse().join("");
  try { return JSON.parse(partial); } catch { /* continue */ }

  throw new Error(`JSON 파싱 실패: ${cleaned.slice(0, 80)}…`);
}

// ── 알람 레벨 정규화 (TRIP/trip/Trip → Trip 등) ───────────────
function normalizeAlarmLevels(alarms) {
  const levelMap = { trip: "Trip", alarm: "Alarm", warning: "Warning", normal: "Normal" };
  return alarms.map((a) => ({
    ...a,
    level: levelMap[(a.level || "").toLowerCase()] || a.level,
  }));
}

// ── 반복 알람 그룹화 ─────────────────────────────────────────
function groupRepeatAlarms(alarms) {
  const map = new Map();
  for (const a of alarms) {
    const baseDesc = (a.description || "").replace(/\s*[\[\(]\d[\d.]*[\]\)]/g, "").trim();
    // 코드와 설명이 둘 다 비어있는 의미없는 알람은 건너뜀
    if (!a.code && !baseDesc) continue;
    const key = `${a.code ?? ""}|${baseDesc}`;
    if (!map.has(key)) {
      map.set(key, { ...a, description: baseDesc, count: 1,
                     firstDate: a.date, lastDate: a.date, level: a.level });
    } else {
      const g = map.get(key);
      g.count++;
      // Trip이 한 번이라도 있으면 level을 Trip으로 승격
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

// ── 밸브 과다 경고 자동 추가 ──────────────────────────────────
const VALVE_PATTERN = /Valve|밸브/i;
const VALVE_CODES   = /^7[2-3]\d$/;

function appendValveWarning(data) {
  const alarms = data.error_alarms || [];
  const valveAlarms = alarms.filter((a) =>
    (VALVE_PATTERN.test(a.description || "") || VALVE_CODES.test(String(a.code || "")))
    && a.code !== "VRCS_ERR" // AI가 이미 요약 처리한 채터링 항목은 중복 카운트 제외
  );
  if (valveAlarms.length === 0) return;

  // ×N회 표기에서 count 추출 (없으면 1)
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

// ── TRO 범위 체크 (remarks는 autoFillRemarks의 [운전 현황]에서 처리) ────
// 이 함수는 overall_status 재계산에 앞서 호출되어 TRO 범위 이탈을 로그로만 남김
function checkTroRange(data) {
  // TRO 이탈 여부는 recalcOverallStatus + autoFillRemarks에서 처리됨
  // (이전에 ai_remarks에 직접 추가하던 로직 → autoFillRemarks [운전 현황] 라인으로 통합)
}

// ── overall_status JS 완전 재계산 ────────────────────────────
function recalcOverallStatus(data) {
  const alarms = data.error_alarms || [];
  const tro    = data.tro_data    || {};

  // AI 원본 판정 기록 (escalation 감지용)
  const aiStatus = (data.overall_status || "").toUpperCase();

  // Trip 건수
  const tripCount = alarms.filter((a) => (a.level || "").toLowerCase() === "trip").length;

  // 알람 최대 반복 횟수 (×N회 표기에서 추출, 없으면 1)
  const maxRepeat = alarms.reduce((max, a) => {
    const m = (a.description || "").match(/×(\d+)회/);
    return Math.max(max, m ? parseInt(m[1]) : 1);
  }, 0);

  // TRO 기준 위반 여부
  // 주입: ballasting_min(안정구간 최솟값)이 판정 기준 — 단 한 번이라도 5ppm 미만이면 문제
  //       ballasting_min 없으면 ballasting_avg로 폴백
  const troSafetyVal    = tro.ballasting_min ?? tro.ballasting_avg;
  const troBallastBad   = troSafetyVal != null && (troSafetyVal < 5 || troSafetyVal > 10);
  const troDeballastBad = tro.deballasting_max  != null && tro.deballasting_max > 0.1;

  // LOG_OVERFLOW 감지
  const hasLogOverflow = alarms.some((a) => a.code === "LOG_OVERFLOW");

  // TRO null → 실제 운전이 있었을 때만 WARNING (운전 없는 달은 제외)
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

  // TRO null인데 ai_remarks에 TRO 언급이 없을 때만 한 줄 추가
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

// ── 운전 날짜 편중 감지 (특정 날짜에만 집중 → 누락 경고) ────
function checkOperationCoverage(data) {
  const ops = data.operations || [];
  if (ops.length === 0) return;

  // 운전 날짜 목록 (null 제외)
  const dates = ops.map((o) => o.date).filter(Boolean);
  if (dates.length === 0) return;

  const uniqueDates = new Set(dates);

  // 모든 운전이 단 하루에 집중된 경우 → 상태만 WARNING으로 조정
  if (uniqueDates.size === 1 && ops.length >= 2) {
    if (data.overall_status === "NORMAL") data.overall_status = "WARNING";
  }
}

// ── 날짜 유효성 검사 (존재하지 않는 날짜 감지) ───────────────
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
    // 날짜 정규화 (zero-padding): "2026-2-2" → "2026-02-02"
    const normalized = d.toISOString().slice(0, 10);
    // 날짜가 밀렸는지 확인 (예: 2026-02-29 → 3월 1일로 밀림)
    const parts = op.date.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (parts) {
      const [, y, m, day] = parts;
      if (d.getFullYear() !== +y || d.getMonth() + 1 !== +m || d.getDate() !== +day) {
        invalid.push(op.date);
        op.date = null;
        continue;
      }
    }
    // 정규화된 날짜로 교체 (차트 등에서 일관된 형식 사용)
    op.date = normalized;
  }
  if (invalid.length > 0) {
    console.warn("[validateOperationDates] 유효하지 않은 날짜 감지:", invalid.join(", "));
  }
}

// ── 운전 0회 처리 ─────────────────────────────────────────────
function checkZeroOperations(data) {
  const ops    = data.operations || [];
  const alarms = data.error_alarms || [];
  if (ops.length > 0) return;

  // 운전 없으면 ai_remarks를 단순하게 교체
  // (TRO 분석, [종합] 등 AI 생성 내용 불필요 — 힐링/자동조작 등 운전 없는 달은 알람만 확인)
  const opsNote   = "[운전 현황] 당월 운전 기록이 없습니다.";
  const opsNoteEn = "[Operations] No ballasting/deballasting operations recorded this month.";

  if (alarms.length > 0) {
    // 알람이 있으면: 운전 현황 + 알람 내용 (AI 생성 remarks에서 알람 관련 줄만 유지)
    // TRO 미수신 등 운전 부재 시 무의미한 라인은 명시적으로 제외
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
    // 운전도 없고 알람도 없는 경우: 2줄만
    data.ai_remarks    = [opsNote, "[알람없음] 이상 알람 없음."];
    data.ai_remarks_en = [opsNoteEn, "[No Alarms] No abnormal alarms detected."];
  }
}

// ── 알람 코드별 권고 조치 룩업 (상세 원인 + 조치) ───────────────
const ALARM_ACTION_KO = {
  CODE100:      "ECU 비상정지(EMCY) — 전극 과열/과압/전류 이상 가능성. ECU 내부 점검 및 PRU(정류기) 상태 확인. 반복 시 제조사 정밀 진단 필요",
  CODE200:      "TRO 저농도(Low) — CLX 시약 유효기간 만료 또는 TSU Bypass Line 막힘 가능성. CLX 시약 교체 여부 및 샘플링 라인 소통 상태 점검",
  CODE201:      "TRO 고농도(High) — 중화제(STS) 주입량 부족 가능성. STS 주입 펌프 작동 상태 및 탱크 잔량 확인. ANU 밸브 개폐 점검",
  CODE301:      "중화제 탱크 초기 레벨 이상 — 레벨 센서 영점 교정 필요. 센서 배선 및 탱크 내부 플로트 상태 확인",
  CODE302:      "중화제 탱크 저수위 — 중화제 보충 필요. 레벨 센서 정상 작동 여부 및 공급 라인 밸브 개폐 확인",
  CODE303:      "중화제 탱크 고수위 — 오버플로우 방지 밸브 작동 확인. 레벨 센서 고착 여부 및 배출 라인 점검",
  CODE402:      "440V MC(전자접촉기) 투입 실패 — 전원 공급 상태 및 MC 코일/접점 점검. 전원 차단기(MCCB) 트립 여부 확인",
  CODE405:      "ECU 전류 과부하 — 전극 표면 스케일 부착 또는 해수 염분도 급변 가능성. 전극 세정(CIP) 실시 및 CSU 센서값 확인",
  CODE406:      "ECU 입력 전압 저하 — 선내 배전반 전압 확인. 발전기 부하 상태 및 전압 조정기(AVR) 점검",
  CODE407:      "ECU 입력 전압 과다 — 선내 배전반 전압 확인. 발전기 AVR 설정값 점검",
  CODE600:      "해수 온도 저온 이상 — 저온 해역 운항 시 정상 발생 가능. 히터 작동 여부 확인. 지속 시 운전 모드 조정",
  CODE603:      "냉각수 온도 과열 — 냉각수 펌프 작동 및 냉각수 라인 밸브 개폐 확인. 열교환기 오염 여부 점검",
  CODE605:      "FMU 유량 과다(>110%) — 단속 운전 유발 가능. 유량 조절 밸브 개도 확인 및 FMU 센서 교정 점검",
  CODE606:      "FMU 유량 부족(<15%) — 해수 공급 펌프 작동 확인. 스트레이너 막힘 및 흡입 밸브 개폐 점검",
  CODE701:      "PLC 통신 장애 — RTU/AIM 모듈 간 통신 케이블 연결 상태 확인. 커넥터 접촉 불량 및 모듈 LED 상태 점검",
  CODE703:      "센서 통신 에러 — 해당 센서 배선 및 커넥터 점검. 센서 모듈 교체 필요 여부 확인",
  CODE704:      "Bypass 밸브 이상 — 밸브 리미트 스위치 위치 및 공압 라인 점검. 수동 개폐 테스트 실시",
  CODE706:      "비상 운전(EM'CY Mode) 진입 — 자동 운전 불가 상태. 원인 알람 확인 후 리셋 및 정상 모드 복귀",
  CODE721:      "밸브 작동 이상 — 해당 밸브 공압 실린더 및 리미트 스위치 점검. 솔레노이드 밸브 작동 확인",
  CODE727:      "[긴급] 미처리수 배출 감지 — IMO 규정 위반 가능성. 즉시 운전 중지 후 밸브 라인업 및 TRO 센서 확인",
  CODE731:      "밸브 비정상 종료 — 밸브 작동 중 ECS 비정상 종료 발생. 밸브 현재 위치 확인 후 수동 리셋",
  CODE774:      "냉각수 밸브(F.W Inlet) 이상 — 냉각수 공급 밸브 리미트 스위치 및 공압 점검. 냉각수 라인 에어 벤트 확인",
  VRCS_ERR:     "[긴급] 밸브 채터링(반복 개폐) 감지 — 공압 라인 누기, 리미트 스위치 고장, 솔레노이드 밸브 이상 가능성. 즉각 점검 필요",
  LOG_OVERFLOW: "Event Log 100건 초과 — 반복 알람 원인 분석 및 전체 로그 상세 검토 필요",
};
const ALARM_ACTION_EN = {
  CODE100:      "ECU Emergency Stop — possible electrode overheating/overpressure. Inspect ECU internals and PRU(rectifier) status. Contact manufacturer if recurring",
  CODE200:      "TRO Low — possible CLX reagent expiry or TSU bypass line blockage. Check CLX replacement date and sampling line flow",
  CODE201:      "TRO High — possible insufficient STS neutralizer dosing. Check STS pump operation and tank level. Inspect ANU valve",
  CODE301:      "Neutralizer tank initial level error — recalibrate level sensor zero point. Check sensor wiring and float condition",
  CODE302:      "Neutralizer tank low level — replenish neutralizer. Check level sensor and supply line valves",
  CODE303:      "Neutralizer tank high level — check overflow prevention valve. Inspect level sensor and drain line",
  CODE402:      "440V MC engagement failure — check power supply and MC coil/contacts. Verify MCCB trip status",
  CODE405:      "ECU overcurrent — possible electrode scaling or sudden salinity change. Perform CIP cleaning and check CSU sensor",
  CODE406:      "ECU input voltage low — check switchboard voltage and generator AVR settings",
  CODE407:      "ECU input voltage high — check switchboard voltage and generator AVR settings",
  CODE600:      "Seawater temperature low — may be normal in cold water areas. Check heater operation",
  CODE603:      "Cooling water temperature high — check cooling pump and heat exchanger fouling",
  CODE605:      "FMU flow rate high (>110%) — may cause intermittent operation. Check flow control valve and FMU calibration",
  CODE606:      "FMU flow rate low (<15%) — check seawater pump, strainer blockage, and suction valve",
  CODE701:      "PLC communication failure — check RTU/AIM module cables and connectors. Inspect module LED status",
  CODE703:      "Sensor communication error — check sensor wiring and connectors. Assess module replacement need",
  CODE704:      "Bypass valve error — check valve limit switch and pneumatic line. Perform manual open/close test",
  CODE706:      "Emergency mode entered — auto operation unavailable. Check root cause alarm, reset and return to normal mode",
  CODE721:      "Valve operation error — check pneumatic cylinder and limit switch. Verify solenoid valve operation",
  CODE727:      "[URGENT] Untreated water discharge detected — possible IMO violation. Stop operation immediately and check valve lineup and TRO sensor",
  CODE731:      "Valve abnormal termination — ECS shut down during valve operation. Verify valve position and manual reset",
  CODE774:      "Cooling water inlet valve error — check F.W valve limit switch and pneumatic line. Vent air from cooling line",
  VRCS_ERR:     "[URGENT] Valve chattering detected — possible pneumatic leak, limit switch failure, or solenoid valve malfunction. Immediate inspection required",
  LOG_OVERFLOW: "Event Log exceeded 100 entries — analyze repeated alarm root cause and perform detailed log review",
};

// ── ai_remarks 종합 리포트 생성 (Stage 2 AI 대체) ────────────
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

  // 처리량/운전시간 집계 포함
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

    // ECU-TRO 상관관계 분석
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
    // 처리 효율 판정 포함
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

  // ─ 알람 코드별 (상세 원인/조치) ────────────────────────────
  if (alarms.length === 0) {
    koLines.push("[알람없음] 이상 알람 없음.");
    enLines.push("[No Alarms] No abnormal alarms detected.");
  } else {
    const codeMap = new Map();
    for (const a of alarms) {
      const code = a.code || "(코드없음)";
      if (!codeMap.has(code)) codeMap.set(code, { trips: 0, total: 0 });
      const g = codeMap.get(code);
      const cnt = a.count || 1;
      if ((a.level || "").toLowerCase() === "trip") g.trips += cnt;
      g.total += cnt;
    }
    for (const [code, g] of codeMap) {
      const nonTrips = g.total - g.trips;
      const parts = [g.trips && `Trip×${g.trips}`, nonTrips && `Alarm×${nonTrips}`].filter(Boolean).join("+");
      const countStr = parts ? `${parts} — ` : "";
      koLines.push(`[${code}] ${countStr}${ALARM_ACTION_KO[code] || "점검 필요 — 상세 원인 확인 후 제조사 기술지원 요청"}.`);
      enLines.push(`[${code}] ${countStr}${ALARM_ACTION_EN[code] || "Inspection required — identify root cause and contact manufacturer for technical support"}.`);
    }

    // 반복 알람 경고 (5회 이상)
    const repeated = evAnalysis.repeated_alarms || [];
    if (repeated.length > 0) {
      const repCodes = repeated.map(r => `${r.code}(${r.total}회)`).join(', ');
      koLines.push(`[반복 알람] ${repCodes} — 동일 알람 반복 발생. 근본 원인 분석(RCA) 필요.`);
      enLines.push(`[Repeated Alarms] ${repeated.map(r => `${r.code}(${r.total}x)`).join(', ')} — Root cause analysis required.`);
    }
  }

  // ─ [운전 이상] (OpTime 이상 탐지 결과) ─────────────────────
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


// ── TRO 비정상값 sanity check (잘못된 단위/추출 오류 방어) ───
function sanitizeTroValues(data) {
  const tro = data.tro_data;
  if (!tro) return;
  // 100ppm 초과는 센서오류/단위오류로 간주 → null 처리
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
  // 배출 TRO > 1.0ppm — 비정상적 높음 (정상 <0.1ppm). 센서 교차오염 또는 파싱 오류 가능성 경고
  if (tro.deballasting_max != null && tro.deballasting_max > 1.0) {
    tro._deballasting_warning = `배출 TRO ${tro.deballasting_max}ppm — IMO 기준(0.1ppm) 대폭 초과. TRO 센서 교차오염, Ballast/Deballast 컬럼 혼동, 또는 중화 불량 가능성`;
  }
}

// ── Event Log 페이지 과부하 감지 (TOTAL LOG 전용) ──────────────
// sections.op_time_start - sections.event_log_start > 100 → CRITICAL
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

// ── 응답 후처리: 필수 필드 검증 및 정규화 ───────────────────
function validateAndNormalizeResult(data, sections = null) {
  if (!data || typeof data !== "object") return {};
  // overall_status: 허용값 외에는 null (mapOverallStatus에서 재추론)
  const s = (data.overall_status || "").toUpperCase();
  if (!["NORMAL", "WARNING", "CRITICAL"].includes(s)) data.overall_status = null;
  // 배열 보장
  if (!Array.isArray(data.error_alarms)) data.error_alarms = [];
  if (!Array.isArray(data.operations))   data.operations  = [];
  // ai_remarks / ai_remarks_en — 항상 배열로 보장 (구버전 문자열도 래핑)
  if (!Array.isArray(data.ai_remarks))
    data.ai_remarks    = data.ai_remarks    ? [String(data.ai_remarks)]    : [];
  if (!Array.isArray(data.ai_remarks_en))
    data.ai_remarks_en = data.ai_remarks_en ? [String(data.ai_remarks_en)] : [];
  // 0. Event Log 페이지 과부하 감지 (TOTAL LOG 전용)
  checkEventLogPages(data, sections);
  // 1. 날짜 유효성 검사 (존재하지 않는 날짜 → null + 경고)
  validateOperationDates(data);
  // 0-1. TRO 비정상값 sanity check (100ppm 초과 → null)
  sanitizeTroValues(data);
  // 1. 알람 레벨 정규화 (Trip/Alarm/Warning 통일)
  data.error_alarms = normalizeAlarmLevels(data.error_alarms);
  // 2. 반복 알람 그룹화 (×N회)
  data.error_alarms = groupRepeatAlarms(data.error_alarms);
  // 3. 밸브 과다 경고 추가
  appendValveWarning(data);
  // 4. TRO 범위 체크 → ai_remarks 보완
  checkTroRange(data);
  // 5. overall_status JS 완전 재계산 (Gemini 판정 대체)
  recalcOverallStatus(data);
  // 6. 운전 날짜 편중 감지 (특정 날짜만 → 누락 경고)
  checkOperationCoverage(data);
  // 7. 운전 0회인데 TRO/알람이 있는 경우 경고
  checkZeroOperations(data);
  // 8. ai_remarks 비어있으면 기본 요약 자동 생성
  autoFillRemarks(data);
  return data;
}

// ── 타임아웃 fetch 래퍼 ──────────────────────────────────────
function fetchWithTimeout(url, options, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

// ── Gemini 호출 (raw, 후처리 없음) ───────────────────────────
async function callGeminiRaw(parts, retries = 3, schema = null) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const generationConfig = {
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens: 65536,
      };
      if (schema) generationConfig.responseSchema = schema;

      const res = await fetchWithTimeout(
        `${GEMINI_ENDPOINT}?key=${CONFIG.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig,
          }),
        },
        300_000 // 5분 타임아웃
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          `Gemini API error ${res.status}: ${err?.error?.message || res.statusText}`
        );
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini 응답에 텍스트가 없습니다.");

      return robustJsonParse(text);
    } catch (err) {
      // 페이지/토큰 초과만 재시도 불필요 (타임아웃·500·파싱오류는 재시도)
      const noRetry = err.message.includes("exceeds");
      if (attempt === retries || noRetry) throw err;
      const isTimeout = err.name === "AbortError" || err.message.includes("aborted");
      const is500 = err.message.includes("500");
      const delay = isTimeout ? 5000 : is500 ? 3000 * attempt : 1500 * attempt;
      console.warn(`Gemini 시도 ${attempt} 실패, ${delay/1000}초 후 재시도...`, err.message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ── Gemini 호출 + 후처리 정규화 ─────────────────────────────
async function callGemini(parts, retries = 3) {
  const raw = await callGeminiRaw(parts, retries);
  return validateAndNormalizeResult(raw);
}

/**
 * Google Drive PDF → Gemini Files API 업로드 후 분析
 * - 2단계 파이프라인:
 *   Stage 1 — PDF 첨부, 데이터 추출 전용 (해석/판단 없음)
 *   Stage 2 — JSON 입력, 분析/판정/remarks 생성 (PDF 없음)
 * - 세션 캐시: 같은 파일은 재업로드 없이 URI 재사용 (47시간)
 */

// ── Gemini Files API 세션 캐시 ───────────────────────────────
const _fileUriCache = new Map();
const FILES_EXPIRE_MS = 47 * 60 * 60 * 1000;

async function uploadToGeminiFiles(blob, fileName) {
  const initRes = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${CONFIG.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(blob.size),
        "X-Goog-Upload-Header-Content-Type": "application/pdf",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { displayName: fileName } }),
    },
    60_000
  );
  if (!initRes.ok) throw new Error(`Files API 초기화 실패: ${initRes.status}`);
  const uploadUrl = initRes.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) throw new Error("Files API 업로드 URL 없음");

  const uploadRes = await fetchWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command": "upload, finalize",
        "X-Goog-Upload-Offset": "0",
        "Content-Type": "application/pdf",
      },
      body: blob,
    },
    180_000
  );
  if (!uploadRes.ok) throw new Error(`Files API 업로드 실패: ${uploadRes.status}`);
  const fileData = await uploadRes.json();
  return fileData?.file?.uri;
}

// ── TOTAL LOG 전용: pdf.js 텍스트 추출 ───────────────────────
const TOTAL_LOG_THRESHOLD   = 30;    // 이 페이지 초과 → pdfjs 텍스트 추출 경로 (Gemini PDF 직독 대신)
const TOTAL_LOG_EVENT_PAGES = 100;   // Event Log 샘플 페이지 수 (VRCS 감지용)

// pdf.js 단일 페이지 텍스트 추출
async function extractPageText(pdfDoc, pageNum) {
  try {
    const page    = await pdfDoc.getPage(pageNum); // 1-based
    const content = await page.getTextContent();
    return content.items.map((it) => it.str).join(" ");
  } catch { return ""; }
}

// pdf.js 연속 페이지 텍스트 추출 (최대 maxPages)
async function extractPagesText(pdfDoc, startPage, endPage, maxPages = 500) {
  const parts = [];
  const end   = Math.min(endPage, startPage + maxPages - 1);
  for (let p = startPage; p <= end; p++) {
    const text = await extractPageText(pdfDoc, p);
    if (text.trim()) parts.push(`[p.${p}] ${text}`);
  }
  return parts.join("\n");
}

// Report List 텍스트에서 섹션 시작 페이지 파싱 (순수 정규식)
function parseReportList(text) {
  const find = (regex) => { const m = text.match(regex); return m ? parseInt(m[1]) : null; };
  return {
    event_log_start: find(/(?:Event\s*Log)[^\d\n]*?(\d{1,5})/i),
    op_time_start:   find(/(?:Operation\s*Time\s*Log|Op(?:eration)?\s*Time)[^\d\n]*?(\d{1,5})/i),
    data_log_start:  find(/(?:Data\s*Log)[^\d\n]*?(\d{1,5})/i),
    total_pages:     find(/(?:^|[\s\-–])Total[\s\-–]*?(\d{2,5})/im),
  };
}

// TOTAL LOG 텍스트 추출 메인 함수
async function extractTotalLogText(blob) {
  const pdfjsLib = await import("pdfjs-dist");
  // npm 패키지 내 worker 사용 (CDN 의존 제거 — Vite가 빌드 시 assets에 복사)
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).href;

  const pdfDoc = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  const total  = pdfDoc.numPages;

  // Step 1: 앞 5페이지로 Report List 파싱
  let headerText = "";
  for (let p = 1; p <= Math.min(5, total); p++) {
    headerText += (await extractPageText(pdfDoc, p)) + "\n";
  }
  const sections = parseReportList(headerText);

  // ── Total Report 감지 ─────────────────────────────────────
  // Total Report(통합 PDF)는 첫 페이지가 Report List 인덱스 페이지.
  // ECS 시스템이 자기 페이지를 번호에 포함하지 않아 section 번호가 +1 오프셋 발생.
  const isTotalReport = /Report\s+List/i.test(headerText) &&
      sections.event_log_start != null &&
      sections.op_time_start   != null;
  if (isTotalReport) {
    console.log('[pdf.js] Total Report 감지 — section 페이지 +1 offset 적용');
    if (sections.event_log_start != null) sections.event_log_start += 1;
    if (sections.op_time_start   != null) sections.op_time_start   += 1;
    if (sections.data_log_start  != null) sections.data_log_start  += 1;
  }
  // ── Report List 없을 때: 마지막 60p 스캔으로 섹션 자동 탐지 ──
  if (!sections.op_time_start) {
    const { isOpTimeLogHeader, isDataLogHeader, extractPageRowsExport } = await import('./logParser.js');
    const scanStart = Math.max(1, total - 59);
    console.log(`[pdf.js] Report List 미감지 — 자동 섹션 탐지: p.${scanStart}~${total}`);
    for (let p = scanStart; p <= total; p++) {
      const rows = await extractPageRowsExport(pdfDoc, p);
      if (!sections.op_time_start && rows.some(isOpTimeLogHeader)) {
        sections.op_time_start = p;
        console.log(`[pdf.js] Op Time Log 자동 감지: p.${p}`);
      }
      if (sections.op_time_start && !sections.data_log_start && rows.some(isDataLogHeader)) {
        sections.data_log_start = p;
        console.log(`[pdf.js] Data Log 자동 감지: p.${p}`);
      }
    }
    if (sections.op_time_start && !sections.event_log_start) {
      sections.event_log_start = 1;  // Event Log = PDF 처음부터
    }
  }
  // ──────────────────────────────────────────────────────────
  console.log("[pdf.js] 섹션 파싱 결과:", sections, `/ 전체 ${total}p`);

  const textParts = [`=== 기본 정보 (p.1~5) ===\n${headerText}`];

  if (sections.op_time_start) {
    // ★ 정밀 모드: Report List 기반으로 정확한 페이지 추출
    const opEnd   = sections.data_log_start ? sections.data_log_start - 1 : sections.op_time_start + 30;
    // total_pages가 "Total 섹션 시작 페이지"인 경우 실제 마지막 페이지는 total (PDF 전체 페이지)
    const dataEnd = total;

    console.log(`[pdf.js] Op Time 추출: p.${sections.op_time_start}~${opEnd}`);
    const opText = await extractPagesText(pdfDoc, sections.op_time_start, opEnd);
    textParts.push(`\n=== ECS Operation Time Log (p.${sections.op_time_start}~${opEnd}) ===\n${opText}`);

    if (sections.data_log_start) {
      // Data Log가 길면 앞 15p + 뒤 5p 분리 추출
      // → BALLAST 구간(주로 중간)과 DEBALLAST 구간(앞/뒤) 모두 포함 보장
      const DATA_LOG_FIRST = 15;
      const DATA_LOG_LAST  = 5;
      const DATA_LOG_MAX   = DATA_LOG_FIRST + DATA_LOG_LAST;
      const dataTotal = dataEnd - sections.data_log_start + 1;

      let dataText;
      if (dataTotal <= DATA_LOG_MAX) {
        // 짧으면 전체 추출
        dataText = await extractPagesText(pdfDoc, sections.data_log_start, dataEnd);
        console.log(`[pdf.js] Data Log 전체 추출: p.${sections.data_log_start}~${dataEnd} (${dataTotal}p)`);
      } else {
        // 앞 15p + 뒤 5p 분리
        const firstEnd  = sections.data_log_start + DATA_LOG_FIRST - 1;
        const lastStart = dataEnd - DATA_LOG_LAST + 1;
        const firstText = await extractPagesText(pdfDoc, sections.data_log_start, firstEnd);
        const lastText  = await extractPagesText(pdfDoc, lastStart, dataEnd);
        const skipped   = lastStart - firstEnd - 1;
        dataText = firstText + `\n[... 중간 ${skipped}p 생략 (BALLAST/DEBALLAST 혼재 구간) ...]\n` + lastText;
        console.log(`[pdf.js] Data Log 분리 추출: p.${sections.data_log_start}~${firstEnd} + p.${lastStart}~${dataEnd} (중간 ${skipped}p 생략)`);
      }
      textParts.push(`\n=== ECS Data Log (p.${sections.data_log_start}~${dataEnd}, 총 ${dataTotal}p 중 최대 ${DATA_LOG_MAX}p 추출) ===\n${dataText}`);
    }

    // Event Log: Op Time 직전 100페이지 샘플 (VRCS 감지용)
    const evEnd   = sections.op_time_start - 1;
    const evStart = Math.max(2, evEnd - TOTAL_LOG_EVENT_PAGES + 1);
    console.log(`[pdf.js] Event Log 샘플: p.${evStart}~${evEnd}`);
    const evText  = await extractPagesText(pdfDoc, evStart, evEnd);
    textParts.push(`\n=== Operation Event Log 샘플 (p.${evStart}~${evEnd}) ===\n${evText}`);

  } else {
    // Fallback: 뒤 50페이지 (Op Time + Data Log 위치 추정)
    const critStart = Math.max(6, total - 49);
    console.log(`[pdf.js] Fallback (뒤 50p): p.${critStart}~${total}`);
    const critText  = await extractPagesText(pdfDoc, critStart, total);
    textParts.push(`\n=== Op Time + Data Log 추정 (p.${critStart}~${total}) ===\n${critText}`);

    const evEnd   = critStart - 1;
    const evStart = Math.max(2, evEnd - TOTAL_LOG_EVENT_PAGES + 1);
    const evText  = await extractPagesText(pdfDoc, evStart, evEnd);
    textParts.push(`\n=== Operation Event Log 샘플 (p.${evStart}~${evEnd}) ===\n${evText}`);
  }

  // Stage 0: 프로그래밍 파싱 (AI보다 정확, 실패 시 무시)
  let stage0 = null;
  try {
    const { parseEcsLogStructured } = await import('./logParser.js');
    stage0 = await parseEcsLogStructured(pdfDoc, sections, total);
    console.log('[Stage0]',
      `ops=${stage0?.operations?.length ?? 'null'}`,
      `B-TRO=${stage0?.tro_data?.ballasting_avg ?? 'null'}`,
      `D-TRO=${stage0?.tro_data?.deballasting_max ?? 'null'}`
    );
  } catch (e) {
    console.warn('[Stage0] 실패 (무시):', e.message);
  }

  await pdfDoc.destroy();
  return { text: textParts.join("\n"), totalPages: total, sections, stage0, isTotalReport, headerText: headerText.slice(0, 800) };
}

// ── 대용량 PDF 분할 (pdf-lib 동적 import) ────────────────────
const LARGE_PDF_THRESHOLD      = 500;  // 이 페이지 수 초과 시 분할
const LARGE_PDF_START_PAGES    = 5;    // 기본정보용 앞 페이지 수 (Report List 포함)
const LARGE_PDF_CRITICAL_PAGES = 50;   // fallback: Op Time + Data Log용 뒤에서 가져올 페이지 수
const LARGE_PDF_END_PAGES      = 280;  // fallback: Event Log 샘플용 전체 범위
const LARGE_PDF_EVENT_PAGES    = 200;  // 최근 Event Log 최대 페이지 수 (VRCS 감지용)

// ── TOTAL LOG 섹션 탐색 (첫 3페이지만 업로드 → Report List 파싱) ─

async function discoverTotalLogSections(blob) {
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true });
  const total  = srcDoc.getPageCount();
  if (total <= LARGE_PDF_THRESHOLD) return null;

  // 첫 5페이지 추출 (Report List가 2~3페이지에 있는 경우 대비)
  const miniDoc = await PDFDocument.create();
  const pages   = await miniDoc.copyPagesFrom(srcDoc, [0, 1, 2, 3, 4].filter((i) => i < total));
  pages.forEach((p) => miniDoc.addPage(p));
  const miniBlob = new Blob([await miniDoc.save()], { type: "application/pdf" });

  // Files API 업로드
  const uri = await uploadToGeminiFiles(miniBlob, "bwts_discovery.pdf");
  if (!uri) {
    console.warn("[Section Discovery] 미니 PDF 업로드 실패");
    return null;
  }

  const body = JSON.stringify({
    contents: [{ role: "user", parts: [
      { fileData: { mimeType: "application/pdf", fileUri: uri } },
      { text: SECTION_DISCOVERY_PROMPT },
    ]}],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          event_log_start: { type: "integer", nullable: true },
          op_time_start:   { type: "integer", nullable: true },
          data_log_start:  { type: "integer", nullable: true },
          total_pages:     { type: "integer", nullable: true },
        },
      },
    },
  });

  // 최대 2회 시도
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(
        `${GEMINI_ENDPOINT}?key=${CONFIG.GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
        60_000
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.warn(`[Section Discovery] 시도 ${attempt} HTTP ${res.status}:`, errText.slice(0, 200));
        continue;
      }
      const json   = await res.json();
      const text   = json?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const result = JSON.parse(text);
      console.log(`[Section Discovery] 시도 ${attempt} 성공:`, result);
      if (result?.op_time_start) return result;
      console.warn("[Section Discovery] op_time_start 없음 — Report List 미인식");
      return null;
    } catch (e) {
      console.warn(`[Section Discovery] 시도 ${attempt} 예외:`, e.message);
    }
  }
  return null;
}

// 0-based 페이지 인덱스 배열 생성 헬퍼
function pageRange(start, end) {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

async function splitLargePdf(blob, sections = null) {
  const { PDFDocument } = await import("pdf-lib");
  const arrayBuffer = await blob.arrayBuffer();
  const srcDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  const total = srcDoc.getPageCount();

  if (total <= LARGE_PDF_THRESHOLD) return { blob, totalPages: total, wasSplit: false };

  let secA, secB, secC, mode;

  if (sections?.op_time_start) {
    // ★ 정밀 분할: Report List 기반
    const opIdx = sections.op_time_start - 1;  // 1-based → 0-based
    secA = pageRange(0, LARGE_PDF_START_PAGES); // 기본정보
    secB = pageRange(opIdx, total);             // Op Time Log + Data Log 전체
    const evEnd   = opIdx;
    const evStart = Math.max(LARGE_PDF_START_PAGES, evEnd - LARGE_PDF_EVENT_PAGES);
    secC = pageRange(evStart, evEnd);           // 최근 Event Log (VRCS 감지용)
    mode = "정밀";
  } else {
    // fallback: 섹션 탐색 실패 시
    // secB = 뒤 50p (Op Time + Data Log 확보 — 항상 PDF 맨 끝에 위치)
    // secC = 뒤 50p 이전 구간에서 최대 230p (Event Log 샘플 — VRCS 감지용)
    const critStart = Math.max(LARGE_PDF_START_PAGES, total - LARGE_PDF_CRITICAL_PAGES);
    const evEnd     = critStart;
    const evStart   = Math.max(LARGE_PDF_START_PAGES, evEnd - (LARGE_PDF_END_PAGES - LARGE_PDF_CRITICAL_PAGES));
    secA = pageRange(0, LARGE_PDF_START_PAGES);
    secB = pageRange(critStart, total);        // Op Time + Data Log (맨 끝 50p)
    secC = pageRange(evStart, evEnd);          // Event Log 샘플
    mode = "fallback";
  }

  // 순서: 기본정보 → Op Time+Data Log(★) → Event Log 샘플
  // Op Time+Data Log를 Event Log보다 앞에 배치 → Gemini가 먼저 읽도록 강제
  const pageOrder = [...secA, ...secB, ...secC];
  const newDoc = await PDFDocument.create();
  const copied = await newDoc.copyPagesFrom(srcDoc, pageOrder);
  copied.forEach((p) => newDoc.addPage(p));
  const bytes = await newDoc.save();

  console.log(`[PDF Split][${mode}] ${total}p → 기본:${secA.length}p + OpTime+Data:${secB.length}p + EventLog:${secC.length}p = ${pageOrder.length}p`);
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    totalPages: total,
    extractedPages: pageOrder.length,
    wasSplit: true,
    splitSections: { basic: secA.length, critical: secB.length, eventLog: secC.length },
  };
}

// Drive 파일 다운로드 (blob 반환)
async function downloadDriveFile(fileId, accessToken) {
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    180_000
  );
  if (!res.ok) throw new Error(`Drive 다운로드 실패 (${fileId}): ${res.status}`);
  return res.blob();
}

async function getOrUploadFileUri(fileId, accessToken, preloadedBlob = null) {
  const cached = _fileUriCache.get(fileId);
  if (cached && Date.now() - cached.uploadedAt < FILES_EXPIRE_MS) {
    console.log(`[Files API] 캐시 재사용: ${fileId}`);
    return cached.uri;
  }

  const blob = preloadedBlob ?? await downloadDriveFile(fileId, accessToken);

  // 대용량 PDF 분할 시도 (섹션 탐색 → 정밀 분할 or fallback)
  let uploadBlob = blob;
  let splitMeta = { wasSplit: false, totalPages: 0 };
  try {
    const sections = await discoverTotalLogSections(blob).catch((e) => {
      console.warn("[Section Discovery] 예외 발생:", e.message);
      return null;
    });
    if (sections) {
      console.log("[PDF Split] 정밀 분할 — Op Time 시작:", sections.op_time_start, "/ Data Log 시작:", sections.data_log_start);
    } else {
      console.warn("[PDF Split] 섹션 탐색 실패 → fallback 분할 (뒤 50p=OpTime+Data, 앞에 배치)");
    }
    splitMeta = await splitLargePdf(blob, sections);
    if (splitMeta.wasSplit) uploadBlob = splitMeta.blob;
  } catch (e) {
    console.warn("[PDF Split] 실패, 원본 사용:", e.message);
  }

  const sizeMB = (uploadBlob.size / 1024 / 1024).toFixed(1);
  const label  = splitMeta.wasSplit
    ? `분할본 ${splitMeta.extractedPages}p / 원본 ${splitMeta.totalPages}p`
    : "원본";
  console.log(`[Files API] 업로드: ${fileId} (${sizeMB} MB, ${label})`);

  const uri = await uploadToGeminiFiles(uploadBlob, `bwts_${fileId}.pdf`);
  if (!uri) throw new Error(`Files API URI 없음 (${fileId})`);

  _fileUriCache.set(fileId, { uri, uploadedAt: Date.now(), ...splitMeta });
  return uri;
}

// ── ECS 파일 종류 감지 (파일명 기반) ────────────────────────
// ECS 시스템이 생성하는 표준 파일명 패턴:
//   DataReport / DataLog   → TRO 수치 전용
//   EventLog / EventReport → 이벤트 로그 전용
//   OperationTime / OpTime → 운전 기록 전용
//   Report (수식어 없음)   → 합본 (Total)
function detectEcsFileType(filename) {
  const n = (filename || "").toUpperCase();
  if (/DATA.?(LOG|REPORT)/i.test(n)) return "data";
  if (/EVENT.?(LOG|REPORT)/i.test(n)) return "event";
  if (/OPERATION.?TIME|OPTIME|OP.?TIME/i.test(n)) return "optime";
  if (/TOTAL/i.test(n)) return "total";
  if (/REPORT/i.test(n)) return "total";  // 수식어 없는 Report = Total
  return "unknown";
}

export async function analyzePdfFromDrive(files, accessToken, vessel = {}) {
  const normalizedFiles = Array.isArray(files)
    ? files.map(f => typeof f === "string" ? { id: f, name: "" } : f)
    : [typeof files === "string" ? { id: files, name: "" } : files];

  // ★ CSV 파일 감지 → PDF 파이프라인 완전 건너뜀
  const csvFiles = normalizedFiles.filter(f => (f.name || '').toUpperCase().endsWith('.CSV'));
  if (csvFiles.length > 0) {
    console.log('[CSV] CSV 파일 감지 — PDF 파이프라인 건너뜀:', csvFiles.map(f => f.name).join(', '));
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

  // 파일 종류 분류
  const filesByType = { total: [], data: [], event: [], optime: [], unknown: [] };
  for (const f of normalizedFiles) {
    filesByType[detectEcsFileType(f.name)].push(f);
  }
  console.log('[Files] 종류별 분류:', Object.entries(filesByType).filter(([,v])=>v.length).map(([k,v])=>`${k}:${v.length}`).join(', '));

  // 처리 순서: OpTime(소) → DataReport(중) → EventLog/Total(대, AI 메인)
  const optFiles   = filesByType.optime;
  const dataFiles  = filesByType.data;
  // AI 메인: Total 우선, 없으면 EventLog, 없으면 unknown
  const mainFiles  = filesByType.total.length ? filesByType.total
                   : filesByType.event.length ? filesByType.event
                   : filesByType.unknown;
  // ── 모든 파일 사전 다운로드 ──────────────────────────────────
  const preloadedBlobs = new Map();
  for (const f of normalizedFiles) {
    if (_fileUriCache.get(f.id) && Date.now() - _fileUriCache.get(f.id).uploadedAt < FILES_EXPIRE_MS) continue;
    preloadedBlobs.set(f.id, await downloadDriveFile(f.id, accessToken));
  }

  // pdfjs 초기화 (한 번만)
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url
  ).href;
  const { extractPageRowsExport, parseOpTimeLog, parseDataLog } = await import('./logParser.js');

  async function parsePdfAllRows(blob) {
    const pdfDoc = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    const rows = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) rows.push(...await extractPageRowsExport(pdfDoc, p));
    await pdfDoc.destroy();
    return rows;
  }

  // ① Operation Time → Stage 0 운전 기록
  let optimeOps = null;
  for (const f of optFiles) {
    try {
      const rows = await parsePdfAllRows(preloadedBlobs.get(f.id));
      const ops  = parseOpTimeLog(rows);
      if (ops?.length) { optimeOps = ops; console.log('[OpTime] ops:', ops.length, '건'); break; }
    } catch (e) { console.warn('[OpTime] 실패:', e.message); }
  }

  // ② Data Report → Stage 0 TRO
  let dataReportTro = null;
  for (const f of dataFiles) {
    try {
      const rows = await parsePdfAllRows(preloadedBlobs.get(f.id));
      const tro  = parseDataLog(rows);
      if (tro) { dataReportTro = tro; console.log('[DataReport] TRO:', JSON.stringify(tro)); break; }
    } catch (e) { console.warn('[DataReport] 실패:', e.message); }
  }

  // ③ Total / EventLog → extractTotalLogText (pdf.js 텍스트 추출 — 페이지 수 무관)
  let totalLogExtraction = null;
  let totalLogFileId     = null;
  let totalLogError      = null;
  let mainFilePages      = null;
  for (const f of mainFiles) {
    const blob = preloadedBlobs.get(f.id);
    if (!blob) continue;
    const { PDFDocument } = await import("pdf-lib");
    mainFilePages = (await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true })).getPageCount();
    console.log(`[TOTAL LOG] ${f.name || f.id}: ${mainFilePages}p → pdf.js 추출`);
    try {
      totalLogExtraction = await extractTotalLogText(blob);
      totalLogFileId     = f.id;
      break;
    } catch (e) {
      totalLogError = e?.message || e?.name || String(e) || "알 수 없는 오류";
      console.warn("[TOTAL LOG] pdf.js 실패:", totalLogError, e);
    }
  }

  // pdf.js 실패 또는 텍스트 너무 짧으면 Stage 0 데이터만으로 결과 구성 (AI 직독 없음)
  if (!totalLogExtraction || (totalLogExtraction.text?.length ?? 0) < 200) {
    const reason = mainFiles.length === 0
      ? "Total Log 파일 없음"
      : totalLogError
        ? `pdf.js 추출 실패 (${mainFilePages ?? "?"}p): ${totalLogError}`
        : `pdf.js 텍스트 너무 짧음 (${mainFilePages ?? "?"}p)`;
    console.warn(`[Stage 1] 텍스트 추출 불가 — ${reason}. Stage 0 데이터만 사용.`);
    const stage0Only = {
      vessel_name:   vessel.name || null,
      period:        null,
      operations:    optimeOps  || [],
      tro_data:      dataReportTro || { ballasting_avg: null, deballasting_max: null },
      error_alarms:  [],
      overall_status: null,
      ai_remarks:    [],
      ai_remarks_en: [],
      _debug: {
        totalLogFailed: true,
        totalLogError:  totalLogError || null,
        mainFilePages:  mainFilePages ?? null,
        dataReportTro:  dataReportTro ?? null,
        optimeOps:      optimeOps?.length ?? null,
      },
    };
    return validateAndNormalizeResult(stage0Only, null);
  }

  // Stage 1: 텍스트 기반 추출 (pdf.js 추출 텍스트 → Gemini)
  const { text, totalPages, sections } = totalLogExtraction;
  const splitInfo = { totalPages, wasSplit: true, isTotalLog: true, sections };
  const extractionParts = [{ text: EXTRACTION_PROMPT_TOTALLOG(vessel, text, totalPages, sections) }];
  console.log(`[Stage 1] TOTAL LOG 텍스트 모드: ${text.length}자`);

  let extracted;
  try {
    extracted = await callGeminiRaw(extractionParts, 3, STAGE1_RESPONSE_SCHEMA);
  } catch (err) {
    console.warn("[Stage 1] 텍스트 모드 실패, Stage 0 데이터로 대체:", err.message);
    extracted = { vessel_name: vessel.name || null, period: null, operations: [], tro_data: {}, error_alarms: [] };
  }

  // Stage 0 오버라이드 (프로그래밍 파싱이 AI보다 정확)
  // AI 추출 결과 스냅샷 (진단 패널용 — 병합 전 보존)
  const _aiTroSnapshot = extracted.tro_data ? { ...extracted.tro_data } : null;

  if (totalLogExtraction?.stage0) {
    const s0 = totalLogExtraction.stage0;
    if (s0.operations !== null && s0.operations.length > 0) {
      console.log('[Stage0 Override] operations:', s0.operations.length, '건');
      extracted.operations = s0.operations;
    }
    if (s0.tro_data !== null) {
      console.log('[Stage0 Override] tro_data:', JSON.stringify(s0.tro_data));
      // Stage 0의 null 필드는 AI 유효값을 덮어쓰지 않음 (null override 방지)
      const s0NonNull = Object.fromEntries(
        Object.entries(s0.tro_data).filter(([, v]) => v !== null)
      );
      extracted.tro_data = { ...(extracted.tro_data || {}), ...s0NonNull };
      console.log('[Stage0 Override] tro_data (merged):', JSON.stringify(extracted.tro_data));
    }
    // Stage 0 VRCS override
    if (s0.vrcs_data && s0.vrcs_data.length > 0) {
      const alarms = extracted.error_alarms || [];
      for (const { valve, count } of s0.vrcs_data) {
        const exists = alarms.some(
          a => a.code === 'VRCS_ERR' && a.description?.includes(valve)
        );
        if (!exists) {
          alarms.push({
            code:        'VRCS_ERR',
            description: `Valve Opened/Closed 반복 오작동 감지 [${valve}] ×${count}회`,
            level:       count >= 100 ? 'Alarm' : 'Warning',
            date:        null,
            time:        null,
            count:       count,
          });
          console.log(`[Stage0 Override] VRCS 추가: ${valve} ×${count}`);
        }
      }
      extracted.error_alarms = alarms;
    }
  }

  // ── 개별 파일 Stage 0 결과 보완 (Total Log에 없는 데이터를 별도 파일로 보충) ──
  if (dataReportTro) {
    const cur = extracted.tro_data || {};
    const troNonNull = Object.fromEntries(Object.entries(dataReportTro).filter(([, v]) => v !== null));
    // 기존 null 필드만 덮어씀 (AI나 Total Stage0 값 우선)
    const troFill = Object.fromEntries(Object.entries(troNonNull).filter(([k]) => cur[k] == null));
    if (Object.keys(troFill).length) {
      extracted.tro_data = { ...cur, ...troFill };
      console.log('[DataReport] TRO 보완:', JSON.stringify(troFill));
    }
  }
  if (optimeOps) {
    if (!extracted.operations?.length) {
      extracted.operations = optimeOps;
      console.log('[OpTime] operations 보완:', optimeOps.length, '건');
    }
  }

  // 진단 패널용 _debug 조립 (관리자 전용 표시 — 항상 기록)
  extracted._debug = {
    totalPages:    totalLogExtraction.totalPages,
    mainFilePages: mainFilePages ?? null,
    isTotalReport: totalLogExtraction.isTotalReport ?? false,
    sections:      totalLogExtraction.sections,
    headerText:    totalLogExtraction.headerText ?? null,
    stage0RawTro:  totalLogExtraction.stage0?.tro_data ?? null,
    dataReportTro: dataReportTro ?? null,
    optimeOps:     optimeOps?.length ?? null,
    aiTroData:     _aiTroSnapshot,
  };

  // Stage 2 제거 — recalcOverallStatus + autoFillRemarks가 내부에서 처리
  return validateAndNormalizeResult(extracted, totalLogExtraction.sections ?? null);
}

/**
 * 담당자 메모를 반영한 최종 리마크 생성
 *
 * @param {Object} aiResult      - analyzePdfFromDrive() 결과
 * @param {string} operatorNote  - 담당자 입력 메모
 * @param {string} lang          - "ko" 또는 "en"
 * @returns {string} 최종 리마크 텍스트
 */
export async function generateFinalRemark(aiResult, operatorNote, lang = "ko") {
  const parts = [{ text: REMARK_PROMPT_TEMPLATE(aiResult, operatorNote, lang) }];
  const result = await callGemini(parts);
  return result?.final_remark || "리마크 생성 실패";
}
