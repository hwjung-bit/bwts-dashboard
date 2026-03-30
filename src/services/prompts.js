// ============================================================
//  prompts.js
//  Gemini API 프롬프트 및 스키마 정의
//  (geminiService.js에서 분리 — 프롬프트 교체 시 이 파일만 수정)
// ============================================================

// ── Stage 1 추출 스키마 (텍스트 — 프롬프트에 포함) ────────────
export const STAGE1_TEXT_SCHEMA = `{
  "vessel_name": "선박명",
  "imo_number": "IMO 번호 (없으면 null)",
  "period": "분析 기간 (YYYY-MM)",
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
export const STAGE1_RESPONSE_SCHEMA = {
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
export const STAGE2_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    overall_status: { type: "string", enum: ["NORMAL", "WARNING", "CRITICAL"] },
    ai_remarks:     { type: "array", items: { type: "string" } },
    ai_remarks_en:  { type: "array", items: { type: "string" } },
  },
  required: ["overall_status", "ai_remarks", "ai_remarks_en"],
};

// ── Stage 1: 데이터 추출 전용 프롬프트 ──────────────────────
export const EXTRACTION_PROMPT = (vessel = {}, splitInfo = null) => `
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
export const EXTRACTION_PROMPT_TOTALLOG = (vessel = {}, extractedText = "", totalPages = 0, sections = null) => `
당신은 Techcross ECS BWTS(선박평형수처리장치) 로그 데이터 파싱 전문가입니다.
아래 텍스트는 TOTAL LOG PDF(원본 ${totalPages}페이지)에서 추출한 내용입니다.
숫자·날짜·코드만 있는 그대로 추출하고, 절대 해석하거나 판단하지 마세요.
최종 출력은 JSON 단독. JSON 외 텍스트(설명, 주석, 마크다운 코드블록 포함) 절대 금지.

[장비 정보]
- 선명: ${vessel.name || "미상"}
- BWTS 제조사: Techcross
- BWTS 모델: ECS

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§0. 사전 점검 — 텍스트 수신 즉시 수행
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[P-0] 텍스트 유효성 확인
추출 텍스트 전체 길이가 200자 미만이거나 의미 있는 숫자·날짜가 없으면:
→ {"parse_status":"NO_DATA","reason":"텍스트 부족 — 별도 파일 또는 다른 페이지 확인 필요","vessel":null,"operations":[],"tro":null,"events":[]}
반환 후 즉시 종료.

[P-1] 파일 구조 자동 판별 — 섹션 헤더를 순서 무관하게 탐색
- Operation Time Log 헤더 패턴 (대소문자 무시):
  "ECS Operation Time Log" | "ECS Operation Time" | "Operation Time Record"
  | "BALLAST OPERATION LOG" | "운전시간" | "운전기록" | "Op_Time" | "OPERATION TIME"
  → 발견 위치를 op_section_start로 기록

- Data Log 헤더 패턴:
  "ECS Data Log" | "ECS DATA" | "Data Report" | "DataReport" | "DATA LOG"
  → 판별 조건: "INDEX" + "TIME" 패턴 필수. 발견 위치를 data_section_start로 기록

- Event Log 헤더 패턴:
  "ECS Operation Log Display" | "Operation Event Log" | "Event Log"
  | "EVENT LOG" | "ALARM LOG" | "이벤트로그"

어느 섹션이든 헤더가 없으면 해당 섹션 = null 처리(오류 아님).
변수 ${sections?.op_time_start ?? "?"}, ${sections?.data_log_start ?? "?"}는 힌트일 뿐 — 실제 헤더 위치가 우선.
일부 선박은 파일이 분리됨(Op Time Log 별도 / Data Report 별도 / Event Log 별도) → 입력된 extractedText에서 각 섹션을 독립적으로 탐색.

[P-1-EXT] Data Log OPERATION 컬럼 부재 시 폴백
Data Log에서 OPERATION 컬럼이 없거나 모든 행의 OPERATION값이 공란인 경우:
  Step1: Op Time Log의 각 운전 행 START~END 시간 범위와 Data Log 타임스탬프를 교차 조회하여 모드 역추론.
         예) Op Time Log에서 2025-05-02 00:48~01:04가 BALLAST이면 해당 시간대 Data Log 포인트 → BALLAST 처리.
  Step2: Op Time Log도 없으면 Event Log의 "Ballast Start/Stop", "Deballast Start/Stop" 이벤트로 시간 구간 재구성.
  Step3: 양쪽 모두 없으면 operation="UNKNOWN", tro_mode_inference="failed", 해당 구간 TRO 집계 제외 후 경고 플래그.
  해당 경우 반드시 "operation_column_missing":true 플래그 추가.

[P-2] 헤더 반복 행 제거
페이지 넘김 시 동일 헤더 행(OPERATION, START TIME, END TIME, INDEX, TIME 등 영문 대문자 나열)이 반복 삽입됨.
데이터 파싱 전 이 반복 헤더 행을 모두 제거하고 시작할 것.

단위 표기 행 탐지: 헤더 행 직후에 오는 행이 순수 계측단위만으로 구성된 경우(예: "V A - PSU m³/h °C % ppm ppm ppm")
→ 해당 행은 데이터 행에서 제외하고 unit_map으로 저장.
  예) unit_map["REC1_CURRENT"]="A", unit_map["TRO_B1"]="ppm", unit_map["CSU1"]="PSU"

요약 행 제거: "TOTAL TIME :", "BALLAST TIME :", "DEBALLAST TIME :" 패턴 포함 행은
통계 텍스트이므로 데이터 행에서 제외.

[P-3] 표 깨짐 복원 규칙
PDF 텍스트 추출로 표 구조가 깨져 값이 한 줄 나열된 경우, 아래 패턴으로 컬럼 복원:
- 운전 모드: BALLAST|DEBALLAST|STRIPPING|BYPASS|N-B|N-D|1-B|2-B|1-D|2-D
              EM'CY BYPASS|EMCY BYPASS|EMERGENCY BYPASS
- 날짜시간: \\d{2,4}[-./]\\d{1,2}[-./]\\d{1,2}\\s+\\d{1,2}:\\d{2}(:\\d{2})?
- GPS (구형 포맷): \\d{1,3}°\\d{0,2}[NS]\\s+\\d{1,3}°\\d{0,2}[EW]
  GPS (신형 포맷): \\[\\d{1,3},\\s*\\d{1,2}\\.\\d{2},\\s*[NS]\\]\\[\\d{1,3},\\s*\\d{2}\\.\\d{2},\\s*[EW]\\]
- 러닝타임: \\d{1,3}:\\d{2} (HH:MM)
- VOLUME: 마지막 독립 소수 숫자 (0.00은 null 처리 권고)
예: "BALLAST 2025-05-02 00:48:04 2025-05-02 01:04:10 0:16 [22,27.94,N][113,52.54,E] 162.00"
→ OPERATION=BALLAST, START=2025-05-02 00:48, END=2025-05-02 01:04, RUNNING=0:16, VOLUME=162.00

헤더 없는 표 복원 순서 (위치 기반):
  1순위: 모드 키워드 → OPERATION
  2순위: 첫 번째 날짜시간 → START TIME
  3순위: 두 번째 날짜시간 → END TIME
  4순위: HH:MM(날짜 이후) → RUNNING TIME
  5순위: GPS 패턴 → POSITION
  6순위: 마지막 독립 소수 → VOLUME
  모드 미탐지 시 operation="UNKNOWN", "header_missing":true, 추정 실패 행 → "header_parse_failed_rows":[행번호]

알람 행 복합 처리:
  단일 행에서 [CODExxx] 패턴 2개 이상 → 각각 행 분리, 동일 타임스탬프, "row_split":true
  LEVEL = "Alarm Trip" 또는 "Trip Alarm" → 두 이벤트로 분리, raw_level에 원본 보존

[P-4] 날짜 포맷 처리 — 우선순위 순
내부 표현은 항상 YYYY-MM-DD HH:MM으로 통일:
  ① YYYY-MM-DD HH:MM[:SS]
  ② YYYY-M-D H:MM[:SS] — 한 자리 월/일/시 (예: 2025-5-2 0:48 → 2025-05-02 00:48)
  ③ YY-MM-DD HH:MM[:SS] — 00~30 → 20xx, 31~99 → 19xx
  ④ YYYY.MM.DD HH:MM[:SS]
  ⑤ DD/MM/YYYY HH:MM[:SS] — 앞자리 ≥13이면 DD/MM 확정. 1~12이면 문서 내 다른 날짜 참조 후 불확실하면 date_format_ambiguous:true
  ⑥ 초(SS) 변형 모두 허용
존재하지 않는 날짜 → 해당 행 건너뜀.

시간 역전 행 처리:
  END TIME < START TIME이고 RUNNING TIME=0:00, VOLUME=0.00 → 더미 행, operations에서 제외, "time_reversal_skipped":true
  END TIME < START TIME이고 RUNNING TIME > 0:00 → 포함, "time_reversal_warning":true, 원본값 보존

[P-5] 한글 컬럼명·값 매핑 (구형 장비)
컬럼명: "운전모드"→OPERATION, "시작시간"→START TIME, "종료시간"→END TIME,
        "운전시간"→RUNNING TIME, "처리량"→VOLUME, "위치"→POSITION
모드값: "주입"/"밸러스트"→BALLAST, "배출"/"디밸러스트"/"탈밸러스트"→DEBALLAST,
        "잔류배출"/"스트리핑"→STRIPPING
(컬럼명 매핑은 헤더 행에만, 셀 값 매핑은 데이터 행에만 적용)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§1. BWTS 도메인 상수 — 파싱 판단 기준 (수정 금지)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[D-1] 파라미터별 유효 범위 및 이상 기준
┌────────────────┬───────────────┬───────────────────────────────────┬─────────────────────────────────┐
│ 항목           │ 단위          │ 정상 범위                         │ 이상 기준                       │
├────────────────┼───────────────┼───────────────────────────────────┼─────────────────────────────────┤
│ TRO (전 구간)  │ ppm = mg/L    │ 0 ~ 15 (초과 → TRO 아님)          │ 모드별 상이 (D-2 참조)          │
│ ECU 전류       │ A             │ 100 ~ 4000 (대용량 모델 포함)     │ CODE405: 장비 허용치 초과       │
│ 입력 전압      │ V             │ 396 ~ 484 V (440±10%)             │ CODE407: >506V / CODE406: 저전압│
│ FMU 유량       │ m³/h          │ 양수                              │ CODE605: >110%, CODE606: <15%   │
│ ECU 압력       │ bar           │ 0 ~ 4.5                           │ CODE100: >4.5 bar               │
│ ECU 온도       │ °C            │ 0 ~ 45                            │ CODE100: >45°C                  │
│ 냉각수 온도    │ °C            │ 0 ~ 38                            │ CODE603: >43°C Alarm, >45 Fault │
│ H2 가스        │ % LEL         │ 0 ~ 100                           │ >25 → Alarm, >50 → Shutdown     │
│ 염도(CSU)      │ PSU 또는 mS/cm│ 0 ~ 40                            │ BALLAST 중 <1.0 → Alarm         │
│ VOLUME         │ m³            │ 양수                              │ 없으면 null (0으로 채우지 말것) │
│ REC1_VOLTAGE   │ 내부 상태코드 │ 1 ~ 8 정수 (장비 내부값)          │ TRO/전압(V)으로 절대 오인 금지  │
│ 해수 온도(S.W) │ °C            │ -2 ~ 35                           │ CODE600: 저온 이상              │
└────────────────┴───────────────┴───────────────────────────────────┴─────────────────────────────────┘

⚠️ ppm = mg/L: 완전히 동일한 단위. 이중 기준 적용 절대 금지.
⚠️ ECU 전류 3,000A 초과(최대 4,000A)는 대용량 모델의 정상 운전값일 수 있음 — 고정 상한선으로 이상 판정 금지.
⚠️ REC1_VOLTAGE = 단일 정수(1~8)이면 전압(V)이 아닌 장비 내부 탭 상태값. TRO 및 전압 계산에서 완전 제외.
⚠️ ECU 압력(0~4.5 bar)과 TRO(0~15 ppm)는 수치 범위 중복 가능 → 컬럼 헤더로만 판별.
⚠️ CSU: unit_map에 "PSU" 명시 시 PSU 처리. 미명시 시 csu_unit_unknown:true, 변환 금지.
⚠️ CODE406(저전압)은 314~316V 등 기준서 임계값(396V)보다 훨씬 낮은 수치에서도 발생 가능 — 고정 임계값 이상 판정 금지, 로그의 LEVEL 필드 우선.

[D-2] TRO 모드별 기준값 — 절대 혼동 금지
┌────────────────────┬──────────────────────────────────┬────────────────────────────────────┐
│ 모드               │ 컬럼 역할                        │ 정상 범위 / 이상 기준              │
├────────────────────┼──────────────────────────────────┼────────────────────────────────────┤
│ BALLAST / N-B      │ TRO_B1, TRO_B2, TRO1, T1, TRO   │ 6~10 ppm 정상                      │
│ Data Log: 1-B      │ (주입 측)                        │ <5 → Low Alarm (CODE200)           │
│                    │                                  │ >10 → High Alarm (CODE201)         │
├────────────────────┼──────────────────────────────────┼────────────────────────────────────┤
│ DEBALLAST / N-D    │ TRO_D1, TRO_S1, TRO2, T2        │ IMO: <=0.1 ppm                     │
│ STRIPPING          │ (배출 측)                        │ USCG: <=0.07 ppm                   │
│ Data Log: 1-D, 1-S │                                  │ >0.1 → Alarm/Fault                 │
└────────────────────┴──────────────────────────────────┴────────────────────────────────────┘

Data Log OPERATION 컬럼 값 매핑:
  "1-B" / "2-B" → BALLAST,  "1-D" / "2-D" → DEBALLAST,  "1-S" / "S" → STRIPPING
  "0" → STOP (TRO 계산 제외)

▸ 필드 배정 규칙 (혼동 절대 금지):
  - ballasting_avg   = BALLAST 구간 TRO 주입값의 산술 평균 (최댓값 아님)
  - deballasting_max = DEBALLAST/STRIPPING 구간 TRO 배출값의 최댓값 (평균 아님)

▸ TRO 알람 판정 우선순위: 로그에 기록된 LEVEL 필드(Trip/Alarm/Warning) 최우선 신뢰.
  고정 수치 임계값은 보조 참고용. 예) CODE201이 0.12에서 Trip, 1.28에서 Alarm 등 동일 코드도 수치별 심각도 다를 수 있음.

▸ TRO Warm-up 유예 구간:
  Ballasting 운전 개시 직후 초기 구간(운전 시작 후 10분 이내 또는 첫 5개 데이터 행)은
  TRO_B1이 0~5 ppm이더라도 Low Alarm 판정 제외. warm_up_excluded:true 플래그 추가.

▸ 음수 TRO: tro 필드 null, tro_sensor_err:true, tro_raw:[원시값]
▸ TRO 단위 누락: 값 추출 후 tro_unit_missing:true. 추정·변환 금지.
▸ TRO 0~1.5 집중 분포 → tro_scale_warning:true (×10 스케일 의심)

[D-3] 운전 모드 전체 목록
- BALLAST, N-B, 1-B, 2-B : TRO 주입 기준 적용
- DEBALLAST, N-D, 1-D, 2-D : TRO 배출 기준 적용
- STRIPPING, 1-S : DEBALLAST와 동일 기준, deballasting_max에 포함
- EM'CY BYPASS, EMCY BYPASS, BYPASS, Emergency : 운전 카운트 제외, TRO 판정 미적용
- STOP, 0 : TRO 계산 제외
- 미지 모드 : operation_mode 원본값 그대로, tro_judgment:"UNKNOWN_MODE"

[D-4] 알람 코드 — 동적 추출 (Whitelist 방식 금지)
알람 코드는 \\[CODE\\d+\\] 정규식으로 모두 추출. 기준서에 없는 코드도 그대로 기록.

알람 코드 형식: [CODE402] 또는 [CODE 402] (공백 유무 혼용) → 동일 처리
CODE100 세부 원인: 설명 문자열 내 괄호/대괄호로 sub-fault 및 대상 모듈 명시됨.
  예) "[CODE100](PRU Fault 50 Percent)[PRU1]" → code:"CODE100", sub_fault:"PRU Fault 50 Percent", module:"PRU1"
  추출 패턴: \\((.*?)\\) 및 \\[(.*?)\\] (CODE 번호 이후 첫 번째 괄호 쌍)

주요 확인 코드 (참고용, 이 목록 외 코드도 추출):
CODE100(ECU EMCY), CODE200(TRO Low), CODE201(TRO High),
CODE301(ANU Level INI), CODE303(ANU Level High),
CODE402(440V MC Fail), CODE405(전류 High), CODE406(전압 Low), CODE407(전압 High),
CODE600(S.W TEMP Low), CODE603(F.W TEMP High),
CODE605(FMU Flow High), CODE606(FMU Flow Low),
CODE701(통신 Fail), CODE703(센서 통신 에러), CODE704(Bypass Valve),
CODE706(EM'CY Mode), CODE731(밸브 이상 종료), CODE774(냉각수 밸브)

ACK.TIME, RESET TIME의 "-" → null 변환

[D-5] Event Log 특수 처리 규칙
① LEVEL = Normal인 비정상 종료:
   DESCRIPTION에 "ECS was terminated in the wrong way" 포함 시 → LEVEL 값과 무관하게
   termination_type:"ABNORMAL", 해당 운전 행을 operations에서 제외 대상으로 플래그.

② 종료 주체 추출:
   DESCRIPTION 끝에 "By ECS-Server" → termination_type:"AUTO"
   "By Abnormal" → termination_type:"ERROR"
   그 외 또는 없음 → termination_type:"MANUAL"

③ CLEARED 컬럼:
   "O" 또는 공란 → 미처리/해당없음 (정상값)
   "X" → 완료/해제됨 (정상값, 오류 아님)

④ DEVICE 컬럼: 사전 목록에 제한 없이 원본값 그대로 추출.
   (VV1~8, PUMP1~2, IV1, OV1, REC1~2, RTU1, AIM1, GDS1, STS1, FW01V 등 모두 유효)

⑤ Operation Time Log 기타 컬럼:
   "Line" 컬럼 (값이 "1" 등 고정값) → 파싱 시 무시 또는 메타데이터로만 저장.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§2. 동적 파싱 원칙
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

선박·장비 옵션에 따라 표의 센서 구성이 달라지므로 열 순서를 고정하거나 추측하지 마세요.
각 표에서 영문 대문자 항목 줄을 기준 헤더로 먼저 파악한 뒤 데이터를 헤더와 짝지으세요.

절대 금지:
- 확인 불가 항목 추측·보정
- 단위 임의 변환
- VOLUME 0.00을 유효 데이터로 집계 (null 처리)
- 로그에 없는 알람 코드 추가 또는 삭제

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
§3. 추출 단계 — 순서 엄수
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Step 1] 기본 정보
선명, IMO 번호, BWTS 제조사/모델, 분석 기간 추출.

[Step 2] ECS Operation Time Log → operations 배열 (최대 30건)
- §0 P-1에서 찾은 op_section_start 기준으로 섹션 파싱
- 컬럼: OPERATION | START TIME | END TIME | RUNNING TIME | POSITION(GPS) | VOLUME
- RUNNING TIME HH:MM → 소수 시간(hour) 변환 (예: 0:34 → 0.57h)
- VOLUME 컬럼 없거나 공란이거나 0.00 → null
- "Line" 컬럼 등 메타 컬럼 무시

⚠️ 운전 횟수 카운트 규칙:
  - 유일한 기준: Operation Time Log 완료 운전 행 (START TIME + END TIME 모두 있는 것)
  - Data Log OPERATION 컬럼 상태값 → 카운트 사용 절대 금지
  - Event Log Start/Stop 이벤트 → 카운트 사용 절대 금지
  - 비정상 종료 (END TIME 없음 또는 "ECS terminated in the wrong way") → 제외
  - EM'CY BYPASS 모드 → 제외
  - 기록 없으면 operations = []

[Step 3] ECS Data Log → tro, ecu_current_avg, fmu_flow_avg, anu_status
- data_section_start 기준 섹션 파싱
- 헤더 행(INDEX TIME OPERATION ...) 먼저 읽어 컬럼 식별
- unit_map 저장 (헤더 직후 단위 행 있을 경우)

TRO 컬럼 식별:
  - 컬럼명에 "TRO" 포함 + 값 0~15 ppm 범위 → TRO 유효
  - 수십~수천 단위(전류/전압) → TRO 절대 오인 금지

TRO 계산:
  - OPERATION 있으면: BALLAST/1-B 행 → ballasting_avg, DEBALLAST/1-D 행 → deballasting_max
  - OPERATION 없으면: [P-1-EXT] 폴백 적용
  - 단속 운전(반복 STOP/START): 전체 BALLAST 행 합산 평균. 10분 미만 단속은 안정 필터 미적용
  - Warm-up 유예 구간(개시 후 10분/5행): ballasting_avg 계산에서 제외
  - 안정 구간 0개 또는 운전 20분 이하 → null

기타:
  - ECU 전류: REC1_CURRENT, REC_I, CURRENT, ECU_I → ecu_current_avg
  - 유량: FMU1, FMU, FLOW (FMU_ST 제외) → fmu_flow_avg
  - ANU: ANU_D1, ANU_S1 → 0=Standby, 양수=Operating → anu_status
  - H2: H2_GAS, H2, GAS_LEL → h2_gas_avg (% LEL)

[Step 4] Operation Event Log → events 배열 (샘플 구간만)
- Trip 전부, 동일 코드 Alarm 최대 5건 (총 60건 이하)
- Normal 레벨 이벤트는 포함하지 않음
  단, DESCRIPTION에 "terminated in the wrong way" 포함 시 LEVEL 무관하게 포함
- VRCS 채터링(특정 밸브 수초 간격 반복) → VRCS_ERR 1건으로 병합
- LOG_OVERFLOW: 총 항목 100건 초과 시 플래그 추가
- Event Log 수백 페이지 이상 → 마지막 100건만 샘플링
- 각 이벤트에 termination_type 및 CLEARED 값 포함 (D-5 규칙 적용)

[확인 불가 항목은 null. 문자열 값에 줄바꿈 포함 금지]

[추출 대상 텍스트]
${extractedText}

${STAGE1_TEXT_SCHEMA}
`.trim();

// ── Stage 2: 분析 판정 전용 프롬프트 ────────────────────────
export const ANALYSIS_PROMPT = (vessel = {}, extractedData = {}) => `
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


export const REMARK_PROMPT_TEMPLATE = (aiResult, operatorNote, lang = "ko") => {
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

// ── 섹션 자동 탐지 프롬프트 (대용량 PDF Report List 파싱) ────
export const SECTION_DISCOVERY_PROMPT = `
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
