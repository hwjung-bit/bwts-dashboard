// ShipLogs - 연도별 선박×월 수신현황 매트릭스
import { useState } from "react";

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - i);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function loadMonthlyData(year, month) {
  try {
    const raw = localStorage.getItem(`bwts_monthly_${year}_${month}`);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// 상태별 셀 스타일
const STATUS_CELL = {
  CRITICAL: { label: "이상", cls: "bg-red-50 text-red-600 border-red-200", dot: "bg-red-500" },
  WARNING:  { label: "주의", cls: "bg-amber-50 text-amber-600 border-amber-200", dot: "bg-amber-400" },
  NORMAL:   { label: "정상", cls: "bg-emerald-50 text-emerald-600 border-emerald-200", dot: "bg-emerald-500" },
  REVIEWED: { label: "완료", cls: "bg-indigo-50 text-indigo-600 border-indigo-200", dot: "bg-indigo-400" },
  RECEIVED: { label: "수신", cls: "bg-sky-50 text-sky-600 border-sky-200", dot: "bg-sky-400" },
  LOADING:  { label: "분석중", cls: "bg-blue-50 text-blue-500 border-blue-200", dot: "bg-blue-400" },
  NO_DATA:  { label: "—", cls: "bg-slate-50 text-slate-300 border-slate-100", dot: null },
};

function StatusCell({ status, reviewed, hasCsv, hasPdf }) {
  const s = STATUS_CELL[status] || STATUS_CELL.NO_DATA;
  if (status === "NO_DATA") {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-slate-200 text-sm font-medium">—</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${s.cls}`}>
        {s.dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />}
        {s.label}
      </div>
      <div className="flex gap-1">
        {reviewed && <span className="text-[9px] px-1 rounded bg-indigo-50 text-indigo-500 border border-indigo-100">검토</span>}
        {hasPdf && <span className="text-[9px] px-1 rounded bg-orange-50 text-orange-400 border border-orange-100">PDF</span>}
        {hasCsv && <span className="text-[9px] px-1 rounded bg-green-50 text-green-500 border border-green-100">CSV</span>}
      </div>
    </div>
  );
}

export default function ShipLogs({ vessels }) {
  const [year, setYear] = useState(String(CURRENT_YEAR));

  // 12개월 × 선박별 상태 매트릭스 계산
  const allMonthData = MONTHS.map((m) => loadMonthlyData(year, m));

  const matrix = vessels.map((v) => ({
    vessel: v,
    months: MONTHS.map((_, idx) => {
      const data = allMonthData[idx];
      const entry = data[v.id] || {};
      // Show original status even when reviewed
      const rawStatus = entry.analysisStatus || "NO_DATA";
      const originalStatus = rawStatus === "REVIEWED"
        ? (entry.analysisResult?.overall_status || "NORMAL")
        : rawStatus;
      return {
        status: originalStatus,
        reviewed: entry.reviewed || rawStatus === "REVIEWED",
        hasCsv: entry.hasCsv || false,
        hasPdf: entry.hasPdf || false,
      };
    }),
  }));

  const monthSummary = MONTHS.map((_, idx) => {
    const data = allMonthData[idx];
    const entries = Object.values(data).filter(d => d?.analysisStatus && d.analysisStatus !== "NO_DATA");
    const csvCount = entries.filter(d => d.hasCsv).length;
    return { received: entries.length, csvCount };
  });

  return (
    <div>
      {/* 헤더 영역 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-xl font-bold text-[#003c69]" style={{ fontFamily: "'Manrope', sans-serif" }}>
            Ship Logs
          </h3>
          <p className="text-sm text-slate-400 mt-0.5">연도별 선박 수신 현황</p>
        </div>
        <select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="bg-white border border-slate-200 text-slate-700 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          {YEARS.map((y) => (
            <option key={y} value={y}>{y}년</option>
          ))}
        </select>
      </div>

      {/* 범례 */}
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        {[
          { key: "RECEIVED", label: "수신" },
          { key: "NORMAL", label: "이상없음" },
          { key: "WARNING", label: "검토필요" },
          { key: "CRITICAL", label: "즉시확인" },
          { key: "REVIEWED", label: "검토완료" },
          { key: "NO_DATA", label: "미수신" },
        ].map(({ key, label }) => {
          const s = STATUS_CELL[key];
          return (
            <div key={key} className="flex items-center gap-1.5">
              {s.dot
                ? <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                : <span className="w-2 h-2 rounded-full bg-slate-200" />}
              <span className="text-xs text-slate-500">{label}</span>
            </div>
          );
        })}
      </div>

      {/* 매트릭스 테이블 */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50/80 border-b border-slate-100">
              <th className="text-left px-5 py-3 text-[11px] font-bold text-slate-400 uppercase tracking-wider w-44 sticky left-0 bg-slate-50/80">
                선박 / 기기
              </th>
              {MONTHS.map((m) => (
                <th key={m} className="px-2 py-3 text-center text-[11px] font-bold text-slate-400 uppercase tracking-wider min-w-[70px]">
                  <div>{m}월</div>
                  {monthSummary[m - 1].received > 0 && (
                    <div className="text-[10px] font-normal text-slate-300 mt-0.5">
                      {monthSummary[m - 1].received}척
                      {monthSummary[m - 1].csvCount > 0 && (
                        <span className="text-green-400 ml-0.5">(CSV {monthSummary[m - 1].csvCount})</span>
                      )}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {matrix.map(({ vessel: v, months }) => (
              <tr key={v.id} className="hover:bg-slate-50/60 transition-colors">
                <td className="px-5 py-3 sticky left-0 bg-white">
                  <div className="flex flex-col">
                    <span className="font-bold text-slate-800 whitespace-nowrap text-sm">
                      {v.vesselCode || v.name}
                    </span>
                    {(v.manufacturer || v.model) ? (
                      <span className="text-[11px] text-slate-400 whitespace-nowrap">
                        {[v.manufacturer, v.model].filter(Boolean).join(' ')}
                      </span>
                    ) : null}
                  </div>
                </td>

                {months.map((cell, idx) => (
                  <td key={idx} className="px-2 py-3 text-center">
                    <div className="flex items-center justify-center">
                      <StatusCell status={cell.status} reviewed={cell.reviewed} hasCsv={cell.hasCsv} hasPdf={cell.hasPdf} />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
