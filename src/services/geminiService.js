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

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;

// ── Stage 1 추출 스키마 (텍스트 — 프롬프트에 포함) ────────────
const STAGE1_TEXT_SCHEMA = `{
  "vessel_name": "선박명",
  "imo_number": "IMO 번호 (없으면 null)",
  "period": "분석 기간 (YYYY-MM)",
  "manufacturer": "BWTS 제조사",
  "operations": [
    {
      "date": "날짜 (YYYY-MM-DD)",
      "operation_mode": "BALLAST 또는 DEBALLAST 또는 STRIPPING",
      "start_time": "시작 시간 (HH:MM, 없으면 null)",
      "end_time": "종료 시간 (HH:MM, 없으면 null)",
      "ballast_volume": "주입량 (m³, 없으면 null)",
      "deballast_volume": "배출량 (m³, 없으면 null)",
      "run_time": "운전 시간 (hour, 없으면 null)",
      "location_gps": "GPS 위치 (없으면 null)"
    }
  ],
  "tro_data": {
    "ballasting_avg": "주입(Ballasting) 안정 구간 평균 TRO (ppm) — 운전 시작 후 10분·종료 전 10분 제외. 해당 구간 없으면 null",
    "deballasting_avg": "배출(De-ballasting) 안정 구간 평균 TRO (ppm) — 운전 시작 후 10분·종료 전 10분 제외. 해당 구간 없으면 null"
  },
  "sensor_data": {
    "gds_max": "수소가스 최대값 (% LEL, 없으면 null)",
    "csu_avg": "해수 전도도 평균 (mS/cm, 없으면 null)",
    "fts_max": "냉각수 온도 최대값 (°C, 없으면 null)"
  },
  "error_alarms": [
    {
      "code": "에러 코드",
      "description": "에러 내용",
      "level": "Alarm 또는 Trip 또는 Warning",
      "date": "발생 날짜 (YYYY-MM-DD 또는 null)",
      "time": "발생 시간 (HH:MM 또는 null)",
      "sensor_at_event": {
        "rec_voltage": "발생 당시 정류기 전압 (V, 없으면 null)",
        "rec_current": "발생 당시 정류기 전류 (A, 없으면 null)",
        "tro": "발생 당시 TRO 값 (ppm, 없으면 null)",
        "location_gps": "발생 당시 GPS (없으면 null)"
      }
    }
  ]
}`;

// ── Gemini responseSchema (API 레벨 포맷 강제) ───────────────
// Stage 1: 데이터 추출 결과
const STAGE1_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    vessel_name:  { type: "string" },
    imo_number:   { type: "string", nullable: true },
    period:       { type: "string" },
    manufacturer: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date:             { type: "string",  nullable: true },
          operation_mode:   { type: "string",  nullable: true },
          start_time:       { type: "string",  nullable: true },
          end_time:         { type: "string",  nullable: true },
          ballast_volume:   { type: "number",  nullable: true },
          deballast_volume: { type: "number",  nullable: true },
          run_time:         { type: "number",  nullable: true },
          location_gps:     { type: "string",  nullable: true },
        },
      },
    },
    tro_data: {
      type: "object",
      properties: {
        ballasting_avg:   { type: "number", nullable: true },
        deballasting_avg: { type: "number", nullable: true },
      },
    },
    error_alarms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code:        { type: "string", nullable: true },
          description: { type: "string", nullable: true },
          level:       { type: "string", nullable: true },
          date:        { type: "string", nullable: true },
          time:        { type: "string", nullable: true },
          sensor_at_event: {
            type: "object",
            nullable: true,
            properties: {
              rec_voltage: { type: "number", nullable: true },
              rec_current: { type: "number", nullable: true },
              tro:         { type: "number", nullable: true },
              location_gps:{ type: "string", nullable: true },
            },
          },
        },
      },
    },
  },
  required: ["operations", "error_alarms"],
};

// Stage 2: 분析 판정 결과 (overall_status enum 강제)
const STAGE2_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    overall_status: { type: "string", enum: ["NORMAL", "WARNING", "CRITICAL"] },
    ai_remarks:     { type: "string" },
    ai_remarks_en:  { type: "string" },
  },
  required: ["overall_status", "ai_remarks", "ai_remarks_en"],
};

// ── Stage 1: 데이터 추출 전용 프롬프트 ──────────────────────
const EXTRACTION_PROMPT = (vessel = {}) => `
당신은 선박평형수처리장치(BWTS) 로그 PDF 데이터 추출 전문가입니다.
첨부된 PDF에서 데이터를 정확히 추출하세요.
숫자·날짜·코드만 있는 그대로 추출하세요. 해석하거나 판단하지 마세요.
JSON 외의 텍스트는 절대 포함하지 마세요.

[데이터 파싱 방법]
- PDF에서 추출된 텍스트는 표(Table) 형식이 깨져 값, 값 형태로 나열될 수 있음
- 줄바꿈과 콤마를 기준으로 열(Column)과 행(Row)을 지능적으로 복원해서 읽을 것
- 'Report', 'Log'가 이름에 포함된 파일의 데이터를 우선 읽고, 매뉴얼/도면 파일은 무시

[장비 정보]
- 선명: ${vessel.name || "미상"}
- BWTS 제조사: ${vessel.manufacturer || "Techcross"}
- BWTS 모델: ${vessel.model || "ECS"}

[4단계 추출 절차]

Step 1. GeneralReport (또는 헤더)
- 선명, IMO 번호, 제조사, 분析 기간 추출

Step 2. OperationTimeReport
- 각 운전(BALLAST/DEBALLAST/STRIPPING)의 시작시간, 종료시간, 처리용량, GPS 위치 추출
- 최근 30건으로 제한
- ⚠️ 반드시 분析 기간(월) 전체의 운전을 모두 추출할 것
  특정 날짜 1~2일치만 있는 경우: 문서를 처음부터 끝까지 다시 스캔하여 누락된 운전 확인
  운전 날짜가 모두 동일한 날짜에만 집중되어 있다면 데이터 누락 가능성이 높으므로 재확인
- OperationTimeReport가 보이지 않더라도 DataReport에서 운전 시간 범위를 역추적하여 복원할 것
- 운전 기록을 하나도 찾지 못한 경우: PDF 전체를 다시 스캔하고 "Ballast", "Deballast",
  "Operation", "Start", "End" 키워드가 포함된 모든 표를 확인할 것
- 운전 기록이 정말 없는 달인지, 아니면 PDF 파싱 실패인지 구분하여 추출

Step 3. EventLogReport — 이벤트 로그 파싱
- EventLog 데이터는 별도 EventLogReport 파일에 있을 수도 있고,
  통합 리포트 PDF 내 "Event Log" 섹션으로 포함될 수도 있음 — 양쪽 모두 확인할 것
- 발생 날짜/시간, 레벨(Alarm/Trip/Warning/Normal), 코드, 설명 추출
- 최대 60건으로 제한

[반복 이벤트 처리]
- Trip 이벤트는 무조건 전부 추출
- 그 외(Warning/Alarm)는 동일 코드당 발생 시간순으로 최대 5건까지만 추출, 나머지 무시
- EventLog가 방대한 경우 DataReport·OperationTimeReport·GeneralReport 파싱에 토큰 집중

Step 4. DataReport (TRO 평균 계산 + 센서 매칭)

[TRO 평균 계산 — 핵심 규칙]
① OperationTimeReport에서 각 운전의 정확한 시작시간·종료시간 확인
② DataReport에서 해당 운전 시간 범위의 TRO 행을 추출
③ 아래 구간은 반드시 제외 (배관 잔류수 영향으로 TRO 값이 부정확):
   - 운전 시작 후 첫 10분 이내 데이터
   - 운전 종료 전 마지막 10분 이내 데이터
④ 제외 후 남은 "안정 구간" 데이터만 평균 계산 → tro_data.ballasting_avg / deballasting_avg
⑤ 안정 구간 데이터가 없거나(운전시간 20분 이하) 데이터가 0개면 → null

[센서 매칭 (알람 발생 시점)]
- 알람 발생 시각 기준 ±5분 이내 DataReport 행에서 sensor 값 추출
- 여러 행이 있으면 알람 시각에 가장 가까운 1개 행만 선택
- ±5분 내 데이터 없으면 ±15분 이내에서 가장 가까운 1개 추출
- ±15분도 없으면 해당 필드 null

[확인 불가 항목은 null로 표시]
[문자열 값에 줄바꿈 문자 포함 금지]

${STAGE1_TEXT_SCHEMA}
`.trim();

// ── Stage 2: 분析 판정 전용 프롬프트 ────────────────────────
const ANALYSIS_PROMPT = (vessel = {}, extractedData = {}) => `
당신은 테크로스(Techcross) 선박평형수처리장치(BWTS) 전문가입니다.
아래 추출된 데이터를 분析하여 판정 및 요약을 JSON으로만 작성하세요.
JSON 외의 텍스트는 절대 포함하지 마세요.

[선박 정보]
- 선명: ${vessel.name || extractedData.vessel_name || "미상"}
- BWTS 제조사: ${vessel.manufacturer || extractedData.manufacturer || "Techcross"}
- BWTS 모델: ${vessel.model || "ECS"}
- 분析 기간: ${extractedData.period || "미상"}

[추출된 데이터]
${JSON.stringify(extractedData, null, 2)}

[overall_status 판별 기준]

NORMAL (모두 해당 시):
- Trip 이벤트 0건
- 동일 코드 알람 2건 이하
- TRO 주입(Ballasting) 안정 구간 평균 5~10ppm 유지
- TRO 배출(De-ballasting) 안정 구간 평균 0.1ppm 미만(IMO 기준)
- 데이터 일부 누락(null)은 NORMAL 판정에 영향 없음

WARNING:
- Trip 없이 동일 코드 알람 3~4건 발생
- TRO가 기준 범위에서 일시적으로 벗어났으나 운전은 정상 완료
- 데이터 기록 누락 다수

CRITICAL (하나라도 해당):
- Trip 이벤트 1건 이상 발생
- 동일 코드 알람 5건 이상 반복 또는 3회 이상 Trip
- System Failure 또는 명백한 장비 고장 명시
- TRO 배출 기준 초과(0.1ppm 초과)가 연속 3회 이상 명백하게 발생

[ai_remarks 작성 지침]
- 반드시 구체적 숫자 포함: 운전 횟수, TRO 평균값(ppm), 주요 알람 코드 및 발생 건수
- 수치 없는 포괄적 서술 금지 ("전반적으로 정상", "문제없이 완료" 등)
- 100% 한국어 작성 (BWTS, TRO, Alarm 등 고유명사 제외)
- 예시: "당월 주입 3회/배출 2회 운전. 주입 평균 TRO 6.2ppm으로 정상 범위(5~10ppm) 내 유지. CODE200(TRO 저하) Alarm 3건 발생 — CLX 시약 상태 확인 권장."

[ai_remarks_en 작성 지침]
- ai_remarks와 동일한 내용을 영어로 작성 (본선 발송 이메일용)
- Must include specific numbers: operation count, TRO average (ppm), alarm code counts
- Example: "3 ballasting / 2 deballasting operations this month. Average TRO 6.2ppm within normal range (5~10ppm). CODE200 (TRO Low) Alarm×3 — recommend checking CLX reagent condition."

[주의사항]
- 불확실한 경우 CRITICAL보다 WARNING/NORMAL 우선
- 문자열 값에 줄바꿈 문자 포함 금지 (한 줄로 작성)

{"overall_status": "NORMAL 또는 WARNING 또는 CRITICAL", "ai_remarks": "...", "ai_remarks_en": "..."}
`.trim();


const REMARK_PROMPT_TEMPLATE = (aiResult, operatorNote, lang = "ko") => {
  const isEn = lang === "en";
  const langInstr = isEn
    ? "Write entirely in professional English."
    : "반드시 한국어로만 작성하세요. 영어 혼용 금지.";

  // 알람 코드별 요약 목록 생성
  const alarms = aiResult?.error_alarms ?? [];
  const codeMap = new Map();
  for (const a of alarms) {
    const code = a.code ?? "(코드없음)";
    const desc = (a.description ?? "").replace(/\s*[\[\(]\d[\d.]*[\]\)]/g, "").trim();
    const lv   = (a.level ?? "").toLowerCase();
    if (!codeMap.has(code)) codeMap.set(code, { desc, trip: 0, alarm: 0 });
    const g = codeMap.get(code);
    if (lv === "trip") g.trip++; else g.alarm++;
  }
  const alarmList = Array.from(codeMap.entries())
    .map(([code, g]) => {
      const cnt = [];
      if (g.trip)  cnt.push(isEn ? `TRIP x${g.trip}` : `Trip ${g.trip}회`);
      if (g.alarm) cnt.push(isEn ? `Alarm x${g.alarm}` : `Alarm ${g.alarm}회`);
      return `[${code}] ${g.desc} (${cnt.join(" / ")})`;
    }).join("\n");

  const exampleKo = `[CODE200] TRO Concentration Low: CLX 시약 유효기간 만료 또는 TSU BYPASS LINE 막힘 가능성이 있습니다. CLX 시약 교체 여부 및 BYPASS LINE 소통 상태를 점검하시기 바랍니다.`;
  const exampleEn = `[CODE200] TRO Concentration Low: Possible CLX reagent expiry or TSU BYPASS LINE blockage. Please check CLX reagent date and verify BYPASS LINE flow.`;

  return `
당신은 선박 평형수 처리 시스템(BWTS) 전문 기술자입니다.
아래 알람 목록과 담당자 메모를 바탕으로 코드별 기술 리마크를 작성하세요.

[발생 알람 목록]
${alarmList || "(없음)"}

[담당자 메모]
${operatorNote || "(없음)"}

[작성 형식]
발생한 각 알람 코드에 대해 아래 형식으로 작성하세요:
[CODE번호] 알람명: 추정 원인 및 권장 점검 사항.

예시: ${isEn ? exampleEn : exampleKo}

[작성 규칙]
- 각 코드마다 1줄, 코드 항목 간은 줄바꿈으로 구분
- "~가능성이 있습니다", "~의심됩니다", "~권장합니다" 어조 사용
- "~고장입니다", "~문제입니다" 단정 표현 금지
- 현장에서 직접 확인 가능한 구체적 점검 항목 포함
- ${langInstr}

JSON 형식으로 응답하세요 (줄바꿈은 \\n으로 표현):
{"final_remark": "[CODE100] ...: ...\\n[CODE200] ...: ..."}
`.trim();
};

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
    VALVE_PATTERN.test(a.description || "") || VALVE_CODES.test(String(a.code || ""))
  );
  if (valveAlarms.length === 0) return;

  // ×N회 표기에서 count 추출 (없으면 1)
  const totalCount = valveAlarms.reduce((sum, a) => {
    const m = (a.description || "").match(/×(\d+)회/);
    return sum + (m ? parseInt(m[1]) : 1);
  }, 0);
  if (totalCount < 5) return;

  const codes = [...new Set(valveAlarms.map((a) => a.code).filter(Boolean))].join(", ");
  const note = `CODE(${codes}) 밸브 비정상 동작 총 ${totalCount}회 감지 — 해당 밸브 개도 설정 및 센서 점검 권장.`;
  if (data.ai_remarks && !data.ai_remarks.includes("밸브 비정상")) {
    data.ai_remarks += " " + note;
  }
  if (data.ai_remarks_en && !data.ai_remarks_en.includes("valve")) {
    const noteEn = `CODE(${codes}) Valve abnormal operation detected ${totalCount} times — recommend checking valve position and feedback sensor.`;
    data.ai_remarks_en += " " + noteEn;
  }
}

// ── TRO 범위 체크 → ai_remarks 보완 ──────────────────────────
function checkTroRange(data) {
  const tro = data.tro_data || {};
  const notes = [];

  if (tro.ballasting_avg != null) {
    if (tro.ballasting_avg < 5)
      notes.push(`주입 TRO ${tro.ballasting_avg}ppm — 정상 기준(5~10ppm) 미달, CLX 시약 상태 확인 필요.`);
    else if (tro.ballasting_avg > 10)
      notes.push(`주입 TRO ${tro.ballasting_avg}ppm — 정상 기준(5~10ppm) 초과.`);
  }
  if (tro.deballasting_avg != null && tro.deballasting_avg > 0.1)
    notes.push(`배출 TRO ${tro.deballasting_avg}ppm — IMO 기준(0.1ppm) 초과, 즉시 확인 필요.`);

  for (const note of notes) {
    if (data.ai_remarks && !data.ai_remarks.includes(note.slice(0, 12)))
      data.ai_remarks += " " + note;
    if (data.ai_remarks_en) {
      const noteEn =
        note.includes("미달")   ? `Ballasting TRO ${tro.ballasting_avg}ppm — below normal range (5~10ppm), check CLX reagent condition.`
        : note.includes("초과") && note.includes("주입") ? `Ballasting TRO ${tro.ballasting_avg}ppm — exceeds normal range (5~10ppm).`
        : `Deballasting TRO ${tro.deballasting_avg}ppm — exceeds IMO limit (0.1ppm), immediate check required.`;
      if (!data.ai_remarks_en.includes(String(tro.ballasting_avg ?? tro.deballasting_avg)))
        data.ai_remarks_en += " " + noteEn;
    }
  }
}

// ── overall_status JS 완전 재계산 ────────────────────────────
function recalcOverallStatus(data) {
  const alarms = data.error_alarms || [];
  const tro    = data.tro_data    || {};

  // Trip 건수
  const tripCount = alarms.filter((a) => (a.level || "").toLowerCase() === "trip").length;

  // 알람 최대 반복 횟수 (×N회 표기에서 추출, 없으면 1)
  const maxRepeat = alarms.reduce((max, a) => {
    const m = (a.description || "").match(/×(\d+)회/);
    return Math.max(max, m ? parseInt(m[1]) : 1);
  }, 0);

  // TRO 기준 위반 여부
  const troBallastBad   = tro.ballasting_avg   != null && (tro.ballasting_avg < 5 || tro.ballasting_avg > 10);
  const troDeballastBad = tro.deballasting_avg  != null && tro.deballasting_avg > 0.1;

  // TRO null → 실제 운전이 있었을 때만 WARNING (운전 없는 달은 제외)
  const ops         = data.operations || [];
  const hadBallast  = ops.some((o) => /BALLAST/i.test(o.operation_mode || "") && !/DE/i.test(o.operation_mode || ""));
  const hadDeballast = ops.some((o) => /DEBALLAST/i.test(o.operation_mode || ""));
  const troAllNull  = (hadBallast    && tro.ballasting_avg   == null)
                   || (hadDeballast  && tro.deballasting_avg == null);

  if (tripCount >= 1 || maxRepeat >= 5 || troDeballastBad) {
    data.overall_status = "CRITICAL";
  } else if (maxRepeat >= 3 || alarms.length >= 3 || troBallastBad || troAllNull) {
    data.overall_status = "WARNING";
    // TRO 전체 누락 시 ai_remarks에 경고 추가
    if (troAllNull) {
      const note = "TRO 측정값 없음 — 해당 월 DataReport 누락 또는 TRO 센서 미기록. 별도 확인 필요.";
      if (data.ai_remarks && !data.ai_remarks.includes("TRO 측정값 없음"))
        data.ai_remarks += " " + note;
      if (data.ai_remarks_en && !data.ai_remarks_en.includes("TRO data"))
        data.ai_remarks_en += " TRO measurement data missing — please verify DataReport or TRO sensor records.";
    }
  } else {
    data.overall_status = "NORMAL";
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

  // 모든 운전이 단 하루에 집중된 경우
  if (uniqueDates.size === 1 && ops.length >= 2) {
    const onlyDate = [...uniqueDates][0];
    const note = `⚠️ 운전 기록이 ${onlyDate} 1일치에만 집중 — 월 전체 데이터 누락 가능성 있음. OperationTimeReport 재확인 권장.`;
    const noteEn = `⚠️ All operations recorded on ${onlyDate} only — possible data omission for other dates. Please re-check OperationTimeReport.`;
    if (data.ai_remarks && !data.ai_remarks.includes("운전 기록이")) {
      data.ai_remarks += " " + note;
    }
    if (data.ai_remarks_en && !data.ai_remarks_en.includes("operations recorded on")) {
      data.ai_remarks_en += " " + noteEn;
    }
    // 상태도 WARNING 이상으로
    if (data.overall_status === "NORMAL") data.overall_status = "WARNING";
  }
}

// ── 운전 0회인데 TRO 값이 있거나 알람이 있는 경우 경고 ────────
function checkZeroOperations(data) {
  const ops = data.operations || [];
  const tro = data.tro_data || {};
  const alarms = data.error_alarms || [];
  // 운전이 0회인데 TRO 또는 알람이 있으면 → 추출 실패 가능성
  if (ops.length === 0 && (tro.ballasting_avg != null || tro.deballasting_avg != null || alarms.length > 0)) {
    const note = "⚠️ 운전 기록 0건 추출됨 — OperationTimeReport 누락 또는 PDF 인식 오류 가능성. 재분석 권장.";
    const noteEn = "⚠️ 0 operations extracted — possible missing OperationTimeReport or PDF parsing error. Re-analysis recommended.";
    if (data.ai_remarks && !data.ai_remarks.includes("운전 기록 0건"))
      data.ai_remarks = note + " " + data.ai_remarks;
    if (data.ai_remarks_en && !data.ai_remarks_en.includes("0 operations"))
      data.ai_remarks_en = noteEn + " " + data.ai_remarks_en;
    if (data.overall_status === "NORMAL") data.overall_status = "WARNING";
  }
}

// ── ai_remarks 비어있을 때 기본 요약 자동 생성 ────────────────
function autoFillRemarks(data) {
  if (data.ai_remarks && data.ai_remarks.length > 20) return;

  const ops           = data.operations || [];
  const ballastCount  = ops.filter((o) => (o.operation_mode || "").includes("BALLAST") && !o.operation_mode.includes("DE")).length;
  const deballastCount = ops.filter((o) => o.operation_mode === "DEBALLAST").length;
  const tro           = data.tro_data || {};
  const alarmCount    = (data.error_alarms || []).length;

  const parts = [];
  if (ballastCount || deballastCount)
    parts.push(`당월 주입 ${ballastCount}회/배출 ${deballastCount}회 운전.`);
  if (tro.ballasting_avg != null)
    parts.push(`주입 평균 TRO ${tro.ballasting_avg}ppm.`);
  if (tro.deballasting_avg != null)
    parts.push(`배출 평균 TRO ${tro.deballasting_avg}ppm.`);
  if (alarmCount > 0)
    parts.push(`알람/에러 ${alarmCount}건 발생.`);
  else if (alarmCount === 0 && ops.length > 0)
    parts.push("알람/에러 없음.");

  if (parts.length > 0) {
    data.ai_remarks    = parts.join(" ");
    data.ai_remarks_en = data.ai_remarks
      .replace("당월 주입", "This month ballasting")
      .replace("회/배출", "× / deballasting")
      .replace("회 운전.", "× operations.")
      .replace("주입 평균 TRO", "Avg ballasting TRO")
      .replace("배출 평균 TRO", "Avg deballasting TRO")
      .replace("ppm.", "ppm.")
      .replace("알람/에러 없음.", "No alarms/errors.")
      .replace(/알람\/에러 (\d+)건 발생\./, "Alarms/errors: $1 occurrences.");
  }
}


// ── TRO 비정상값 sanity check (잘못된 단위/추출 오류 방어) ───
function sanitizeTroValues(data) {
  const tro = data.tro_data;
  if (!tro) return;
  // 100ppm 초과는 센서오류/단위오류로 간주 → null 처리 + ai_remarks 경고
  if (tro.ballasting_avg != null && tro.ballasting_avg > 100) {
    const val = tro.ballasting_avg;
    tro.ballasting_avg = null;
    const note = `주입 TRO ${val}ppm — 비정상 수치(센서 오류 또는 단위 오류 의심). 재확인 필요.`;
    if (data.ai_remarks && !data.ai_remarks.includes("비정상 수치"))
      data.ai_remarks += " " + note;
  }
  if (tro.deballasting_avg != null && tro.deballasting_avg > 100) {
    const val = tro.deballasting_avg;
    tro.deballasting_avg = null;
    const note = `배출 TRO ${val}ppm — 비정상 수치(센서 오류 또는 단위 오류 의심). 재확인 필요.`;
    if (data.ai_remarks && !data.ai_remarks.includes("비정상 수치"))
      data.ai_remarks += " " + note;
  }
}

// ── 응답 후처리: 필수 필드 검증 및 정규화 ───────────────────
function validateAndNormalizeResult(data) {
  if (!data || typeof data !== "object") return {};
  // overall_status: 허용값 외에는 null (mapOverallStatus에서 재추론)
  const s = (data.overall_status || "").toUpperCase();
  if (!["NORMAL", "WARNING", "CRITICAL"].includes(s)) data.overall_status = null;
  // 배열 보장
  if (!Array.isArray(data.error_alarms)) data.error_alarms = [];
  if (!Array.isArray(data.operations))   data.operations  = [];
  // ai_remarks / ai_remarks_en 없으면 빈 문자열
  if (!data.ai_remarks) data.ai_remarks = "";
  if (!data.ai_remarks_en) data.ai_remarks_en = "";
  // 0. TRO 비정상값 sanity check (100ppm 초과 → null)
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

async function getOrUploadFileUri(fileId, accessToken) {
  const cached = _fileUriCache.get(fileId);
  if (cached && Date.now() - cached.uploadedAt < FILES_EXPIRE_MS) {
    console.log(`[Files API] 캐시 재사용: ${fileId}`);
    return cached.uri;
  }

  const res = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    180_000
  );
  if (!res.ok) throw new Error(`Drive 다운로드 실패 (${fileId}): ${res.status}`);
  const blob = await res.blob();

  console.log(`[Files API] 업로드: ${fileId} (${(blob.size/1024/1024).toFixed(1)} MB)`);
  const uri = await uploadToGeminiFiles(blob, `bwts_${fileId}.pdf`);
  if (!uri) throw new Error(`Files API URI 없음 (${fileId})`);

  _fileUriCache.set(fileId, { uri, uploadedAt: Date.now() });
  return uri;
}

export async function analyzePdfFromDrive(fileIds, accessToken, vessel = {}) {
  const ids = Array.isArray(fileIds) ? fileIds : [fileIds];

  // 1. 파일들을 Gemini Files API에 업로드 (캐시 활용, 병렬)
  const uris = await Promise.all(ids.map((id) => getOrUploadFileUri(id, accessToken)));

  // 2. Stage 1 parts 구성 (추출 전용, PDF 첨부)
  const makeExtractionParts = (uriList) => [
    { text: EXTRACTION_PROMPT(vessel) },
    ...uriList.map((uri) => ({ fileData: { mimeType: "application/pdf", fileUri: uri } })),
  ];

  // 3. 전체 실패 시 개별 시도 fallback 조건
  const shouldFallback = (e) =>
    uris.length > 1 && (
      e.message.includes("exceeds") ||
      e.message.includes("500") ||
      e.message.includes("파싱 실패") ||
      e.name === "AbortError" ||
      e.message.includes("aborted")
    );

  // Stage 1: 데이터 추출 (PDF 첨부)
  let extracted;
  try {
    extracted = await callGeminiRaw(makeExtractionParts(uris), 3, STAGE1_RESPONSE_SCHEMA);
  } catch (err) {
    if (!shouldFallback(err)) throw err;
    console.warn("Stage 1 전체 묶음 실패, 개별 시도...", err.message);
    for (const uri of uris) {
      try {
        extracted = await callGeminiRaw(makeExtractionParts([uri]), 3, STAGE1_RESPONSE_SCHEMA);
        break;
      } catch (innerErr) {
        console.warn("Stage 1 개별 실패, 다음...", innerErr.message);
        if (!innerErr.message.includes("exceeds")) throw innerErr;
      }
    }
    if (!extracted) throw new Error("Stage 1: 모든 PDF 분析 실패.");
  }

  // Stage 2: 분析/판정/remarks (JSON만, PDF 없음)
  const analysisParts = [{ text: ANALYSIS_PROMPT(vessel, extracted) }];
  let analyzed;
  try {
    analyzed = await callGeminiRaw(analysisParts, 3, STAGE2_RESPONSE_SCHEMA);
  } catch (err) {
    console.warn("Stage 2 실패, 기본값으로 후처리 진행:", err.message);
    analyzed = { overall_status: null, ai_remarks: "", ai_remarks_en: "" };
  }

  // Stage 1 + Stage 2 결합 후 후처리
  return validateAndNormalizeResult({ ...extracted, ...analyzed });
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
