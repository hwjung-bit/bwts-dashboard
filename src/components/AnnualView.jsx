// AnnualView - 연간 월별 선박 상태 현황 차트
import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, Cell } from "recharts";

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - i);

const STATUS_COLOR = {
  NORMAL:   "#22c55e",
  WARNING:  "#eab308",
  CRITICAL: "#ef4444",
  RECEIVED: "#94a3b8",
  NO_DATA:  "#e2e8f0",
};
const STATUS_LABEL = {
  NORMAL:   "정상",
  WARNING:  "주의",
  CRITICAL: "이상",
  RECEIVED: "수신",
  NO_DATA:  "미수신",
};

function loadAnnualData(year, vessels) {
  return Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    try {
      const raw = localStorage.getItem(`bwts_monthly_${year}_${m}`);
      const data = raw ? JSON.parse(raw) : null;
      const counts = { NORMAL: 0, WARNING: 0, CRITICAL: 0, RECEIVED: 0, NO_DATA: 0 };

      if (!data || Object.keys(data).length === 0) {
        return { month: `${m}월`, analyzed: false, ...counts };
      }
      vessels.forEach((v) => {
        const s = data[v.id]?.analysisStatus || "NO_DATA";
        if (s === "REVIEWED") counts.RECEIVED++;       // 검토완료 → 수신으로 합산
        else if (s in counts) counts[s]++;
        else counts.NO_DATA++;
      });
      return { month: `${m}월`, analyzed: true, ...counts };
    } catch {
      return { month: `${m}월`, analyzed: false, NORMAL: 0, WARNING: 0, CRITICAL: 0, RECEIVED: 0, NO_DATA: 0 };
    }
  });
}

export default function AnnualView({ vessels }) {
  const [year, setYear] = useState(String(CURRENT_YEAR));
  const data = loadAnnualData(year, vessels);
  const hasAnyData = data.some((d) => d.analyzed);

  const totals = { NORMAL: 0, WARNING: 0, CRITICAL: 0, RECEIVED: 0 };
  data.forEach((d) => {
    totals.NORMAL   += d.NORMAL;
    totals.WARNING  += d.WARNING;
    totals.CRITICAL += d.CRITICAL;
    totals.RECEIVED += d.RECEIVED;
  });
  const analyzedMonths = data.filter((d) => d.analyzed).length;

  return (
    <div className="flex flex-col gap-4">
      {/* 연도 선택 */}
      <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <label className="text-xs text-slate-500 font-medium">연도</label>
        <select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="bg-white border border-slate-300 text-slate-700 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          {YEARS.map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        <div className="text-xs text-slate-400">
          분석 완료: <span className="font-medium text-slate-600">{analyzedMonths}개월</span> / 12개월
        </div>
      </div>

      {/* 연간 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { key: "NORMAL",   label: "정상 건수",    color: "text-green-600",  bg: "bg-green-50 border-green-200"   },
          { key: "WARNING",  label: "주의 건수",    color: "text-yellow-600", bg: "bg-yellow-50 border-yellow-200" },
          { key: "CRITICAL", label: "이상 건수",    color: "text-red-600",    bg: "bg-red-50 border-red-200"       },
          { key: "RECEIVED", label: "수신(미분석)", color: "text-slate-500",  bg: "bg-slate-50 border-slate-200"   },
        ].map(({ key, label, color, bg }) => (
          <div key={key} className={`rounded-xl border p-4 ${bg} text-center`}>
            <div className={`text-3xl font-bold ${color}`}>{totals[key]}</div>
            <div className={`text-xs ${color} opacity-70 mt-1`}>{label}</div>
          </div>
        ))}
      </div>

      {/* 월별 차트 */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="text-sm font-semibold text-slate-700 mb-4">
          {year}년 월별 선박 상태 현황
        </div>

        {!hasAnyData ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
            <span className="text-3xl">📊</span>
            <p className="text-sm">아직 분석된 데이터가 없습니다.</p>
            <p className="text-xs">월별 분석 탭에서 각 월의 분석을 실행하세요.</p>
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data} barCategoryGap="30%">
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "#94a3b8" }}
                  label={{ value: "척", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 11, fill: "#94a3b8" } }}
                />
                <Tooltip
                  contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "#64748b", fontWeight: 600 }}
                  formatter={(value, name) => [value + " 척", STATUS_LABEL[name] || name]}
                />
                <Legend
                  iconSize={10}
                  iconType="circle"
                  wrapperStyle={{ fontSize: 12, color: "#64748b", paddingTop: 8 }}
                  formatter={(value) => STATUS_LABEL[value] || value}
                />
                {["NORMAL", "WARNING", "CRITICAL", "RECEIVED", "NO_DATA"].map((k) => (
                  <Bar key={k} dataKey={k} stackId="a" fill={STATUS_COLOR[k]} name={k} />
                ))}
              </BarChart>
            </ResponsiveContainer>

            {/* 미분석 월 표시 */}
            {data.some((d) => !d.analyzed) && (
              <p className="text-xs text-slate-400 mt-2 text-center">
                ⚪ 회색으로 표시된 달은 아직 분석 데이터가 없습니다.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
