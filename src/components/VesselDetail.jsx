// VesselDetail - 선박 상세 패널 (라이트 테마)
import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

// ── 진단 패널 헬퍼 컴포넌트 (관리자 전용) ─────────────────────
function DbgSection({ title, children }) {
  return (
    <div className="mb-3">
      <div className="text-slate-400 text-[11px] mb-1 font-semibold">{title}</div>
      <div className="pl-2 space-y-0.5">{children}</div>
    </div>
  );
}
function DbgRow({ label, value, highlight }) {
  return (
    <div className="flex gap-2 leading-snug">
      <span className="text-slate-500 w-40 shrink-0 text-[11px]">{label}</span>
      <span className={`break-all text-[11px] ${highlight ? "text-green-400 font-semibold" : "text-slate-200"}`}>
        {value ?? "null"}
      </span>
    </div>
  );
}
function DbgErr({ msg }) {
  return <div className="text-red-400 text-[11px]">⚠ {msg}</div>;
}
// ─────────────────────────────────────────────────────────────

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

export default function VesselDetail({ vessel, onClose, isAdmin }) {
  if (!vessel) return null;

  const [showDebug, setShowDebug] = useState(false);
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
  const hasVolumeData = chartData.some(d => d.주입 > 0 || d.배출 > 0);

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
        <div className="flex items-center gap-2">
          {isAdmin && r && r._debug && (
            <button
              onClick={() => setShowDebug(p => !p)}
              title="파싱 진단"
              className={`text-xs px-2 py-0.5 rounded border font-mono transition-colors
                ${showDebug
                  ? "bg-slate-700 text-white border-slate-600"
                  : "bg-white text-slate-400 border-slate-300 hover:bg-slate-50"}`}
            >
              🔍 진단
            </button>
          )}
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
        </div>
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

      {/* 🔍 진단 패널 (관리자 전용) */}
      {isAdmin && showDebug && r && r._debug && (() => {
        const dbg = r._debug || {};
        const s0Tro = dbg.stage0RawTro;
        const aiTro = dbg.aiTroData;
        return (
          <div className="mx-5 mt-4 bg-slate-900 text-slate-200 rounded-xl p-4 text-xs font-mono overflow-auto max-h-[60vh]">
            <div className="text-slate-500 mb-3 text-[11px] select-none">── 파싱 진단 (관리자 전용) ──────────────────────</div>

            {/* 1. PDF 구조 */}
            <DbgSection title="📄 PDF 구조">
              {dbg.totalLogFailed
                ? <>
                    <DbgRow label="Main PDF 페이지" value={dbg.mainFilePages != null ? `${dbg.mainFilePages}p` : "알 수 없음"} />
                    <DbgErr msg={dbg.totalLogError
                      ? `pdf.js 추출 실패 (${dbg.mainFilePages ?? "?"}p): ${dbg.totalLogError}`
                      : `pdf.js 텍스트 없음 (${dbg.mainFilePages ?? "?"}p) — Stage 0 데이터만 사용`
                    } />
                  </>
                : <>
                    <DbgRow label="Main PDF 페이지"          value={dbg.mainFilePages != null ? `${dbg.mainFilePages}p` : "알 수 없음"} />
                    <DbgRow label="전체 페이지"              value={dbg.totalPages ?? "알 수 없음 (재분석 필요)"} />
                    <DbgRow label="Total Report (+1 offset)" value={dbg.isTotalReport ? "✅ 감지됨" : "❌ 미감지"} />
                    <DbgRow label="Event Log 시작"           value={dbg.sections?.event_log_start ?? "null"} />
                    <DbgRow label="Op Time 시작"             value={dbg.sections?.op_time_start   ?? "null"} />
                    <DbgRow label="Data Log 시작"            value={dbg.sections?.data_log_start  ?? "null"} />
                    {dbg.headerText && (
                      <div style={{ marginTop: 6, padding: "6px 8px", background: "#f8f8f8", borderRadius: 4, fontSize: 10, fontFamily: "monospace", whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto", color: "#333", border: "1px solid #ddd" }}>
                        {dbg.headerText}
                      </div>
                    )}
                  </>
              }
            </DbgSection>

            {/* 2. Stage 0 결과 (logParser) */}
            <DbgSection title="⚙ Stage 0 결과 (logParser)">
              <DbgRow label="Stage0 tro_data"       value={JSON.stringify(s0Tro)} />
              <DbgRow label="B-TRO (stage0)"        value={s0Tro?.ballasting_avg   ?? "null"} highlight={s0Tro?.ballasting_avg != null} />
              <DbgRow label="D-TRO (stage0)"        value={s0Tro?.deballasting_max ?? "null"} />
              <DbgRow label="ECU avg (stage0)"      value={s0Tro?.ecu_current_avg  ?? "null"} />
              <DbgRow label="FMU avg (stage0)"      value={s0Tro?.fmu_flow_avg     ?? "null"} />
            </DbgSection>

            {/* 3. AI Stage 1 결과 */}
            <DbgSection title={dbg.totalLogFailed ? "🤖 AI Stage 1 결과 (미실행 — Stage 0만 사용)" : "🤖 AI Stage 1 결과 (텍스트 추출 후 분석)"}>
              {dbg.totalLogFailed && <DbgErr msg="pdf.js 실패 → AI 분석 없음, Stage 0 데이터만 최종 반영" />}
              <DbgRow label="AI tro_data"           value={JSON.stringify(aiTro)} />
              <DbgRow label="B-TRO (AI)"            value={aiTro?.ballasting_avg   ?? "null"} highlight={aiTro?.ballasting_avg != null} />
              <DbgRow label="D-TRO (AI)"            value={aiTro?.deballasting_max ?? "null"} />
              <DbgRow label="ECU avg (AI)"          value={aiTro?.ecu_current_avg  ?? "null"} />
              <DbgRow label="FMU avg (AI)"          value={aiTro?.fmu_flow_avg     ?? "null"} />
            </DbgSection>

            {/* 4. 최종 병합 결과 */}
            <DbgSection title="✅ 최종 병합 결과">
              <DbgRow label="B-TRO (최종)"          value={r.tro_data?.ballasting_avg   ?? "null"} highlight={r.tro_data?.ballasting_avg != null} />
              <DbgRow label="D-TRO (최종)"          value={r.tro_data?.deballasting_max ?? "null"} />
              <DbgRow label="ECU avg (최종)"        value={r.tro_data?.ecu_current_avg  ?? "null"} />
              <DbgRow label="FMU avg (최종)"        value={r.tro_data?.fmu_flow_avg     ?? "null"} />
              <DbgRow label="ANU status (최종)"     value={r.tro_data?.anu_status       ?? "null"} />
            </DbgSection>

            {/* 5. 운전 현황 */}
            <DbgSection title="🚢 운전 현황">
              <DbgRow label="operations 건수"       value={r.operations?.length ?? 0} />
              {(r.operations || []).slice(0, 5).map((op, i) => (
                <DbgRow key={i} label={`  #${i+1}`} value={`${op.operation_mode} | ${op.date ?? "-"} | vol=${op.ballast_volume ?? op.deballast_volume ?? "-"}`} />
              ))}
            </DbgSection>

            {/* 6. VRCS */}
            {(r.error_alarms || []).filter(a => a.code === 'VRCS_ERR').length > 0 && (
              <DbgSection title="🔧 VRCS 채터링 감지">
                {r.error_alarms.filter(a => a.code === 'VRCS_ERR').map((a, i) => (
                  <DbgRow key={i} label={a.description?.match(/\[([^\]]+)\]/)?.[1] ?? `#${i}`} value={`×${a.count ?? "?"}`} />
                ))}
              </DbgSection>
            )}
          </div>
        );
      })()}

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
                <div className="text-xs text-slate-400 mb-1">배출 최댓값</div>
                <div className="text-2xl font-bold text-blue-600">{tro.deballasting_max ?? "-"}</div>
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
              {hasVolumeData ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} barCategoryGap="30%">
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                  <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} />
                  <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#64748b" }} />
                  <Bar dataKey="주입" fill="#22c55e" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="배출" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              ) : (
              <div className="flex items-center justify-center h-[200px] text-xs text-slate-400">
                운전량(m³) 데이터 없음 — Operation Time 파일에 볼륨 미기재
              </div>
              )}
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
                ["BWTS 타입",   (() => { const mfr = r?.manufacturer || vessel.manufacturer; const mdl = vessel.model; return mfr && mdl ? `${mfr} (${mdl})` : mfr || mdl || null; })()],
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

          {/* AI 분석 결과 — 선박 정보 아래 */}
          {r?.ai_remarks && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <div className="text-xs text-blue-600 font-medium mb-2">🤖 AI 분석 결과</div>
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
                  if (isSummary) {
                    const prefix    = line.match(/^\[[^\]]+\]\s*/)?.[0] || "";
                    const body      = line.slice(prefix.length);
                    const sentences = body.split(/(?<=\.)\s+/).filter(Boolean);
                    return (
                      <div key={i} className="pt-0.5">
                        <p className="text-slate-800 font-medium">
                          <span className="mr-1">💡</span>
                          <span className="font-semibold">{prefix.trim()}</span>
                        </p>
                        {sentences.map((s, j) => (
                          <p key={j} className="text-slate-700 pl-5 mt-0.5">{s}</p>
                        ))}
                      </div>
                    );
                  }
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
