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
      "ballast_volume": "주입량 (m³, 표에서 식별된 VOLUME 또는 TON 값, 없으면 null)",
      "deballast_volume": "배출량 (m³, 표에서 식별된 VOLUME 또는 TON 값, 없으면 null)",
      "run_time": "운전 시간 (hour, 없으면 null)",
      "location_gps": "GPS 위치 ([LAT][LON] 형태면 '위도, 경도'로 합쳐서 표기, 없으면 null)"
    }
  ],
  "tro_data": {
    "ballasting_avg": "주입(Ballasting) 안정 구간 평균 TRO (ppm). (동적으로 식별된 T1, T2, TRO_B1 등 모든 TRO 센서들의 0~15 사이 값들의 평균). 없으면 null",
    "deballasting_avg": "배출(De-ballasting) 안정 구간 평균 TRO (ppm). (동적으로 식별된 TRO 센서들의 0~15 사이 값 평균). 없으면 null"
  },
  "sensor_data": {
    "gds_max": "수소가스 최대값 (% LEL, 없으면 null)",
    "csu_avg": "해수 전도도 평균 (mS/cm 또는 PSU, 없으면 null)",
    "fts_max": "냉각수 온도 최대값 (°C, 없으면 null)"
  },
  "error_alarms": [
    {
      "code": "에러 코드 (DESCRIPT 열의 대괄호 안 내용, 예: CODE201. 밸브 오작동의 경우 VRCS_ERR)",
      "description": "에러 내용 (코드 제외한 나머지 텍스트)",
      "level": "Alarm 또는 Trip 또는 Warning",
      "date": "발생 날짜 (YYYY-MM-DD 또는 null)",
      "time": "발생 시간 (HH:MM 또는 null)",
      "sensor_at_event": {
        "rec_voltage": "발생 당시 정류기 전압 (V, 없으면 null)",
        "rec_current": "발생 당시 정류기 전류 (A, 수백~수천 단위, 없으면 null)",
        "tro": "발생 당시 TRO 값 (ppm, 동적으로 식별된 TRO 센서들의 0~15 사이 값, 없으면 null)",
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
첨부된 PDF에서 데이터를 정확히 추출하세요. 숫자·날짜·코드만 있는 그대로 추출하고 해석하거나 판단하지 마세요.
JSON 외의 텍스트는 절대 포함하지 마세요.

[동적 파싱 원칙] ← 반드시 준수
선박·장비 옵션에 따라 표의 센서 구성(TRO1, TRO2, FMU1, CSU 등)이 달라지므로 열 순서를 고정하거나 추측하지 마세요.
각 표에서 첫 번째 줄(영문 대문자 항목)을 기준 헤더로 먼저 파악한 뒤, 줄바꿈·여백 기준으로 데이터를 헤더와 짝지으세요.
PDF 텍스트가 표 형식이 깨져 나열되더라도 지능적으로 열·행을 복원하여 읽을 것.

[장비 정보]
- 선명: ${vessel.name || "미상"}
- BWTS 제조사: ${vessel.manufacturer || "Techcross"}
- BWTS 모델: ${vessel.model || "ECS"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[추출 우선순위 — 반드시 이 순서대로 처리]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Step 1. 기본 정보
- 선명, IMO 번호, 제조사, 분석 기간 추출

Step 2. ECS Operation Time (최우선 — 운전 기준표)
- 섹션명: "ECS Operation Time", "Operation Time Log", "OperationTimeReport" 등
- 실제 컬럼: OPERATION │ START TIME │ END TIME │ RUNNING TIME(HH:MM) │ POSITION(GPS) │ VOLUME(m3) │ Line
- 각 운전(BALLAST/DEBALLAST/STRIPPING)의 모든 행을 추출 (최대 30건)
- ⚠️ 분석 기간(월) 전체를 스캔할 것. 특정 날짜에만 편중된 경우 문서를 처음부터 끝까지 재스캔
- GPS 포맷 예시: [34, 54.13, N][127, 40.19, E] → "34°54.13'N, 127°40.19'E" 형태로 합쳐서 표기
- RUNNING TIME이 HH:MM 형식이면 소수 시간(hour)으로 변환하여 run_time 필드에 입력 (예: 0:34 → 0.57)

Step 3. ECS Data Log (TRO 평균 계산 — 두 번째 우선순위)
- 섹션명: "ECS DATA LOG", "Data Log", "DataReport", "BWTS Data" 등
- TRO 컬럼은 선박마다 다름(T1, T2, TRO_B1 등) — 헤더에서 동적으로 식별할 것
- 식별된 TRO 컬럼 값 중 0~15 사이(ppm)만 사용. 수백~수천 단위 전압/전류값과 절대 혼동 금지

[TRO 평균 계산 규칙]
① Step 2에서 확보한 각 운전의 시작시간·종료시간을 기준으로 해당 시간대 Data Log 행 추출
② 아래 구간 제외 (배관 잔류수로 TRO 부정확):
   - 운전 시작 후 첫 10분 이내
   - 운전 종료 전 마지막 10분 이내
③ 남은 "안정 구간" 값만 평균 → tro_data.ballasting_avg / deballasting_avg
④ 운전 시간 20분 이하이거나 안정 구간 데이터 0개이면 → null

[알람 시점 센서 매칭]
- 알람 발생 시각 기준 ±5분(없으면 ±15분) 이내 Data Log 행에서 sensor 값 추출
- 여러 행 있으면 알람 시각에 가장 가까운 1개만 선택. ±15분도 없으면 null

Step 4. Operation Event Log (참조 — 마지막 처리)
- 섹션명: "Operation Event Log", "Event Log", "Alarm List", "EventLogReport" 등
- DATE·LEVEL·DESCRIPT 열이 있는 표를 찾아 파싱
- TOTAL LOG의 경우 "Operation Event Log"가 문서 앞쪽(2페이지 부근)에 위치하는 경우가 많음
- DESCRIPT 열의 대괄호([]) 안 코드(예: [CODE201])를 'code' 필드에 분리
- 추출 한도: Trip 전부 + Alarm/Warning 동일 코드당 최대 5건 (총 최대 60건)
- ⚠️ 섹션을 발견했으면 반드시 추출. 끝까지 찾지 못한 경우에만 빈 배열 반환

[⚠️ VRCS 밸브 오작동 감지 — Operation Event Log 및 Operation Time Log 양쪽 모두 확인]
특정 밸브(예: [BA011F])가 수 초 단위로 'Valve Opened'/'Valve Closed'를 무수히 반복하는 기록이 있다면
(Level 무관: Normal·Alarm·Warning 모두 포함), 반복 기록은 병합/무시하고 대표 1건만 추출:
→ code: "VRCS_ERR", description: "Valve Opened/Closed 반복 오작동 감지 [해당 밸브명]", level: "Warning"

[⚠️ Event Log 과다 경고]
Operation Event Log 총 항목 수가 100건을 초과하는 경우, error_alarms 배열 마지막에 아래 항목 추가:
→ code: "LOG_OVERFLOW", description: "Event Log 항목이 100건을 초과합니다. 전체 로그 별도 검토 필요.", level: "Warning", date: null, time: null

[확인 불가 항목은 null로 표시. 문자열 값에 줄바꿈 문자 포함 금지]

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
- 데이터 누락(null)이 전체 주요 필드(operations, tro_data, error_alarms)의 30% 미만

WARNING (하나라도 해당):
- Trip 없이 동일 코드 알람 3~4건 발생
- TRO 주입이 정상 범위(5~10ppm)에서 일시적으로 벗어남
- TRO 배출(De-ballasting) 기준(0.1ppm) 초과가 1~2회 발생
- 데이터 누락(null)이 전체 주요 필드의 30% 이상
- 이벤트 로그 100건 초과(LOG_OVERFLOW) 감지

CRITICAL (하나라도 해당):
- Trip 이벤트 1건 이상 발생
- 동일 코드 알람 5건 이상 반복 또는 3회 이상 Trip
- System Failure 또는 명백한 장비 고장 명시
- TRO 배출 기준 초과(0.1ppm 초과)가 연속 3회 이상 명백하게 발생

[ai_remarks 작성 지침]
- 반드시 구체적 숫자 포함: 운전 횟수, TRO 평균값(ppm), 주요 알람 코드 및 발생 건수
- 배출(De-ballasting) TRO가 0.00ppm에 가까운 것은 정상적인 중화 결과이므로 문제 삼지 말 것
- 수치 없는 포괄적 서술 금지 ("전반적으로 정상", "문제없이 완료" 등)
- 100% 한국어 작성 (BWTS, TRO, Alarm, Trip, Code 등 고유명사 제외)
- 알람 발생 시 아래 코드별 조치 권고사항을 반드시 포함할 것:
  * CODE200 (TRO Low): CLX 시약 상태 점검 및 샘플링 라인 확인 권장
  * CODE201 (TRO High): 중화제(Sodium Thiosulfate) 주입 펌프 및 탱크 레벨 확인 권장
  * CODE301/302/303 (ANU Tank Level): 중화제 탱크 레벨 센서 및 밸브 점검 권장
  * CODE701 (Comm Fail): PLC 및 모듈 간 통신 케이블 연결 상태 확인 권장
  * CODE721 (Valve Opened/Failed): 해당 밸브의 공압 상태 및 리미트 스위치 점검 권장
  * VRCS_ERR (밸브 개폐 반복 오작동): 수 초 간격으로 밸브가 열림/닫힘을 반복한 채터링(Chattering) 현상 감지. 공압 라인 불량 또는 밸브 리미트 스위치 접점 불량/VRCS 통신 오류가 강력히 의심됨. [긴급] 즉각적인 해당 밸브 하드웨어 점검 및 수리를 강력 권고.
  * LOG_OVERFLOW (Event Log 100건 초과): 이벤트 로그가 비정상적으로 과다하게 발생했음. 반복성 알람 또는 밸브 오작동이 지속되고 있을 가능성이 높으므로 전체 로그 상세 검토 및 원인 파악 권고. overall_status는 최소 WARNING으로 판정.
- 예시: "당월 주입 3회/배출 2회 운전. 주입 평균 TRO 6.2ppm으로 정상 범위(5~10ppm) 내 유지. CODE200(TRO 저하) Alarm 3건 발생 — CLX 시약 상태 확인 권장."

[ai_remarks_en 작성 지침]
- ai_remarks와 동일한 내용을 영어로 작성 (본선 발송 이메일용)
- Must include specific numbers: operation count, TRO average (ppm), alarm code counts
- VRCS_ERR example: "Valve chattering detected on [valve name] — strongly recommend immediate hardware inspection of pneumatic line and limit switch."
- Example: "3 ballasting / 2 deballasting operations this month. Average TRO 6.2ppm within normal range (5~10ppm). CODE200 (TRO Low) Alarm×3 — recommend checking CLX reagent condition."

[주의사항]
- 불확실한 경우 CRITICAL보다 WARNING/NORMAL 우선
- 문자열 값에 줄바꿈 문자 포함 금지 (한 줄로 작성)
- 출력 JSON은 반드시 아래 3개 키만 포함하고 다른 키는 절대 추가하지 마세요.

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
- 담당자 메모가 없을 경우 알람 정보만을 바탕으로 기술적 리마크를 작성하세요. 메모가 없다는 언급은 하지 마세요.
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
  if (data.ai_remarks && !data.ai_remarks.includes("밸브 비정상")) {
    data.ai_remarks += " " + note;
  }
  if (data.ai_remarks_en && !data.ai_remarks_en.includes("Valve abnormal")) {
    const noteEn = isCritical
      ? `CODE(${codes}) Valve abnormal operation detected ${totalCount} times — [URGENT] immediate valve inspection required (CRITICAL level).`
      : `CODE(${codes}) Valve abnormal operation detected ${totalCount} times — recommend checking valve position and feedback sensor.`;
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
  const troBallastBad   = tro.ballasting_avg   != null && (tro.ballasting_avg < 5 || tro.ballasting_avg > 10);
  const troDeballastBad = tro.deballasting_avg  != null && tro.deballasting_avg > 0.1;

  // LOG_OVERFLOW 감지
  const hasLogOverflow = alarms.some((a) => a.code === "LOG_OVERFLOW");

  // TRO null → 실제 운전이 있었을 때만 WARNING (운전 없는 달은 제외)
  const ops          = data.operations || [];
  const hadBallast   = ops.some((o) => /BALLAST/i.test(o.operation_mode || "") && !/DE/i.test(o.operation_mode || ""));
  const hadDeballast = ops.some((o) => /DEBALLAST/i.test(o.operation_mode || ""));
  const troAllNull   = (hadBallast   && tro.ballasting_avg   == null)
                    || (hadDeballast && tro.deballasting_avg == null);

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

  // AI가 NORMAL인데 JS가 상향 판정 → ai_remarks에 자동 접두 삽입 (모순 방지)
  const statusOrder = { NORMAL: 0, WARNING: 1, CRITICAL: 2 };
  if ((statusOrder[jsStatus] ?? 0) > (statusOrder[aiStatus] ?? 0)) {
    const prefix    = `[시스템 자동판정: ${jsStatus}] `;
    const prefixEn  = `[Auto-escalated to ${jsStatus}] `;
    if (data.ai_remarks && !data.ai_remarks.startsWith("[시스템"))
      data.ai_remarks = prefix + data.ai_remarks;
    if (data.ai_remarks_en && !data.ai_remarks_en.startsWith("[Auto"))
      data.ai_remarks_en = prefixEn + data.ai_remarks_en;
  }

  data.overall_status = jsStatus;

  // 부수 경고 메시지 추가
  if (troAllNull) {
    const note   = "TRO 측정값 없음 — 해당 월 DataReport 누락 또는 TRO 센서 미기록. 별도 확인 필요.";
    const noteEn = "TRO measurement data missing — please verify DataReport or TRO sensor records.";
    if (data.ai_remarks && !data.ai_remarks.includes("TRO 측정값 없음"))
      data.ai_remarks += " " + note;
    if (data.ai_remarks_en && !data.ai_remarks_en.includes("TRO data"))
      data.ai_remarks_en += " " + noteEn;
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
    const note = `운전 기록이 ${onlyDate} 1일에 집중되어 있어 다른 날짜의 데이터 누락 여부 확인을 권장합니다.`;
    const noteEn = `All operations recorded on ${onlyDate} only — please verify whether records for other dates may be missing.`;
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
