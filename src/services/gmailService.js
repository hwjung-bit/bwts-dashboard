// ============================================================
//  gmailService.js
//  Gmail API를 통한 문제 선박 자동 메일 발송
// ============================================================

const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

// ── 알람 그룹화 헬퍼 ────────────────────────────────────────
function normalizeDesc(desc) {
  return (desc ?? "").replace(/\s*[\[\(]\d[\d.]*[\]\)]/g, "").trim();
}

function groupAlarmsByCode(alarms) {
  const map = new Map();
  for (const a of alarms ?? []) {
    const base = normalizeDesc(a.description);
    const key  = `${a.code ?? ""}|${base}`;
    if (!map.has(key)) {
      map.set(key, { code: a.code, description: base, trip: 0, alarm: 0, warning: 0 });
    }
    const g = map.get(key);
    const lv = (a.level ?? "").toLowerCase();
    if (lv === "trip")         g.trip++;
    else if (lv === "warning") g.warning++;
    else                       g.alarm++;
  }
  return Array.from(map.values())
    .sort((a, b) => (b.trip - a.trip) || (b.alarm - a.alarm));
}

function formatAlarmLine(g) {
  const cnt = [];
  if (g.trip)    cnt.push(`TRIP×${g.trip}`);
  if (g.alarm)   cnt.push(`Alarm×${g.alarm}`);
  if (g.warning) cnt.push(`Warning×${g.warning}`);
  const code = g.code ? `[${g.code}]` : "";
  return `  ${(code + " " + g.description).padEnd(52)} ${cnt.join(" / ")}`;
}

/**
 * 메일 본문 자동 생성
 * @param {Object} vessel
 * @param {Object} analysisResult
 * @param {string} finalRemark  - 담당자 검토 메모 (brief)
 * @param {"ko"|"en"} lang
 */
export function buildMailBody(vessel, analysisResult, finalRemark, lang = "ko") {
  const { vessel_name, period, overall_status, error_alarms, ai_remarks, ai_remarks_en } = analysisResult;
  const grouped  = groupAlarmsByCode(error_alarms ?? []);
  const shipName = vessel_name || vessel?.name || "-";

  const remarksArr   = Array.isArray(ai_remarks)    ? ai_remarks    : (ai_remarks    ? [String(ai_remarks)]    : []);
  const remarksEnArr = Array.isArray(ai_remarks_en) ? ai_remarks_en : (ai_remarks_en ? [String(ai_remarks_en)] : []);

  // ── 운전 현황 한 줄 추출 ───────────────────────────────────
  function getOpsLine(arr) {
    const l = arr.find(r => /^\[(운전 현황|Operations)\]/i.test(r));
    return l ? l.replace(/^\[[^\]]+\]\s*/, "") : null;
  }

  // ── 알람 테이블 (가독성 최우선, 짧게) ─────────────────────
  function buildAlarmTable() {
    if (grouped.length === 0) return lang === "en" ? "  (None)" : "  (없음)";
    const rows = grouped.map(g => {
      const cnt = [
        g.trip    ? `Trip×${g.trip}`    : "",
        g.alarm   ? `Alarm×${g.alarm}`  : "",
        g.warning ? `Warn×${g.warning}` : "",
      ].filter(Boolean).join(" / ");
      const code = (g.code || "-").padEnd(11);
      const desc = (g.description || "").replace(/\s*\(\s*×\d+회?\s*\)/g, "").substring(0, 38).padEnd(40);
      return `  ${code} ${desc} ${cnt}`;
    });
    const hdr = lang === "en"
      ? "  Code        Description                              Count"
      : "  코드         내용                                      수준/횟수";
    return [hdr, "  " + "─".repeat(62), ...rows].join("\n");
  }

  // ── 조치 요청 (alarm_summary 기반) ─────────────────────────
  const alarmSummary = analysisResult.alarm_summary || [];

  function buildActionItems() {
    const useArr = lang === "en" && remarksEnArr.length > 0 ? remarksEnArr : remarksArr;
    const actions = [];

    // 배출 TRO IMO 초과 여부를 운전 현황에서 별도 추출
    const opsLine = getOpsLine(useArr) || "";
    const troMatch = lang === "en"
      ? opsLine.match(/Deballasting TRO max ([\d.]+)ppm.*exceeded/)
      : opsLine.match(/배출 TRO 최댓값 ([\d.]+)ppm.*초과/);
    if (troMatch) {
      actions.push(lang === "en"
        ? `  1. Deballasting TRO ${troMatch[1]}ppm — exceeds IMO limit (0.1ppm), check neutralization system`
        : `  1. 배출 TRO ${troMatch[1]}ppm — IMO 기준(0.1ppm) 초과 확인 및 중화 시스템 점검 필요`);
    }

    // alarm_summary 기반 카테고리별 조치사항
    if (alarmSummary.length > 0) {
      for (const row of alarmSummary) {
        const label = lang === "en" ? row.labelEn : row.label;
        const action = lang === "en" ? row.actionEn : row.action;
        if (action) {
          const n = actions.length + 1;
          actions.push(`  ${n}. [${label}] ${action}`);
        }
      }
    }

    return actions.length > 0 ? actions.join("\n") : (lang === "en" ? "  · No action required." : "  · 특이 조치사항 없음.");
  }

  // ── 종합 평가 문장 분리 ────────────────────────────────────
  function buildSummaryLines() {
    const useArr = lang === "en" && remarksEnArr.length > 0 ? remarksEnArr : remarksArr;
    const summaryLine = useArr.find(l => /^\[(종합|Summary)\]/i.test(l));
    if (!summaryLine) return lang === "en" ? "  (None)" : "  (없음)";
    const body = summaryLine.replace(/^\[[^\]]+\]\s*/, "");
    const sentences = body.split(/(?<=\.)\s+/).filter(Boolean);
    return sentences.map(s => `  · ${s}`).join("\n");
  }

  // ── 담당자 메모 (길면 100자 요약) ─────────────────────────
  const memoText = finalRemark
    ? (finalRemark.length > 200
        ? finalRemark.substring(0, 200).replace(/\n+/g, " ").trimEnd() + "..."
        : finalRemark)
    : "";

  const statusKo = { NORMAL: "정상", WARNING: "주의", CRITICAL: "이상 ⚠" }[overall_status] || overall_status || "-";
  const statusEn = { NORMAL: "NORMAL", WARNING: "WARNING", CRITICAL: "CRITICAL" }[overall_status] || overall_status || "-";
  const SEP  = "─".repeat(48);
  const SEP2 = "─".repeat(48);

  // ━━━━ 한국어 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (lang !== "en") {
    const opsLine = getOpsLine(remarksArr);
    return `안녕하세요,

${shipName} 선박의 ${period ?? "-"} BWTS 운전 로그 분석 결과입니다.

${SEP}
  선박 : ${shipName}     기간 : ${period ?? "-"}     결과 : ${statusKo}
${SEP}

[발생 알람]
${buildAlarmTable()}

[분석 결과]
  [운전 현황] ${opsLine || "-"}

  [조치 요청]
${buildActionItems()}

  [종합 평가]
${buildSummaryLines()}
${memoText ? `\n[담당자 메모]\n  ${memoText}\n` : ""}
${SEP2}
위 사항 확인 후 조치 결과를 회신해 주시기 바랍니다.
감사합니다.
BWTS 관리 담당자`;
  }

  // ━━━━ English ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const opsLineEn = getOpsLine(remarksEnArr.length > 0 ? remarksEnArr : remarksArr);
  return `Dear Sir/Madam,

Please find the BWTS operation log analysis for ${shipName} (${period ?? "-"}).

${SEP}
  Vessel : ${shipName}     Period : ${period ?? "-"}     Result : ${statusEn}
${SEP}

[ALARM SUMMARY]
${buildAlarmTable()}

[ANALYSIS RESULTS]
  [Operations] ${opsLineEn || "-"}

  [Actions Required]
${buildActionItems()}

  [Summary]
${buildSummaryLines()}
${memoText ? `\n[OPERATOR MEMO]\n  ${memoText}\n` : ""}
${SEP2}
Please reply with corrective actions taken or planned.

Best regards,
BWTS Management Team`;
}

/**
 * RFC 2822 형식으로 메일 인코딩
 */
function encodeEmail({ to, subject, body, from }) {
  const lines = [];
  if (from) lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  const message = [
    ...lines,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    btoa(unescape(encodeURIComponent(body))),
  ].join("\r\n");

  // URL-safe Base64
  return btoa(unescape(encodeURIComponent(message)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Gmail 메일 발송
 *
 * @param {Object} params
 * @param {string} params.to          - 수신자 이메일
 * @param {string} params.subject     - 제목
 * @param {string} params.body        - 본문 (plain text)
 * @param {string} params.accessToken - OAuth 액세스 토큰
 * @returns {Object} Gmail API 응답
 */
export async function sendMail({ to, subject, body, accessToken }) {
  // Gmail API는 From 헤더 없어도 인증된 계정으로 자동 발송
  const raw = encodeEmail({ to, subject, body, from: "" });

  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const status = res.status;
    if (status === 401 || status === 403) {
      throw new Error("Gmail 권한 없음 — 로그아웃 후 다시 로그인하면 Gmail 발송 권한을 허용해주세요.");
    }
    throw new Error(`Gmail 발송 실패: ${err?.error?.message || res.statusText}`);
  }

  return await res.json();
}

/**
 * 메일 제목 자동 생성
 */
export function buildMailSubject(vessel, period, status, lang = "ko") {
  const name = vessel?.name || "";
  if (lang === "en") {
    const label = { NORMAL: "Normal", WARNING: "Warning", CRITICAL: "Critical" }[status] || status;
    return `[BWTS Report] ${name} - ${period} Operation Log Analysis (${label})`;
  }
  const label = { NORMAL: "정상", WARNING: "주의", CRITICAL: "이상" }[status] || status;
  return `[BWTS 점검] ${name} - ${period} 운전 로그 분석 결과 (${label})`;
}
