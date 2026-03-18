// VesselTable - 선박 목록 테이블 (라이트 테마)

// 시스템 패턴 매핑 (알람 코드/설명 → 시스템명)
const SYSTEM_PATTERNS = [
  ["ECU",  /\bECU\b/i],
  ["TSU",  /\bTSU\b/i],
  ["FMU",  /\bFMU\b/i],
  ["BPU",  /\bBPU\b/i],
  ["ANU",  /\bANU\b/i],
  ["CPU",  /\bCPU\b/i],
  ["GDS",  /\bGDS\b/i],
  ["CSU",  /\bCSU\b/i],
  ["TRO",  /\bTRO\b|Concentration/i],
  ["밸브",  /Valve/i],
  ["탱크",  /Tank\s*Level/i],
  ["유량",  /Flow\s*Rate/i],
  ["온도",  /Temp(erature)?/i],
];

function extractSystem(alarm) {
  const text = (alarm.code || "") + " " + (alarm.description || "");
  for (const [name, re] of SYSTEM_PATTERNS) {
    if (re.test(text)) return name;
  }
  // 매칭 안 되면 description 첫 단어 최대 5자
  return (alarm.description || "")
    .replace(/^\[.*?\]\s*/, "")
    .trim()
    .split(/\s+/)[0]
    ?.slice(0, 5) || "기타";
}

// 시스템별 심각도 배지 배열 반환
// null → 분석 결과 없음, [] → 알람 없음, [...] → 배지 목록
function makeIssueBadges(vessel) {
  const r = vessel.analysisResult;
  if (!r) return null;
  const alarms = r.error_alarms || [];
  if (alarms.length === 0) return [];
  const sysMap = new Map();
  for (const a of alarms) {
    const sys = extractSystem(a);
    const isTrip = (a.level || "").toLowerCase() === "trip";
    if (!sysMap.has(sys)) sysMap.set(sys, { system: sys, hasTrip: false });
    if (isTrip) sysMap.get(sys).hasTrip = true;
  }
  return Array.from(sysMap.values())
    .slice(0, 4)
    .map((s) => ({ system: s.system, level: s.hasTrip ? "이상" : "주의" }));
}

function IssueSummary({ vessel }) {
  const badges = makeIssueBadges(vessel);
  if (badges === null) return <span className="text-slate-300 text-xs">-</span>;
  if (badges.length === 0) return <span className="text-green-600 text-xs font-medium">이상 없음</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {badges.map((b, i) => (
        <span key={b.system} className="contents">
          {i > 0 && <span className="text-slate-300 text-xs">/</span>}
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${
            b.level === "이상"
              ? "text-red-600 bg-red-50 border-red-200"
              : "text-yellow-600 bg-yellow-50 border-yellow-200"
          }`}>
            {b.system} {b.level}
          </span>
        </span>
      ))}
    </div>
  );
}

const STATUS_BADGE = {
  NORMAL:   { label: "정상",    cls: "bg-green-100 text-green-700 border-green-200",     dot: "bg-green-500"   },
  WARNING:  { label: "주의",    cls: "bg-yellow-100 text-yellow-700 border-yellow-200",  dot: "bg-yellow-500"  },
  CRITICAL: { label: "이상",    cls: "bg-red-100 text-red-700 border-red-200",           dot: "bg-red-500"     },
  REVIEWED: { label: "검토완료", cls: "bg-indigo-100 text-indigo-700 border-indigo-200", dot: "bg-indigo-500"  },
  RECEIVED: { label: "수신",    cls: "bg-teal-100 text-teal-700 border-teal-200",        dot: "bg-teal-500"    },
  NO_DATA:  { label: "미수신",  cls: "bg-slate-100 text-slate-500 border-slate-200",    dot: "bg-slate-400"   },
  LOADING:  { label: "분석중",  cls: "bg-blue-100 text-blue-700 border-blue-200",        dot: "bg-blue-500"    },
};

function StatusBadge({ status }) {
  const s = STATUS_BADGE[status] || STATUS_BADGE.NO_DATA;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${s.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export default function VesselTable({ vessels, selectedVesselId, onSelectVessel, onAnalyze, isAdmin, globalAnalyzing, analyzingVesselId }) {
  if (vessels.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400 bg-white border border-slate-200 rounded-xl">
        선박 정보가 없습니다. 선박을 추가하거나 분석을 시작하세요.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            <th className="text-left px-4 py-3 text-slate-500 font-medium">선박명</th>
            <th className="text-left px-4 py-3 text-slate-500 font-medium">상태</th>
            <th className="text-left px-4 py-3 text-slate-500 font-medium hidden md:table-cell">제조사</th>
            <th className="text-left px-4 py-3 text-slate-500 font-medium hidden lg:table-cell">주요 알람</th>
            <th className="text-left px-4 py-3 text-slate-500 font-medium hidden lg:table-cell">AI 요약</th>
            {isAdmin && <th className="text-center px-4 py-3 text-slate-500 font-medium">액션</th>}
          </tr>
        </thead>
        <tbody>
          {vessels.map((v) => {
            const isSelected = v.id === selectedVesselId;
            const alarms = v.analysisResult?.error_alarms || [];
            const topAlarm = alarms[0];

            return (
              <tr
                key={v.id}
                onClick={() => onSelectVessel(v.id)}
                className={`border-b border-slate-50 cursor-pointer transition-colors hover:bg-slate-50 ${
                  isSelected ? "bg-blue-50 border-l-2 border-l-blue-400" : ""
                }`}
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800 font-mono">
                    {v.vesselCode || v.name}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={v.analysisStatus || "NO_DATA"} />
                </td>
                <td className="px-4 py-3 text-slate-500 hidden md:table-cell">
                  {v.manufacturer || "-"}
                </td>
                <td className="px-4 py-3 hidden lg:table-cell">
                  {topAlarm ? (
                    <span className="text-red-500 text-xs">[{topAlarm.level}] {topAlarm.description}</span>
                  ) : (
                    <span className="text-slate-300 text-xs">-</span>
                  )}
                </td>
                <td className="px-4 py-3 hidden lg:table-cell max-w-xs">
                  {v.analysisError ? (
                    <details className="inline-block max-w-xs" onClick={(e) => e.stopPropagation()}>
                      <summary className="text-red-500 text-xs font-medium cursor-pointer list-none hover:text-red-700 select-none">
                        ⚠️ 오류!
                      </summary>
                      <div className="mt-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 leading-relaxed break-all whitespace-pre-wrap">
                        {v.analysisError}
                      </div>
                    </details>
                  ) : (
                    <IssueSummary vessel={v} />
                  )}
                </td>
                {isAdmin && (
                  <td className="px-4 py-3 text-center">
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
