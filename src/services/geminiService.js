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
    "deballasting_max": "배출(De-ballasting) TRO 최댓값 (ppm). (DEBALLAST/N-D 행의 TRO_D*, TRO_S* 컬럼 값 중 0~15 사이 최댓값). 없으면 null",
    "ecu_current_avg": "ECU 정류기 전류 평균 (A, Data Log 운전 구간 기준, 수백~수천 단위). 없으면 null",
    "fmu_flow_avg": "유량계(FMU) 평균 유량 (m³/h 또는 T/h). 없으면 null",
    "anu_status": "중화장치(ANU) 최종 상태 ('Ready', 'Operating', 'Fault' 중 하나). 없으면 null"
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
        deballasting_max: { type: "number", nullable: true },
        ecu_current_avg:  { type: "number", nullable: true },
        fmu_flow_avg:     { type: "number", nullable: true },
        anu_status:       { type: "string", nullable: true },
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
    ai_remarks:     { type: "array", items: { type: "string" } },
    ai_remarks_en:  { type: "array", items: { type: "string" } },
  },
  required: ["overall_status", "ai_remarks", "ai_remarks_en"],
};

// ── Stage 1: 데이터 추출 전용 프롬프트 ──────────────────────
const EXTRACTION_PROMPT = (vessel = {}, splitInfo = null) => `
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

${splitInfo ? `⚠️ [분할 PDF 안내] 이 PDF는 원본 ${splitInfo.totalPages}페이지 TOTAL LOG의 정밀 분할본입니다.
★ 페이지 구성 (이 순서대로 배치됨):
  1. 앞 ${splitInfo.splitSections?.basic ?? LARGE_PDF_START_PAGES}페이지 — 기본정보 (선명, 기간 등)
  2. 다음 ${splitInfo.splitSections?.critical}페이지 — ECS Operation Time Log + ECS Data Log (★ 최우선 처리)
  3. 나머지 ${splitInfo.splitSections?.eventLog}페이지 — Operation Event Log 최근 구간 (VRCS 채터링 감지에 집중)
중간 Event Log(약 ${splitInfo.totalPages - splitInfo.extractedPages}p)는 포함되지 않았습니다.
Step 2(Operation Time)와 Step 3(Data Log)는 이 PDF의 앞~중간 부분에 있습니다.` : `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ TOTAL LOG 처리 절차 — 반드시 준수
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOTAL LOG PDF는 앞부분에 Operation Event Log가 수백~수천 페이지를 차지합니다.
이 섹션을 먼저 읽으면 컨텍스트가 소진되어 핵심 데이터를 놓칩니다.

【PHASE 0】 섹션 위치 파악 (가장 먼저 실행)
PDF 전체에서 아래 섹션의 시작 페이지를 먼저 확인하세요:
  - "ECS Operation Time" 또는 "Operation Time Log" → 위치 메모
  - "ECS DATA LOG" 또는 "Data Log" → 위치 메모
  - "Operation Event Log" 또는 "Event Log" → 위치 메모 (마지막 처리용)

【PHASE 1】 Operation Time Log 완전 추출 (PHASE 0 직후)
위에서 확인한 Operation Time Log 위치로 바로 이동하여 전체 내용을 추출하세요.
Event Log 구간은 완전히 건너뜁니다.

【PHASE 2】 Data Log 완전 추출 (PHASE 1 직후)
위에서 확인한 Data Log 위치로 바로 이동하여 전체 내용을 추출하세요.

【PHASE 3】 Operation Event Log 선별 추출 (마지막)
컨텍스트가 남아있을 경우에만, Event Log에서 Trip·VRCS 채터링만 선별 추출합니다.
Event Log를 통째로 읽지 마세요. 전부 읽으려 하지 마세요.
`}

Step 1. 기본 정보
- 선명, IMO 번호, 제조사, 분析 기간 추출

Step 2. ECS Operation Time (최우선 — 운전 기준표) ← PHASE 1에서 처리
- 섹션명: "ECS Operation Time", "Operation Time Log", "OperationTimeReport" 등
- PHASE 0에서 확인한 위치로 직접 이동하여 추출 (앞의 Event Log 건너뜀)
- 실제 컬럼: OPERATION │ START TIME │ END TIME │ RUNNING TIME(HH:MM) │ POSITION(GPS) │ VOLUME(m3) │ Line
- 각 운전(BALLAST/DEBALLAST/STRIPPING)의 모든 행을 추출 (최대 30건)
- ⚠️ 분析 기간(월) 전체를 스캔할 것. 특정 날짜에만 편중된 경우 재스캔
- GPS 포맷 예시: [34, 54.13, N][127, 40.19, E] → "34°54.13'N, 127°40.19'E" 형태로 합쳐서 표기
- RUNNING TIME이 HH:MM 형식이면 소수 시간(hour)으로 변환하여 run_time 필드에 입력 (예: 0:34 → 0.57)
- ⚠️ 날짜 유효성: 존재하지 않는 날짜(예: 비윤년의 2월 29일, 4월 31일 등)는 추출하지 말 것
- ⚠️ 운전 횟수(주입/배출 N회)는 반드시 이 Operation Time Log 기록만 기준으로 함
  → Operation Time Log에 기록이 없으면 operations 배열은 빈 배열([])로 반환할 것
  → Data Log의 OPERATION 컬럼 상태값(BALLAST/DEBALLAST)은 TRO 평균 계산 전용이며 운전 횟수 카운트에 절대 사용하지 말 것
  → Event Log의 Operation Start/Stop 이벤트도 운전 횟수 카운트에 사용하지 말 것
  → 비정상 종료("ECS terminated in the wrong way" 등)된 운전은 Operation Time Log에 종료 기록이 없으므로 포함하지 말 것

Step 3. ECS Data Log (TRO + ECU/FMU 평균 계산 — 두 번째 우선순위) ← PHASE 2에서 처리
- 섹션명: "ECS DATA LOG", "Data Log", "DataReport", "BWTS Data" 등
- PHASE 0에서 확인한 위치로 직접 이동하여 추출
- ⚠️ 이 섹션은 TRO/ECU/FMU 수치 계산 전용. OPERATION 컬럼 상태값은 TRO 행 필터링에만 사용할 것

[ECS Data Log 컬럼 식별 — 헤더에서 동적으로 찾을 것]
헤더 행(INDEX TIME OPERATION ... 형식)을 먼저 읽고 아래 매핑으로 컬럼 식별:
① OPERATION 컬럼: 운전 상태값 포함. 아래 두 가지 형식 모두 인식할 것:
   - 문자열 형식: "BALLAST", "DEBALLAST", "STRIPPING", "STANDBY" 등
   - 라인 번호 형식: "1-B", "2-B" 등 → BALLAST로 처리 / "1-D", "2-D" 등 → DEBALLAST로 처리
     ("N-B" = Line N Ballast, "N-D" = Line N Deballast, "N-S" = Line N Stripping)
② TRO(ppm) 컬럼: 이름에 "TRO" 포함 (예: TRO_B1, TRO_B2, TRO_D1, TRO_S1, TRO1, TRO2, T1, T2 등)
   - TRO_B*, TRO1, T1 계열 → 주입(Ballasting) TRO
   - TRO_D*, TRO_S*, TRO2, T2 계열 → 배출(Deballasting) TRO
   - 값 범위: 0~15 ppm만 유효. 수십~수천 단위(전압/전류)는 절대 TRO로 오인하지 말 것
③ ECU 전류(A) 컬럼: 이름에 "REC1_CURRENT", "REC_I", "CURRENT", "ECU_I" 등 포함. 수백~수천A 단위.
   → 운전 구간 평균 → tro_data.ecu_current_avg
④ 유량(FMU) 컬럼: 이름에 "FMU1", "FMU", "FLOW" 등 포함 (FMU_ST는 상태값이므로 제외)
   → 운전 구간 평균 → tro_data.fmu_flow_avg
⑤ ANU 컬럼: 이름에 "ANU_D", "ANU_S", "ANU" 등 포함. 숫자(주입량)가 있으면 운전 중 값의 평균.
   0이면 'Standby', 양수이면 'Operating' 으로 판단 → tro_data.anu_status
- ⚠️ ECU 전류·유량이 있는데 주입 TRO가 0.0 지속이면 전극/센서 이상 가능성 — 반드시 추출

[TRO 평균 계산 규칙]
방법 A (OPERATION 컬럼이 있을 때 — 우선 적용):
  ① BALLAST(또는 N-B) 행의 TRO_B* 컬럼 값 중 0.1~15 사이 값 평균 → ballasting_avg
  ② DEBALLAST(또는 N-D) 행의 TRO_D*(또는 TRO_S*) 컬럼 값 중 0~15 사이 최댓값 → deballasting_max
  ③ 안정구간 필터: 운전이 10분 이상인 경우에만 첫 5분/마지막 5분 행 제외. 10분 미만 단속 운전은 필터 없이 전체 평균
  ④ 단속 운전(CODE605 등으로 반복 STOP/START)이 있는 경우 → 전체 BALLAST 행의 TRO를 합산 평균
  ⑤ TRO 값이 모두 0.00인 경우 → ballasting_avg = null (TRO 미생성 또는 센서 미작동)
방법 B (OPERATION 컬럼 없거나 방법 A 실패 시):
  ① Step 2의 운전 시작~종료 시간대 Data Log 행 추출
  ② 운전 20분 이상: 시작 후 5분 / 종료 전 5분 제외 후 평균. 20분 미만: 전체 평균
  ③ 0.1~15 사이 값이 전혀 없으면 → null

[알람 시점 센서 매칭]
- 알람 발생 시각 기준 ±5분(없으면 ±15분) 이내 Data Log 행에서 sensor 값 추출
- 여러 행 있으면 알람 시각에 가장 가까운 1개만 선택. ±15분도 없으면 null

Step 4. Operation Event Log (참조 — 마지막 처리) ← PHASE 3에서 처리
- 섹션명: "Operation Event Log", "Event Log", "Alarm List", "EventLogReport" 등
- ⚠️ Step 2·3 완료 후 컨텍스트가 남아있을 때만 처리. 전체를 읽으려 하지 마세요.
  컨텍스트를 절약하여 아래 항목만 선별 추출하세요:
  1) Trip 이벤트 — 전부 추출
  2) Alarm/Warning — 동일 코드당 시간순 최대 5건 (총 최대 60건)
  3) VRCS 채터링 패턴 — 아래 특별 규칙 적용
- DESCRIPT 열의 대괄호([]) 안 코드(예: [CODE201])를 'code' 필드에 분리
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

// ── TOTAL LOG 전용 텍스트 기반 추출 프롬프트 ─────────────────
const EXTRACTION_PROMPT_TOTALLOG = (vessel = {}, extractedText = "", totalPages = 0, sections = null) => `
당신은 선박평형수처리장치(BWTS) 로그 데이터 추출 전문가입니다.
아래 텍스트는 TOTAL LOG PDF(원본 ${totalPages}페이지)에서 핵심 섹션만 추출한 내용입니다.
숫자·날짜·코드만 있는 그대로 추출하고 해석하거나 판단하지 마세요.
JSON 외의 텍스트는 절대 포함하지 마세요.

[동적 파싱 원칙] ← 반드시 준수
선박·장비 옵션에 따라 표의 센서 구성(TRO1, TRO2, FMU1, CSU 등)이 달라지므로 열 순서를 고정하거나 추측하지 마세요.
각 표에서 첫 번째 줄(영문 대문자 항목)을 기준 헤더로 먼저 파악한 뒤, 줄바꿈·여백 기준으로 데이터를 헤더와 짝지으세요.
PDF 텍스트가 표 형식이 깨져 나열되더라도 지능적으로 열·행을 복원하여 읽을 것.

[장비 정보]
- 선명: ${vessel.name || "미상"}
- BWTS 제조사: ${vessel.manufacturer || "Techcross"}
- BWTS 모델: ${vessel.model || "ECS"}

[텍스트 구성]
${sections?.op_time_start
  ? `- p.1~5: 기본 정보\n- p.${sections.op_time_start}~: ECS Operation Time Log (운전 기록 기준표)\n- p.${sections.data_log_start ?? "?"}~: ECS Data Log (TRO 수치)\n- Operation Event Log 샘플 포함`
  : "- p.1~5: 기본 정보\n- 뒤 50페이지: Op Time + Data Log 추정 구간\n- Operation Event Log 샘플 포함"}

[추출 순서 — 반드시 준수]
Step 1. 기본 정보: 선명, IMO 번호, 제조사, 분析 기간
Step 2. ECS Operation Time Log 섹션에서 각 운전(BALLAST/DEBALLAST/STRIPPING) 추출 (최대 30건)
  - 컬럼: OPERATION │ START TIME │ END TIME │ RUNNING TIME │ POSITION(GPS) │ VOLUME
  - RUNNING TIME HH:MM → 소수 시간(hour) 변환 (예: 0:34 → 0.57)
  - ⚠️ 존재하지 않는 날짜(비윤년 2월 29일, 4월 31일 등) 추출 금지
  - ⚠️ 운전 횟수는 반드시 이 Operation Time Log 기록만 기준. 기록 없으면 operations = []
  - ⚠️ Data Log OPERATION 컬럼 상태값이나 Event Log Start/Stop 이벤트는 운전 횟수 카운트에 절대 사용 금지
  - ⚠️ 비정상 종료(ECS terminated in the wrong way 등)로 완료 기록 없는 운전은 포함 금지
Step 3. ECS Data Log 섹션에서 TRO + ECU/FMU 평균 계산 (TRO 수치 전용 — 운전 횟수 산정 불가)
  - 헤더 행(INDEX TIME OPERATION ... 형식)을 먼저 읽어 컬럼 식별
  - TRO 컬럼: 이름에 "TRO" 포함 (TRO_B1/B2=주입, TRO_D1/S1=배출, TRO1/T1=주입, TRO2/T2=배출)
    값 범위 0~15 ppm만 유효. 수십~수천 단위(전압/전류)는 절대 TRO로 오인 금지
  - OPERATION 컬럼이 있으면: BALLAST/N-B 행 → ballasting_avg, DEBALLAST/N-D 행 → deballasting_max (최댓값, TRO 계산에만 사용)
  - 단속 운전(반복 STOP/START)은 전체 BALLAST 행 합산 평균. 10분 미만 단속 운전은 안정구간 필터 미적용
  - OPERATION 컬럼 없으면: Step2 시작~종료 시간 기준, 앞뒤 10분 제외 안정 구간 평균
  - 안정 구간 0개 또는 운전 20분 이하 → null
  - ECU 전류: REC1_CURRENT, REC_I, CURRENT, ECU_I 등 수백~수천A → ecu_current_avg
  - 유량: FMU1, FMU, FLOW 등 (FMU_ST 제외) → fmu_flow_avg
  - ANU: ANU_D1, ANU_S1 등 숫자값 — 0이면 'Standby', 양수이면 'Operating' → anu_status
Step 4. Operation Event Log 샘플에서 Trip·Alarm 선별 추출
  - Trip 전부, 동일 코드 Alarm 최대 5건 (총 60건 이하)
  - VRCS 채터링(특정 밸브 수초 간격 Opened/Closed 반복): VRCS_ERR 1건으로 병합
  - LOG_OVERFLOW: 총 항목 100건 초과 감지 시 추가
  - ⚠️ 샘플 구간 외에는 추출 시도 불필요

[확인 불가 항목은 null. 문자열 값에 줄바꿈 포함 금지]

[추출 대상 텍스트]
${extractedText}

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
- TRO 배출(De-ballasting) 최댓값 0.1ppm 미만(IMO 기준)

WARNING (하나라도 해당):
- Trip 없이 동일 코드 알람 3~4건 발생
- TRO 주입이 정상 범위(5~10ppm)에서 일시적으로 벗어남
- TRO 배출(De-ballasting) 기준(0.1ppm) 초과가 1~2회 발생
- 이벤트 로그 100건 초과(LOG_OVERFLOW) 감지

CRITICAL (하나라도 해당):
- Trip 이벤트 1건 이상 발생
- 동일 코드 알람 5건 이상 반복 또는 3회 이상 Trip
- System Failure 또는 명백한 장비 고장 명시
- TRO 배출 기준 초과(0.1ppm 초과)가 연속 3회 이상 명백하게 발생
- ECU 전류(ecu_current_avg)가 있고 유량(fmu_flow_avg)이 있는데 주입 TRO(ballasting_avg)가 0.0이거나 null → 전극/TRO센서 고장 의심, CRITICAL

[ai_remarks 작성 지침]
ai_remarks는 문자열 배열(array)로 반환하세요. 각 원소 순서:
- 원소 0: [운전 현황] 주입 N회 / 배출 N회. 주입 TRO Xppm(정상 5~10ppm [충족/미달]). 배출 TRO 최댓값 Xppm(IMO 기준 [충족/초과]).
- 원소 1 (ECU/FMU 데이터가 있을 때만): [ECU] 전류 XXXXa / 유량 XX.Xm³h. TRO와 상관관계 요약. (예: 전류·유량 정상인데 TRO 0.0 → 전극/센서 점검 필요. 정상이면 "[ECU] 전류·유량 정상 — TRO 생성 이상 없음.") ANU 상태도 포함 (예: ANU Ready/Operating/Fault). ecu_current_avg, fmu_flow_avg, anu_status 모두 null이면 이 원소 생략.
- 원소 2~N: [CODE701] Trip×1+Alarm×1 — 조치. (알람 코드마다 별도 원소. VRCS_ERR, LOG_OVERFLOW도 동일. 알람 없으면 원소 1개: "[알람없음] 이상 알람 없음.")
- 마지막 원소: [종합] 핵심 문제 1~2문장 요약 및 권고사항.

- 반드시 구체적 숫자 포함: 운전 횟수, TRO 평균값(ppm), 주요 알람 코드 및 발생 건수
- 배출 TRO 0.00ppm에 가까운 것은 정상 중화 결과이므로 문제 삼지 말 것
- 수치 없는 포괄적 서술 금지 ("전반적으로 정상", "문제없이 완료" 등)
- GPS·위치·시간 등 부가 필드 누락 언급 금지. 전체 누락 비율 계산 및 언급 금지.
- TRO 데이터가 null(미수신)이고 operations 배열에 실제 운전 항목이 있는 경우에만: "TRO 미수신 — DataReport 확인 필요." (operations가 빈 배열이면 TRO 미수신 절대 언급 금지 — 운전이 없으니 당연히 TRO 데이터도 없음)
- 100% 한국어 작성 (BWTS, TRO, Alarm, Trip, Code 등 고유명사 제외)
- 알람 코드별 조치 권고:
  * CODE200: CLX 시약 상태 점검 및 샘플링 라인 확인
  * CODE201: 중화제(STS) 주입 펌프 및 탱크 레벨 확인
  * CODE301/302/303: 중화제 탱크 레벨 센서 및 밸브 점검
  * CODE701: PLC 및 모듈 간 통신 케이블 연결 상태 확인
  * CODE721: 해당 밸브 공압 상태 및 리미트 스위치 점검
  * VRCS_ERR: 밸브 채터링(Chattering) 감지 — [긴급] 공압 라인·리미트 스위치 즉각 점검
  * LOG_OVERFLOW: Event Log 100건 초과 — 전체 로그 상세 검토 권고

예시:
["[운전 현황] 주입 3회 / 배출 2회. 주입 TRO 6.2ppm(정상 충족). 배출 TRO 0.02ppm(IMO 기준 충족).", "[ECU] 전류 1250A / 유량 320m³/h — TRO 정상 생성. ANU Ready.", "[CODE200] Alarm×3 — CLX 시약 상태 점검 권장.", "[CODE701] Trip×1+Alarm×1 — PLC 통신 케이블 연결 상태 확인 권장.", "[종합] 전반적으로 정상 운전. CLX 시약 상태 모니터링 지속 권장."]

[ai_remarks_en 작성 지침]
- ai_remarks와 동일하게 문자열 배열(array)로 반환. 동일 구조를 영어로 작성 (본선 발송 이메일용)
- Example:
["[Operations] 3 ballasting / 2 deballasting. Avg TRO 6.2ppm (within 5~10ppm range). Deballasting TRO 0.02ppm (IMO compliant).", "[CODE200] Alarm×3 — recommend checking CLX reagent and sampling line.", "[CODE701] Trip×1+Alarm×1 — check PLC communication cable connection.", "[Summary] Overall normal operation. Continue monitoring CLX reagent condition."]

[주의사항]
- 불확실한 경우 CRITICAL보다 WARNING/NORMAL 우선
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
  if (tro.deballasting_max != null && tro.deballasting_max > 0.1)
    notes.push(`배출 TRO 최댓값 ${tro.deballasting_max}ppm — IMO 기준(0.1ppm) 초과, 즉시 확인 필요.`);

  const remarksArr = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
  const remarksEnArr = Array.isArray(data.ai_remarks_en) ? data.ai_remarks_en : [];
  for (const note of notes) {
    if (!remarksArr.some((l) => l.includes(note.slice(0, 12)))) remarksArr.push(note);
    const noteEn =
      note.includes("미달")   ? `Ballasting TRO ${tro.ballasting_avg}ppm — below normal range (5~10ppm), check CLX reagent condition.`
      : note.includes("초과") && note.includes("주입") ? `Ballasting TRO ${tro.ballasting_avg}ppm — exceeds normal range (5~10ppm).`
      : `Deballasting TRO max ${tro.deballasting_max}ppm — exceeds IMO limit (0.1ppm), immediate check required.`;
    if (!remarksEnArr.some((l) => l.includes(String(tro.ballasting_avg ?? tro.deballasting_max))))
      remarksEnArr.push(noteEn);
  }
  data.ai_remarks = remarksArr;
  data.ai_remarks_en = remarksEnArr;
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
  const troDeballastBad = tro.deballasting_max  != null && tro.deballasting_max > 0.1;

  // LOG_OVERFLOW 감지
  const hasLogOverflow = alarms.some((a) => a.code === "LOG_OVERFLOW");

  // TRO null → 실제 운전이 있었을 때만 WARNING (운전 없는 달은 제외)
  const ops          = data.operations || [];
  const hadBallast   = ops.some((o) => /BALLAST/i.test(o.operation_mode || "") && !/DE/i.test(o.operation_mode || ""));
  const hadDeballast = ops.some((o) => /DEBALLAST/i.test(o.operation_mode || ""));
  const troAllNull   = (hadBallast   && tro.ballasting_avg   == null)
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
    // Invalid Date 또는 날짜가 다르면(예: 2026-02-29 → 3월 1일로 밀림) 오류
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== op.date) {
      invalid.push(op.date);
      op.date = null; // null 처리
    }
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

// ── ai_remarks 비어있을 때 기본 요약 자동 생성 ────────────────
function autoFillRemarks(data) {
  // 배열이면 원소가 1개 이상이어야 스킵, 문자열이면 20자 이상이어야 스킵
  const hasContent = Array.isArray(data.ai_remarks)
    ? data.ai_remarks.length > 0
    : (data.ai_remarks && data.ai_remarks.length > 20);
  if (hasContent) return;

  const ops            = data.operations || [];
  const ballastCount   = ops.filter((o) => (o.operation_mode || "").includes("BALLAST") && !o.operation_mode.includes("DE")).length;
  const deballastCount = ops.filter((o) => o.operation_mode === "DEBALLAST").length;
  const tro            = data.tro_data || {};
  const alarmCount     = (data.error_alarms || []).length;

  const parts   = [];
  const partsEn = [];

  if (ballastCount || deballastCount) {
    parts.push(`당월 주입 ${ballastCount}회 / 배출 ${deballastCount}회 운전.`);
    partsEn.push(`This month: ${ballastCount} ballasting / ${deballastCount} deballasting operations.`);
  } else {
    parts.push("당월 운전 기록이 없습니다.");
    partsEn.push("No ballasting/deballasting operations recorded this month.");
  }
  if (tro.ballasting_avg != null) {
    parts.push(`주입 평균 TRO ${tro.ballasting_avg}ppm.`);
    partsEn.push(`Avg ballasting TRO ${tro.ballasting_avg}ppm.`);
  }
  if (tro.deballasting_max != null) {
    parts.push(`배출 TRO 최댓값 ${tro.deballasting_max}ppm.`);
    partsEn.push(`Max deballasting TRO ${tro.deballasting_max}ppm.`);
  }
  if (alarmCount > 0) {
    parts.push(`알람/에러 ${alarmCount}건 발생.`);
    partsEn.push(`Alarms/errors: ${alarmCount} occurrences.`);
  } else if (alarmCount === 0 && ops.length > 0) {
    parts.push("알람/에러 없음.");
    partsEn.push("No alarms/errors.");
  }

  if (parts.length > 0) {
    data.ai_remarks    = parts;   // 배열로 저장
    data.ai_remarks_en = partsEn;
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
    const arr = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
    if (!arr.some((l) => l.includes("비정상 수치"))) arr.push(note);
    data.ai_remarks = arr;
  }
  if (tro.deballasting_max != null && tro.deballasting_max > 100) {
    const val = tro.deballasting_max;
    tro.deballasting_max = null;
    const note = `배출 TRO 최댓값 ${val}ppm — 비정상 수치(센서 오류 또는 단위 오류 의심). 재확인 필요.`;
    const arr = Array.isArray(data.ai_remarks) ? data.ai_remarks : [];
    if (!arr.some((l) => l.includes("비정상 수치"))) arr.push(note);
    data.ai_remarks = arr;
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
const SECTION_DISCOVERY_PROMPT = `
이 PDF에서 Report List(목차)를 찾아 각 섹션의 시작 페이지 번호를 JSON으로만 반환하세요.
JSON 외 텍스트 절대 금지.

[찾아야 할 섹션]
- Operation Event Log (또는 Event Log) → event_log_start
- ECS Operation Time (또는 Operation Time Log) → op_time_start
- ECS DATA LOG (또는 Data Log) → data_log_start
- Total (전체 페이지 수) → total_pages

[Report List 예시]
Report List
- Operation Event Log -- 2
- Operation Time Log -- 2635
- Data Log -- 2637
- Total -- 2664

위 형식처럼 "--" 뒤의 숫자가 시작 페이지입니다.
확인 불가 시 null.

{"event_log_start":<숫자 또는 null>, "op_time_start":<숫자 또는 null>, "data_log_start":<숫자 또는 null>, "total_pages":<숫자 또는 null>}
`.trim();

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

export async function analyzePdfFromDrive(files, accessToken, vessel = {}) {
  const normalizedFiles = Array.isArray(files)
    ? files.map(f => typeof f === "string" ? { id: f, name: "" } : f)
    : [typeof files === "string" ? { id: files, name: "" } : files];

  const ids = normalizedFiles.map(f => f.id);

  // 파일명 기반 TOTAL LOG 사전 판단 (페이지 수 확인 전)
  const isTotalByName = normalizedFiles.some(f =>
    /TOTAL|TOTAL[\s_]LOG|DATA[\s_]LOG/i.test(f.name || "")
  );

  // ── TOTAL LOG 감지: 캐시 없는 파일 다운로드 후 페이지 수 확인 ──
  const preloadedBlobs = new Map(); // fileId → blob (재다운로드 방지)
  let totalLogExtraction = null;   // TOTAL LOG 텍스트 추출 결과
  let totalLogFileId     = null;
  let totalLogError      = null;   // extractTotalLogText 실패 시 에러 메시지

  for (const id of ids) {
    const cached = _fileUriCache.get(id);
    if (cached && Date.now() - cached.uploadedAt < FILES_EXPIRE_MS) continue;

    const blob = await downloadDriveFile(id, accessToken);
    const { PDFDocument } = await import("pdf-lib");
    const pageCount = (await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true })).getPageCount();

    if ((isTotalByName || pageCount > TOTAL_LOG_THRESHOLD) && !totalLogExtraction) {
      // TOTAL LOG → pdf.js 텍스트 추출 경로
      console.log(`[TOTAL LOG 감지] ${id}: ${pageCount}p → pdf.js 텍스트 추출 경로`);
      try {
        totalLogExtraction = await extractTotalLogText(blob);
        totalLogFileId     = id;
      } catch (e) {
        totalLogError = e.message;
        console.warn("[TOTAL LOG] pdf.js 추출 실패, 일반 경로 fallback:", e.message);
        preloadedBlobs.set(id, blob);
      }
    } else {
      preloadedBlobs.set(id, blob);
    }
  }

  // ── 분기: TOTAL LOG 텍스트 경로 vs 일반 PDF URI 경로 ──────────
  let extractionParts;
  let uris = [];
  let splitInfo = null;

  if (totalLogExtraction) {
    // TOTAL LOG: 텍스트 기반 프롬프트 (PDF 첨부 없음)
    const { text, totalPages, sections } = totalLogExtraction;
    splitInfo = { totalPages, wasSplit: true, isTotalLog: true, sections };
    extractionParts = [{ text: EXTRACTION_PROMPT_TOTALLOG(vessel, text, totalPages, sections) }];
    console.log(`[Stage 1] TOTAL LOG 텍스트 모드: ${text.length}자`);
  } else {
    // 일반 PDF: 기존 URI 업로드 경로
    uris = await Promise.all(ids.map((id) => getOrUploadFileUri(id, accessToken, preloadedBlobs.get(id))));
    splitInfo = ids.reduce((acc, id) => {
      const c = _fileUriCache.get(id);
      if (c?.wasSplit) acc = { totalPages: c.totalPages, extractedPages: c.extractedPages, wasSplit: true, splitSections: c.splitSections };
      return acc;
    }, null);
    extractionParts = [
      { text: EXTRACTION_PROMPT(vessel, splitInfo) },
      ...uris.map((uri) => ({ fileData: { mimeType: "application/pdf", fileUri: uri } })),
    ];
  }

  const makeExtractionParts = (uriList) => [
    { text: EXTRACTION_PROMPT(vessel, splitInfo) },
    ...uriList.map((uri) => ({ fileData: { mimeType: "application/pdf", fileUri: uri } })),
  ];

  // 3. 전체 실패 시 개별 시도 fallback 조건 (일반 경로 전용)
  const shouldFallback = (e) =>
    uris.length > 1 && (
      e.message.includes("exceeds") ||
      e.message.includes("500") ||
      e.message.includes("파싱 실패") ||
      e.name === "AbortError" ||
      e.message.includes("aborted")
    );

  // Stage 1: 데이터 추출
  let extracted;
  try {
    extracted = await callGeminiRaw(extractionParts, 3, STAGE1_RESPONSE_SCHEMA);
  } catch (err) {
    if (!shouldFallback(err)) throw err;
    // 일반 PDF 경로에서만 개별 시도 fallback
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
    if (!extracted) {
      const pageNote = splitInfo?.totalPages
        ? `원본 ${splitInfo.totalPages}페이지 TOTAL LOG — 페이지 과다로 자동 분할 후에도 분석 실패. 파일을 섹션별로 분리하여 재업로드해주세요.`
        : "PDF 페이지 과다 또는 파일 오류로 분析 불가. 파일을 섹션별로 분리하여 재업로드해주세요.";
      return validateAndNormalizeResult({
        vessel_name: vessel.name || null,
        period: null,
        operations: [],
        tro_data: { ballasting_avg: null, deballasting_max: null },
        error_alarms: [],
        overall_status: "WARNING",
        ai_remarks: [pageNote],
        ai_remarks_en: [splitInfo?.totalPages
          ? `Original ${splitInfo.totalPages}-page TOTAL LOG — analysis failed even after auto-split. Please upload sections as separate files.`
          : "PDF too large or file error — analysis unavailable. Please upload sections as separate files."],
      });
    }
  }

  // Stage 0 오버라이드 (프로그래밍 파싱이 AI보다 정확)
  // AI 추출 결과 스냅샷 (진단 패널용 — 병합 전 보존)
  const _aiTroSnapshot = extracted.tro_data ? { ...extracted.tro_data } : null;

  if (totalLogExtraction?.stage0) {
    const s0 = totalLogExtraction.stage0;
    if (s0.operations !== null) {
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
            description: `Valve Opened/Closed 반복 오작동 감지 [${valve}]`,
            level:       'Warning',
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

  // 진단 패널용 _debug 조립 (관리자 전용 표시 — 항상 기록)
  extracted._debug = totalLogExtraction ? {
    totalPages:    totalLogExtraction.totalPages,
    isTotalReport: totalLogExtraction.isTotalReport ?? false,
    sections:      totalLogExtraction.sections,
    headerText:    totalLogExtraction.headerText ?? null,
    stage0RawTro:  totalLogExtraction.stage0?.tro_data ?? null,
    aiTroData:     _aiTroSnapshot,
  } : {
    totalLogFailed: true,
    totalLogError:  totalLogError ?? "알 수 없는 오류",
  };

  // Stage 2: 분析/판정/remarks (JSON만, PDF 없음)
  const analysisParts = [{ text: ANALYSIS_PROMPT(vessel, extracted) }];
  let analyzed;
  try {
    analyzed = await callGeminiRaw(analysisParts, 3, STAGE2_RESPONSE_SCHEMA);
  } catch (err) {
    console.warn("Stage 2 실패, 기본값으로 후처리 진행:", err.message);
    analyzed = { overall_status: null, ai_remarks: "", ai_remarks_en: "" };
  }

  // Stage 1 + Stage 2 결합 후 후처리 (TOTAL LOG sections 전달)
  const sections = totalLogExtraction?.sections ?? null;
  return validateAndNormalizeResult({ ...extracted, ...analyzed }, sections);
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
