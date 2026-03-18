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
 * @param {string} finalRemark
 * @param {"ko"|"en"} lang - 메일 언어 (기본 "ko")
 */
export function buildMailBody(vessel, analysisResult, finalRemark, lang = "ko") {
  const { vessel_name, period, overall_status, error_alarms, ai_remarks, ai_remarks_en } = analysisResult;
  const grouped = groupAlarmsByCode(error_alarms);
  const alarmLines = grouped.length > 0
    ? grouped.map(formatAlarmLine).join("\n")
    : (lang === "en" ? "  - None" : "  - 없음");

  const statusMap = { NORMAL: lang === "en" ? "NORMAL" : "정상",
                      WARNING: lang === "en" ? "WARNING" : "주의",
                      CRITICAL: lang === "en" ? "CRITICAL" : "이상" };
  const statusLabel = statusMap[overall_status] || overall_status || "-";
  const shipName = vessel_name || vessel.name || "-";
  const sep = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  if (lang === "en") {
    return `Dear Sir/Madam,

Please find below the BWTS operation log analysis report for ${shipName} (${period}).

${sep}
■ Analysis Result : ${statusLabel}
${sep}

▶ AI Summary
${ai_remarks_en || ai_remarks || "-"}

▶ Alarm / Error Summary (grouped by code)
${alarmLines}

▶ Technical Review (operator remarks)
${finalRemark || "-"}

${sep}
Kindly review the above findings and advise on any corrective actions taken or planned.

Best regards,
BWTS Management Team`;
  }

  return `안녕하세요,

${shipName} 선박의 ${period} BWTS 운전 로그 검토 결과를 아래와 같이 전달드립니다.

${sep}
■ 분석 기간 : ${period}
■ 분석 결과 : ${statusLabel}
${sep}

▶ AI 분석 요약
${ai_remarks || "-"}

▶ 알람/에러 요약 (코드별)
${alarmLines}

▶ 담당자 검토 의견
${finalRemark || "-"}

${sep}
위 사항을 확인하시고 조치 결과를 회신하여 주시기 바랍니다.

감사합니다.
BWTS 관리 담당자 드림`;
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
