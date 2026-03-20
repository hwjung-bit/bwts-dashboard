// VesselTable - 선박 목록 테이블

// 운영 이슈 기반 카테고리
const ISSUE_CATEGORIES = [
  { key: "처리수량",   match: (a) => /FMU|Flow|Volume|유량/i.test((a.code||"")+(a.description||"")) },
  { key: "배출기준",   match: (a) => /Deballass|배출|CODE201/i.test((a.code||"")+(a.description||"")) },
  { key: "TRO생성",    match: (a) => /TRO|Concentration|CODE200/i.test((a.code||"")+(a.description||"")) },
  { key: "ANU중화",    match: (a) => /ANU|Tank\s*Level|Sodium|CODE30[123]/i.test((a.code||"")+(a.description||"")) },
  { key: "Bypass",     match: (a) => /Bypass|EM.?CY/i.test(a.description||"") },
  { key: "센서건전성", match: (a) => /Comm|Sensor|CODE7[02]/i.test((a.code||"")+(a.description||"")) },
  { key: "알람",       match: (a) => a.level === "Alarm" || a.level === "Warning" },
];

// 카테고리 배지 목록 생성 (건수 포함, 제한 없음)
function makeIssueBadges(vessel) {
  const r = vessel.analysisResult;
  if (!r) return null;
  const alarms = r.error_alarms || [];
  if (alarms.length === 0) return [];

  const result = [];
  for (const cat of ISSUE_CATEGORIES) {
    const matched = alarms.filter(cat.match);
    if (matched.length === 0) continue;
    const hasTrip = matched.some((a) => (a.level || "").toLowerCase() === "trip");
    // ×N회 표기에서 실제 건수 합산
    const count = matched.reduce((sum, a) => {
      const m = (a.description || "").match(/×(\d+)회/);
      return sum + (m ? parseInt(m[1]) : 1);
    }, 0);
    result.push({ key: cat.key, hasTrip, count });
  }
  return result;
}

// 종합 판단 아래 요약 한 줄 (Trip/알람 건수)
function makeStatusSummary(vessel) {
  const r = vessel.analysisResult;
  if (!r) return null;
  const alarms = r.error_alarms || [];
  if (alarms.length === 0) return null;

  const tripCount  = alarms.filter((a) => (a.level||"").toLowerCase() === "trip").length;
  const alarmCount = alarms.filter((a) => (a.level||"").toLowerCase() !== "trip").length;
  const parts = [];
  if (tripCount  > 0) parts.push(`Trip ${tripCount}건`);
  if (alarmCount > 0) parts.push(`알람 ${alarmCount}건`);
  return parts.join(" · ") || null;
}

function IssueSummary({ vessel }) {
  const badges = makeIssueBadges(vessel);
  if (badges === null) return <span className="text-slate-300 text-xs">-</span>;
  if (badges.length === 0) return <span className="text-green-600 text-xs font-medium">이상 없음</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <span
          key={b.key}
          className={`text-xs font-medium px-2 py-0.5 rounded-md border ${
            b.hasTrip
              ? "text-red-600 bg-red-50 border-red-200"
              : "text-amber-600 bg-amber-50 border-amber-200"
          }`}
        >
          {b.key}{b.count > 1 ? ` ×${b.count}` : ""}
        </span>
      ))}
    </div>
  );
}

const STATUS_BADGE = {
  CRITICAL: { label: "즉시확인필요", dot: "bg-red-500",    cls: "bg-red-50 text-red-700 border-red-200"         },
  WARNING:  { label: "검토필요",     dot: "bg-amber-400",  cls: "bg-amber-50 text-amber-700 border-amber-200"   },
  NORMAL:   { label: "이상없음",     dot: "bg-green-500",  cls: "bg-green-50 text-green-700 border-green-200"   },
  REVIEWED: { label: "검토완료",     dot: "bg-indigo-500", cls: "bg-indigo-50 text-indigo-700 border-indigo-200"},
  RECEIVED: { label: "수신",         dot: "bg-teal-500",   cls: "bg-teal-50 text-teal-700 border-teal-200"      },
  NO_DATA:  { label: "미수신",       dot: "bg-slate-400",  cls: "bg-slate-50 text-slate-500 border-slate-200"   },
  LOADING:  { label: "분석중",       dot: "bg-blue-500",   cls: "bg-blue-50 text-blue-700 border-blue-200"      },
};

function StatusBadge({ status, summary }) {
  const s = STATUS_BADGE[status] || STATUS_BADGE.NO_DATA;
  return (
    <div className="flex flex-col gap-1">
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border w-fit ${s.cls}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
        {s.label}
      </span>
      {summary && (
        <span className="text-xs text-slate-400 pl-1">{summary}</span>
      )}
    </div>
  );
}

export default function VesselTable({ vessels, selectedVesselId, onSelectVessel, onAnalyze, isAdmin, globalAnalyzing, analyzingVesselId, year, month }) {
  if (vessels.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400 bg-white border border-slate-200 rounded-xl">
        선박 정보가 없습니다. 선박을 추가하거나 분석을 시작하세요.
      </div>
    );
  }

  const yearMonth = year && month ? `${year}-${String(month).padStart(2, "0")}` : "-";

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            <th className="text-left px-3 py-3 text-slate-500 font-medium w-36">선박 코드</th>
            <th className="text-left px-3 py-3 text-slate-500 font-medium w-24 hidden md:table-cell">연도/월</th>
            <th className="text-left px-4 py-3 text-slate-500 font-medium w-40">종합 판단</th>
            <th className="text-left px-4 py-3 text-slate-500 font-medium hidden lg:table-cell">주요 이상 항목</th>
            {isAdmin && (
              <th className="text-right px-4 py-3 text-slate-500 font-medium w-20">액션</th>
            )}
          </tr>
        </thead>
        <tbody>
          {vessels.map((v, idx) => {
            const isSelected  = v.id === selectedVesselId;
            const summary     = makeStatusSummary(v);

            return (
              <tr
                key={v.id}
                onClick={() => onSelectVessel(v.id)}
                className={`border-b border-slate-50 cursor-pointer transition-colors hover:bg-slate-50 ${
                  isSelected ? "bg-blue-50 border-l-2 border-l-blue-400" : ""
                }`}
              >
                {/* 선박 코드 */}
                <td className="px-3 py-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400 text-xs font-mono w-5 shrink-0">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <span className="font-mono font-semibold text-slate-800 text-sm">
                      {v.vesselCode || v.name}
                    </span>
                    <span className="text-xs px-1 py-0.5 rounded bg-slate-100 text-slate-400 border border-slate-200 hidden sm:inline leading-none">
                      이력
                    </span>
                  </div>
                </td>

                {/* 연도/월 */}
                <td className="px-3 py-3 text-slate-400 text-xs font-mono hidden md:table-cell">
                  {yearMonth}
                </td>

                {/* 종합 판단 */}
                <td className="px-4 py-3">
                  <StatusBadge status={v.analysisStatus || "NO_DATA"} summary={summary} />
                </td>

                {/* 주요 이상 항목 */}
                <td className="px-4 py-3 hidden lg:table-cell">
                  {v.analysisError ? (
                    <details className="inline-block max-w-sm" onClick={(e) => e.stopPropagation()}>
                      <summary className="text-red-500 text-xs font-medium cursor-pointer list-none hover:text-red-700 select-none">
                        ⚠️ 오류
                      </summary>
                      <div className="mt-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 leading-relaxed break-all whitespace-pre-wrap">
                        {v.analysisError}
                      </div>
                    </details>
                  ) : (
                    <IssueSummary vessel={v} />
                  )}
                </td>

                {/* 액션 */}
                {isAdmin && (
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); onAnalyze(v.id); }}
                      disabled={v.analysisStatus === "LOADING" || analyzingVesselId === v.id}
                      className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white transition-colors"
                      title={globalAnalyzing ? "일괄 분석이 끝난 후 클릭하세요" : "재분석"}
                    >
                      {v.analysisStatus === "LOADING" ? "분석중..." : "재분석"}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
