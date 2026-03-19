// VesselDetail - 선박 상세 패널 (라이트 테마)
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

const STATUS_STYLE = {
  NORMAL:   { dot: "bg-green-500",  badge: "bg-green-100 text-green-700",     label: "정상",    bg: "bg-green-50 border-green-200"   },
  WARNING:  { dot: "bg-yellow-500", badge: "bg-yellow-100 text-yellow-700",   label: "주의",    bg: "bg-yellow-50 border-yellow-200" },
  CRITICAL: { dot: "bg-red-500",    badge: "bg-red-100 text-red-700",         label: "이상",    bg: "bg-red-50 border-red-200"       },
  REVIEWED: { dot: "bg-indigo-500", badge: "bg-indigo-100 text-indigo-700",   label: "검토완료", bg: "bg-indigo-50 border-indigo-200" },
  RECEIVED: { dot: "bg-teal-500",   badge: "bg-teal-100 text-teal-700",       label: "수신",    bg: "bg-teal-50 border-teal-200"     },
  NO_DATA:  { dot: "bg-slate-400",  badge: "bg-slate-100 text-slate-500",     label: "미수신",  bg: "bg-slate-50 border-slate-200"   },
};

function SensorBar({ label, value, max, unit, color }) {
  const pct = Math.min(100, ((value ?? 0) / max) * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span className={`font-medium ${color}`}>{value ?? "-"} {unit}</span>
      </div>
      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color.replace("text-", "bg-")}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// 동일 코드+설명 기준으로 알람 그루핑
// 설명에서 괄호 안 숫자값 제거 (예: "FMU Flow Rate High.[345.00]" → "FMU Flow Rate High")
function normalizeDesc(desc) {
  return (desc ?? "").replace(/\s*[\[\(]\d+[\.\d]*[\]\)]/g, "").trim();
}

function groupAlarms(alarms) {
  const map = new Map();
  for (const a of alarms) {
    const baseDesc = normalizeDesc(a.description);
    const key = `${a.code ?? ""}|${baseDesc}|${a.level ?? ""}`;
    if (!map.has(key)) {
      map.set(key, { ...a, description: baseDesc, dates: a.date ? [a.date] : [] });
    } else {
      const entry = map.get(key);
      if (a.date && !entry.dates.includes(a.date)) entry.dates.push(a.date);
    }
  }
  return Array.from(map.values());
}

function AlarmTag({ alarm }) {
  const colors = {
    Trip:    "border-l-red-400 bg-red-50 text-red-700",
    Alarm:   "border-l-orange-400 bg-orange-50 text-orange-700",
    Warning: "border-l-yellow-400 bg-yellow-50 text-yellow-700",
  };
  const cls = colors[alarm.level] || "border-l-slate-300 bg-slate-50 text-slate-600";
  const count = alarm.dates?.length || 0;
  return (
    <div className={`border-l-4 rounded-r-lg px-3 py-1.5 text-xs flex items-center justify-between gap-2 ${cls}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 font-semibold opacity-70">[{alarm.level}]</span>
        <span className="truncate">{alarm.description}</span>
        {alarm.code && <span className="shrink-0 opacity-40 font-mono">#{alarm.code}</span>}
      </div>
      <div className="shrink-0 text-right opacity-60 leading-tight whitespace-nowrap">
        {count > 1 && <span className="font-semibold mr-1">{count}회</span>}
        {alarm.dates?.[0] && <span>{alarm.dates[0]}</span>}
      </div>
    </div>
  );
}

export default function VesselDetail({ vessel, onClose }) {
  if (!vessel) return null;

  const r = vessel.analysisResult;
  const s = STATUS_STYLE[vessel.analysisStatus] || STATUS_STYLE.NO_DATA;
  const sensor = r?.sensor_data || {};
  const tro = r?.tro_data || {};
  const alarms = r?.error_alarms || [];
  const ops = r?.operations || [];

  const chartData = ops.slice(-10).map((op) => ({
    date: op.date?.slice(5) || "-",
    주입: op.ballast_volume || 0,
    배출: op.deballast_volume || 0,
  }));

  return (
    <div className="mt-4 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      {/* 헤더 */}
      <div className={`flex items-center justify-between px-5 py-4 border-b ${s.bg}`}>
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full ${s.dot}`} />
          <h2 className="text-base font-semibold text-slate-800 font-mono">{vessel.vesselCode || vessel.name}</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.badge}`}>{s.label}</span>
          {r?.manufacturer && (
            <span className="text-xs text-slate-400 bg-white border border-slate-200 px-2 py-0.5 rounded-full">{r.manufacturer}</span>
          )}
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
      </div>

      {/* 분석 오류 배너 */}
      {vessel.analysisError && (
        <div className="mx-5 mt-4 bg-red-50 border border-red-200 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-red-500 text-sm">⚠️</span>
            <span className="text-xs font-semibold text-red-600">분석 오류</span>
          </div>
          <p className="text-xs text-red-700 font-mono leading-relaxed break-all whitespace-pre-wrap">
            {vessel.analysisError}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-5">
        {/* 좌측 */}
        <div className="flex flex-col gap-4">
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500 font-medium mb-3">TRO 측정값</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center bg-white border border-slate-200 rounded-xl p-3">
                <div className="text-xs text-slate-400 mb-1">주입 평균</div>
                <div className="text-2xl font-bold text-green-600">{tro.ballasting_avg ?? "-"}</div>
                <div className="text-xs text-slate-400">ppm</div>
                <div className="text-xs text-slate-300 mt-1">정상: 5~10 ppm</div>
              </div>
              <div className="text-center bg-white border border-slate-200 rounded-xl p-3">
                <div className="text-xs text-slate-400 mb-1">배출 평균</div>
                <div className="text-2xl font-bold text-blue-600">{tro.deballasting_avg ?? "-"}</div>
                <div className="text-xs text-slate-400">ppm</div>
                <div className="text-xs text-slate-300 mt-1">기준: &lt;0.1 ppm</div>
              </div>
            </div>
          </div>

          {(sensor.gds_max != null || sensor.csu_avg != null || sensor.fts_max != null) && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col gap-3">
              <div className="text-xs text-slate-500 font-medium">센서 현황</div>
              {sensor.gds_max != null && <SensorBar label="GDS 수소가스"    value={sensor.gds_max} max={25}  unit="% LEL" color="text-yellow-500" />}
              {sensor.csu_avg != null && <SensorBar label="CSU 전도도"      value={sensor.csu_avg} max={200} unit="mS/cm" color="text-cyan-500"   />}
              {sensor.fts_max != null && <SensorBar label="FTS 냉각수 온도" value={sensor.fts_max} max={43}  unit="°C"    color="text-orange-500" />}
            </div>
          )}

          {alarms.length > 0 && (() => {
            const grouped = groupAlarms(alarms);
            const trips = grouped.filter((a) => a.level === "Trip");
            const others = grouped.filter((a) => a.level !== "Trip");
            const rawTrips = alarms.filter((a) => a.level === "Trip").length;
            const rawOthers = alarms.length - rawTrips;
            return (
              <div className="flex flex-col gap-2">
                {/* 헤더: 건수 요약 */}
                <div className="flex items-center gap-3 text-xs font-medium">
                  {rawTrips > 0 && (
                    <span className="text-red-600">
                      🔴 Trip {rawTrips}건{trips.length < rawTrips ? ` (${trips.length}종)` : ""}
                    </span>
                  )}
                  {rawOthers > 0 && rawTrips > 0 && <span className="text-slate-300">|</span>}
                  {rawOthers > 0 && (
                    <span className="text-orange-600">
                      ⚠️ Alarm {rawOthers}건{others.length < rawOthers ? ` (${others.length}종)` : ""}
                    </span>
                  )}
                </div>
                {/* 단일 컬럼 — Trip 먼저, Alarm/Warning 이후 */}
                <div className="flex flex-col gap-1">
                  {[...trips, ...others].map((a, i) => <AlarmTag key={i} alarm={a} />)}
                </div>
              </div>
            );
          })()}
        </div>

        {/* 우측 */}
        <div className="flex flex-col gap-4">
          {chartData.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500 font-medium mb-4">운전량 (최근 10회, m³)</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} barCategoryGap="30%">
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                  <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} />
                  <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#64748b" }} />
                  <Bar dataKey="주입" fill="#22c55e" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="배출" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex gap-4 mt-2 justify-center text-xs text-slate-400">
                <span className="flex items-center gap-1"><span className="w-3 h-1.5 bg-green-500 rounded-sm" />주입</span>
                <span className="flex items-center gap-1"><span className="w-3 h-1.5 bg-blue-500 rounded-sm" />배출</span>
              </div>
            </div>
          )}

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <div className="text-xs text-slate-500 font-medium mb-3">선박 정보</div>
            <dl className="space-y-2 text-sm">
              {[
                ["IMO 번호",    vessel.imoNumber],
                ["폴더 코드",   vessel.vesselCode],
                ["제조사",      r?.manufacturer || vessel.manufacturer],
                ["모델",        vessel.model],
                ["수신 이메일", vessel.contactEmail],
                ["분석 기간",   r?.period],
              ].map(([k, v]) => v ? (
                <div key={k} className="flex gap-2">
                  <dt className="text-slate-400 w-24 shrink-0">{k}</dt>
                  <dd className="text-slate-700">{v}</dd>
                </div>
              ) : null)}
            </dl>
          </div>

          {/* AI 분석 요약 — 선박 정보 아래 */}
          {r?.ai_remarks && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <div className="text-xs text-blue-600 font-medium mb-2">🤖 AI 분석 요약</div>
              <div className="text-sm text-slate-700 leading-relaxed space-y-1.5">
                {(Array.isArray(r.ai_remarks)
                  ? r.ai_remarks
                  : (r.ai_remarks || "").replace(/\\n/g, "\n").split("\n")
                ).filter(Boolean).map((line, i) => {
                  const isOps     = line.startsWith("[운전") || line.startsWith("[Operations]");
                  const isEcu     = line.startsWith("[ECU]");
                  const isAlarm   = /^\[CODE|^\[VRCS|^\[LOG_OVERFLOW|^\[알람없음/.test(line);
                  const isSummary = line.startsWith("[종합") || line.startsWith("[Summary]");
                  if (isOps) return (
                    <p key={i} className="text-slate-700">
                      <span className="mr-1">📋</span>{line}
                    </p>
                  );
                  if (isEcu) return (
                    <p key={i} className="text-blue-700 pl-4 border-l-2 border-blue-300">
                      <span className="mr-1">🔌</span>{line}
                    </p>
                  );
                  if (isAlarm) return (
                    <p key={i} className="text-amber-700 pl-4 border-l-2 border-amber-300">
                      <span className="mr-1">⚠️</span>{line}
                    </p>
                  );
                  if (isSummary) return (
                    <p key={i} className="text-slate-800 font-medium pt-0.5">
                      <span className="mr-1">💡</span>{line}
                    </p>
                  );
                  return <p key={i} className="text-slate-600 pl-2">{line}</p>;
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
