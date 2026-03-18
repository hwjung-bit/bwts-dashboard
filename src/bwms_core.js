/**
 * ============================================================
 *  TECHCROSS BWMS (ECS) 자동 점검 통합 모듈
 *  bwms_core.js
 *
 *  [구성]
 *  1. BWMS_CONFIG  - 센서 임계값 및 알람 코드 정의
 *  2. analyzeBwmsSession() - 시간대별 운전 상태 판별 함수
 *
 *  [사용법]
 *  import { BWMS_CONFIG, analyzeBwmsSession } from './bwms_core.js';
 *  또는 HTML <script type="module"> 내에서 동일하게 import
 * ============================================================
 */


// ============================================================
// SECTION 1 : CONFIG
// 기준 수치 및 알람 코드 환경설정
// ============================================================

/**
 * TECHCROSS BWMS (ECS) 자동 점검을 위한 장비 기준 데이터 설정 (Config)
 * BWRB 내용 제외. 순수 장비 상태 판별용 임계값(Threshold) 및 알람 정의
 */
const BWMS_CONFIG = {

  // ----------------------------------------------------------
  // 1. 센서 및 장비 정상 작동 기준치 (Thresholds)
  // ----------------------------------------------------------
  SENSOR_THRESHOLDS: {
    TRO: {
      BALLASTING_MIN:    5.0,   // 주입 시 최소 TRO 생성 목표치 (ppm)
      BALLASTING_MAX:   10.0,   // 주입 시 최대 TRO 생성 목표치 (ppm)
      DEBALLASTING_IMO:  0.1,   // 배출 시 IMO  기준 중화 목표치 (ppm 미만)
      DEBALLASTING_USCG: 0.07   // 배출 시 USCG 기준 중화 목표치 (ppm 미만)
    },
    GDS: {
      MAX_LEL: 25.0   // 수소 가스 감지기 최대 허용치 (% LEL)
    },
    CSU: {
      MIN:   2.0,     // 해수 전도도 최소 (mS/cm) - 전기분해 가능 하한선
      MAX: 200.0      // 해수 전도도 최대 (mS/cm)
    },
    FTS: {
      MAX: 43.0       // 냉각수 온도 최대치 (°C)
    },
    STS: {
      MAX: 25.0       // 일반적인 해수 온도 최대치 (°C)
    }
  },

  // ----------------------------------------------------------
  // 2. 주요 에러/알람 코드 분류 (Event Log 분석용)
  // ----------------------------------------------------------
  ALARM_CODES: {

    // ECU / PRU (전기분해 / 정류기) 관련
    ECU_PRU: [
      { code: 100, desc: "Current Different Error",  type: "CRITICAL" },
      { code: 101, desc: "P.S Pressure High",        type: "CRITICAL" },
      { code: 102, desc: "T.S Temperature High",     type: "CRITICAL" },
      { code: 103, desc: "No Load Fail",             type: "CRITICAL" }
    ],

    // TSU / CLX (TRO 농도 측정) 관련
    TSU_CLX: [
      { code: 200, desc: "TRO Concentration Low (Sampling issue)",    type: "WARNING"  },
      { code: 201, desc: "TRO Concentration High (Deballasting issue)",type: "CRITICAL" },
      { code: 202, desc: "CLX Sensor Power Fail",                     type: "CRITICAL" },
      { code: 210, desc: "CLX Communication Fail",                    type: "CRITICAL" }
    ],

    // PDE (전원 분배) 관련
    PDE: [
      { code: 402, desc: "MC Fail (Command Mismatch)", type: "CRITICAL" }
    ],

    // FTU (필터) 관련 - 수질 악조건(CWQ) 파악 시 중요
    FTU: [
      { code: 500, desc: "Filter Choked / High Diff Pressure", type: "CWQ_TRIGGER" }
    ]
  }
};


// ============================================================
// SECTION 2 : ANALYZER
// 상황별 로그 교차 검증 알고리즘
// ============================================================

/**
 * 시간대별 로그(OPTIME, EVENT, DATA)를 취합하여 장비 운전 상태를 판별하는 함수
 *
 * @param {Object} session - 특정 시간대의 취합된 로그 데이터
 *   {
 *     opTime : { operation: 'Ballast' | 'Deballast' | 'None' | null },
 *     events : [{ level, code, desc }],
 *     data   : { tro: number, gds: number, csu: number, fts: number }
 *   }
 *
 * @returns {Object}
 *   {
 *     operationStatus : string,   // 판별된 운전 상태
 *     alarms          : Array,    // 감지된 알람/에러 목록
 *     remarks         : string    // 상세 코멘트 (담당자 검토 참고용)
 *   }
 */
function analyzeBwmsSession(session) {
  const { opTime, events, data } = session;
  const config = BWMS_CONFIG.SENSOR_THRESHOLDS;

  let result = {
    operationStatus: "UNKNOWN",
    alarms: [],
    remarks: ""
  };

  // ── 가드: events / data 누락 방어 ──────────────────────────
  const safeEvents = Array.isArray(events) ? events : [];
  const safeData   = data ?? {};

  // ── 0. 추가 센서 이상 감지 (GDS / CSU / FTS) ───────────────
  //    알람 코드와 무관하게 수치 자체가 임계값을 벗어난 경우 선제 감지
  const sensorWarnings = [];

  if (safeData.gds !== undefined && safeData.gds > config.GDS.MAX_LEL) {
    sensorWarnings.push(
      `GDS 수소 가스 농도 초과 (현재: ${safeData.gds}% LEL / 허용: ${config.GDS.MAX_LEL}% LEL 이하)`
    );
  }
  if (safeData.csu !== undefined &&
      (safeData.csu < config.CSU.MIN || safeData.csu > config.CSU.MAX)) {
    sensorWarnings.push(
      `CSU 해수 전도도 범위 이탈 (현재: ${safeData.csu} mS/cm / 정상: ${config.CSU.MIN}~${config.CSU.MAX})`
    );
  }
  if (safeData.fts !== undefined && safeData.fts > config.FTS.MAX) {
    sensorWarnings.push(
      `FTS 냉각수 온도 초과 (현재: ${safeData.fts}°C / 허용: ${config.FTS.MAX}°C 이하)`
    );
  }

  // ── 1. 이벤트 로그 내 알람 및 에러 확인 ───────────────────
  //    가장 최우선으로 시스템 고장 판별
  const criticalAlarms = safeEvents.filter(
    e => e.level === "Alarm" || e.level === "Trip"
  );

  if (criticalAlarms.length > 0) {
    result.alarms = criticalAlarms;

    // 수질 악조건(CWQ)에 의한 바이패스 여부 확인
    // (필터 막힘 + 바이패스 밸브 오픈)
    const isCWQ    = safeEvents.some(
      e => e.code === 500 || (e.desc && e.desc.includes("Filter choked"))
    );
    const isBypass = safeEvents.some(
      e => e.desc && e.desc.includes("Bypass Valve Opened")
    );

    if (isCWQ && isBypass) {
      result.operationStatus = "CWQ Bypass Operation";
      result.remarks = "수질 악조건(CWQ)으로 인한 필터 차압 발생 및 우회(Bypass) 운전 감지.";
      if (sensorWarnings.length > 0) {
        result.remarks += " | 추가 센서 경고: " + sensorWarnings.join("; ");
      }
      return result;
    }

    result.operationStatus = "System Failure";
    result.remarks = "장비 고장(Alarm/Trip) 감지. 장비 점검 및 조치 내역 확인 필요.";
    if (sensorWarnings.length > 0) {
      result.remarks += " | 추가 센서 경고: " + sensorWarnings.join("; ");
    }
    return result;
  }

  // ── 2. 주입 (Ballasting) 정상 여부 판별 ───────────────────
  if (opTime && opTime.operation === "Ballast") {
    const isValvesOpen = safeEvents.some(
      e => e.desc && e.desc.includes("INLET VALVE OPEN")
    );
    const isTRONormal  =
      safeData.tro >= config.TRO.BALLASTING_MIN &&
      safeData.tro <= config.TRO.BALLASTING_MAX;

    if (isValvesOpen && isTRONormal) {
      result.operationStatus = "Normal Ballasting";
      result.remarks = `정상 주입 완료 (밸브 정상 작동 및 TRO ${safeData.tro}ppm 생성 확인).`;
    } else if (!isTRONormal) {
      result.operationStatus = "Abnormal Ballasting";
      result.remarks = `주입 중 TRO 생성 수치 이상 (현재: ${safeData.tro}ppm / 정상범위: ${config.TRO.BALLASTING_MIN}~${config.TRO.BALLASTING_MAX}ppm).`;
    }
  }

  // ── 3. 배출 (De-ballasting) 정상 여부 판별 ────────────────
  else if (opTime && opTime.operation === "Deballast") {
    const isANUWorking    = safeEvents.some(
      e => e.desc && e.desc.includes("ANU Device Work")
    );
    const isOverboardOpen = safeEvents.some(
      e => e.desc && e.desc.includes("OVERBOARD VALVE OPEN")
    );

    // ※ 적용 해역에 따라 기준 전환 가능 (현재: IMO 기준 적용)
    //   USCG 해역 적용 시: config.TRO.DEBALLASTING_USCG 로 변경
    const isTRODischarged = safeData.tro < config.TRO.DEBALLASTING_IMO;

    if (isANUWorking && isOverboardOpen && isTRODischarged) {
      result.operationStatus = "Normal De-ballasting";
      result.remarks = `정상 배출 완료 (ANU 작동 및 TRO ${safeData.tro}ppm으로 IMO 기준치 이하 중화 확인).`;
    } else if (!isTRODischarged) {
      result.operationStatus = "Abnormal De-ballasting";
      result.remarks = `배출 중 TRO 중화 불량 감지 (현재: ${safeData.tro}ppm / IMO 기준: ${config.TRO.DEBALLASTING_IMO}ppm 미만).`;
    }
  }

  // ── 4. 내부 이송 및 자체 순환 판별 ───────────────────────
  //    Internal Circulation / Tank to Tank
  else if (!opTime || !opTime.operation || opTime.operation === "None") {
    const isOverboardOpen = safeEvents.some(
      e => e.desc && e.desc.includes("OVERBOARD VALVE OPEN")
    );
    const isPumpRunning   = safeEvents.some(
      e => e.desc && e.desc.includes("Pump Start")
    );
    const isTSUWorking    = safeEvents.some(
      e => e.desc && e.desc.includes("TSU Device Work")
    );

    if (!isOverboardOpen && isPumpRunning) {
      if (isTSUWorking) {
        result.operationStatus = "Internal Circulation (Treated)";
        result.remarks = "외부 배출 없는 탱크 내 자체 순환 및 처리(Treatment) 감지.";
      } else {
        result.operationStatus = "Tank to Tank Transfer";
        result.remarks = "복원성 조절 등을 위한 탱크 간 단순 이송 감지 (처리 장치 미가동).";
      }
    }
  }

  // ── 5. 작업 이력 없음 ─────────────────────────────────────
  if (result.operationStatus === "UNKNOWN" &&
      (!opTime || !opTime.operation) &&
      safeEvents.length === 0) {
    result.operationStatus = "No Operation";
    result.remarks = "해당 기간 내 BWMS 가동 이력 없음.";
  }

  // ── 공통: 센서 경고 추가 (이미 CRITICAL로 early-return 된 경우 제외) ──
  if (sensorWarnings.length > 0 && result.remarks) {
    result.remarks += " | 센서 경고: " + sensorWarnings.join("; ");
  }

  return result;
}


// ============================================================
// EXPORT
// ============================================================
export { BWMS_CONFIG, analyzeBwmsSession };
