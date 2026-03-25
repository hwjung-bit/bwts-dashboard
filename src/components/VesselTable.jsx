// VesselTable - 선박 목록 테이블 (Stitch 디자인 적용)

const ISSUE_CATEGORIES = [
  { key: "처리수량",   match: (a) => /FMU|Flow|Volume|유량/i.test((a.code||"")+(a.description||"")) },
  { key: "배출기준",   match: (a) => /Deballass|배출|CODE201/i.test((a.code||"")+(a.description||"")) },
  { key: "TRO생성",    match: (a) => /TRO|Concentration|CODE200/i.test((a.code||"")+(a.description||"")) },
  { key: "ANU중화",    match: (a) => /ANU|Tank\s*Level|Sodium|CODE30[123]/i.test((a.code||"")+(a.description||"")) },
  { key: "Bypass",     match: (a) => /Bypass|EM.?CY/i.test(a.description||"") },
  { key: "센서건전성", match: (a) => /Comm|Sensor|CODE7[02]/i.test((a.code||"")+(a.description||"")) },
  { key: "알람",       match: (a) => a.level === "Alarm" || a.level === "Warning" },
];

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
    const count = matched.reduce((sum, a) => {
      const m = (a.description || "").match(/×(\d+)회/);
      return sum + (m ? parseInt(m[1]) : 1);
    }, 0);
    result.push({ key: cat.key, hasTrip, count });
  }
  return result;
}

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
  if (badges.length === 0) return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
      <span className="material-symbols-outlined" style={{ fontSize: 14, fontVariationSettings: "'FILL' 1" }}>check_circle</span>
      이상 없음
    </span>
  );
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <span
          key={b.key}
          className={`text-xs font-semibold px-2 py-0.5 rounded-md border ${
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

const STATUS_CONFIG = {
  CRITICAL: {
    label: "이상",
    dot: "bg-red-500",
    cls: "bg-red-50 text-red-700 border-red-200",
    rowHover: "hover:bg-red-50/60",
    rowBorder: "border-l-red-400",
  },
  WARNING: {
    label: "주의",
    dot: "bg-amber-400",
    cls: "bg-amber-50 text-amber-700 border-amber-200",
    rowHover: "hover:bg-amber-50/60",
    rowBorder: "border-l-amber-400",
  },
  NORMAL: {
    label: "이상없음",
    dot: "bg-emerald-500",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rowHover: "hover:bg-slate-50",
    rowBorder: "",
  },
  REVIEWED: {
    label: "검토완료",
    dot: "bg-indigo-500",
    cls: "bg-indigo-50 text-indigo-700 border-indigo-200",
    rowHover: "hover:bg-slate-50",
    rowBorder: "",
  },
  RECEIVED: {
    label: "수신",
    dot: "bg-sky-500",
    cls: "bg-sky-50 text-sky-700 border-sky-200",
    rowHover: "hover:bg-sky-50/40",
    rowBorder: "",
  },
  NO_DATA: {
    label: "미수신",
    dot: "bg-slate-300",
    cls: "bg-slate-50 text-slate-500 border-slate-200",
    rowHover: "hover:bg-slate-50",
    rowBorder: "",
  },
  LOADING: {
    label: "분석중",
    dot: "bg-blue-500 animate-pulse",
    cls: "bg-blue-50 text-blue-700 border-blue-200",
    rowHover: "hover:bg-blue-50/40",
    rowBorder: "",
  },
};

function StatusBadge({ status, summary, reviewed }) {
  // legacy REVIEWED → 검토완료 표기
  const effectiveStatus = status === "REVIEWED" ? "NORMAL" : (status || "NO_DATA");
  const isLegacyReviewed = status === "REVIEWED";
  const showReviewed = reviewed || isLegacyReviewed;
  const s = STATUS_CONFIG[effectiveStatus] || STATUS_CONFIG.NO_DATA;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border w-fit whitespace-nowrap ${s.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
          {s.label}
        </span>
        {showReviewed && (
          <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-600 border border-indigo-200 whitespace-nowrap">
            ✓ 검토
          </span>
        )}
      </div>
      {summary && (
        <span className="text-[11px] text-slate-400 pl-1">{summary}</span>
      )}
    </div>
  );
}

export default function VesselTable({
  vessels, selectedVesselId, onSelectVessel, onAnalyze,
  isAdmin, globalAnalyzing, analyzingVesselId, year, month
}) {
  if (vessels.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400 bg-white border border-slate-200 rounded-xl">
        선박 정보가 없습니다. 선박을 추가하거나 분석을 시작하세요.
      </div>
    );
  }

  const yearMonth = year && month ? `${year}-${String(month).padStart(2, "0")}` : "-";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* 테이블 헤더 영역 */}
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <h3 className="font-bold text-slate-800 text-sm" style={{ fontFamily: "'Manrope', sans-serif" }}>
          Vessel Monitoring List
        </h3>
        <span className="text-xs text-slate-400">{yearMonth} · {vessels.length}척</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50/80 border-b border-slate-100">
              <th className="text-left px-6 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider w-10">#</th>
              <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider w-44">선박 / 기기</th>
              <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider w-36">종합 판단</th>
              <th className="text-left px-4 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider hidden lg:table-cell">주요 이상 항목</th>
              {isAdmin && (
                <th className="text-right px-6 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider w-28">액션</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {vessels.map((v, idx) => {
              const isSelected = v.id === selectedVesselId;
              const summary    = makeStatusSummary(v);
              const sc         = STATUS_CONFIG[v.analysisStatus] || STATUS_CONFIG.NO_DATA;
              const isCritical = v.analysisStatus === "CRITICAL";

              return (
                <tr
                  key={v.id}
                  onClick={() => onSelectVessel(v.id)}
                  className={`cursor-pointer transition-colors ${sc.rowHover} ${
                    isSelected
                      ? "bg-blue-50 border-l-2 border-l-blue-500"
                      : isCritical
                      ? "border-l-2 border-l-red-400"
                      : ""
                  }`}
                >
                  {/* 번호 */}
                  <td className="px-6 py-4">
                    <span className="text-xs font-mono text-slate-300">{String(idx + 1).padStart(2, "0")}</span>
                  </td>

                  {/* 선박 코드 */}
                  <td className="px-4 py-4 w-44">
                    <div className="flex flex-col">
                      <span className="font-bold text-slate-800 whitespace-nowrap">{v.vesselCode || v.name}</span>
                      {(v.manufacturer || v.model) ? (
                        <span className="text-[11px] text-slate-400 whitespace-nowrap">
                          {[v.manufacturer, v.model].filter(Boolean).join(' ')}
                        </span>
                      ) : v.imoNumber ? (
                        <span className="text-[11px] text-slate-400 whitespace-nowrap">IMO {v.imoNumber}</span>
                      ) : null}
                    </div>
                  </td>

                  {/* 종합 판단 */}
                  <td className="px-4 py-4 w-36">
                    <StatusBadge status={v.analysisStatus || "NO_DATA"} summary={summary} reviewed={v.reviewed} />
                  </td>

                  {/* 주요 이상 항목 */}
                  <td className="px-4 py-4 hidden lg:table-cell">
                    {v.analysisError ? (
                      <details className="inline-block max-w-sm" onClick={(e) => e.stopPropagation()}>
                        <summary className="text-red-500 text-xs font-medium cursor-pointer list-none hover:text-red-700 select-none">
                          ⚠️ 오류 (클릭하여 확인)
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
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); onAnalyze(v.id); }}
                        disabled={v.analysisStatus === "LOADING" || analyzingVesselId === v.id}
                        className={`px-4 py-2 text-xs rounded-lg font-semibold whitespace-nowrap transition-colors ${
                          v.analysisStatus === "LOADING" || analyzingVesselId === v.id
                            ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                            : isCritical
                            ? "bg-red-600 hover:bg-red-700 text-white"
                            : "bg-[#003c69] hover:bg-[#004d8a] text-white"
                        }`}
                        title={globalAnalyzing ? "일괄 분석이 끝난 후 클릭하세요" : "재분석"}
                      >
                        {v.analysisStatus === "LOADING" || analyzingVesselId === v.id ? (
                          <span className="flex items-center gap-1.5">
                            <span className="w-3 h-3 border-2 border-slate-300 border-t-slate-500 rounded-full animate-spin" />
                            분석중
                          </span>
                        ) : "재분석"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
