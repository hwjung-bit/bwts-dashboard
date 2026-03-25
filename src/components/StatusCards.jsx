// StatusCards - 현황 카드 (Stitch 디자인 적용)
const CARD_DEFS = [
  {
    key: "CRITICAL",
    label: "이상",
    icon: "emergency_home",
    emphasized: true,
    numCls: "text-slate-800",
    iconBg: "bg-red-100 text-red-600",
    bar: "bg-red-500",
    barBg: "bg-red-100",
    border: "border-red-200",
    desc: "즉각적인 조치 필요",
  },
  {
    key: "WARNING",
    label: "주의",
    icon: "warning",
    numCls: "text-slate-800",
    iconBg: "bg-amber-100 text-amber-600",
    bar: "bg-amber-400",
    barBg: "bg-amber-100",
    border: "border-slate-200",
    desc: "주의 수치 감지",
  },
  {
    key: "NORMAL",
    label: "이상없음",
    icon: "check_circle",
    numCls: "text-slate-800",
    iconBg: "bg-emerald-100 text-emerald-600",
    bar: "bg-emerald-500",
    barBg: "bg-emerald-100",
    border: "border-slate-200",
    desc: "정상 범위 운항 중",
  },
  {
    key: "REVIEWED",
    label: "검토완료",
    icon: "task_alt",
    numCls: "text-slate-800",
    iconBg: "bg-indigo-100 text-indigo-600",
    bar: "bg-indigo-400",
    barBg: "bg-indigo-100",
    border: "border-slate-200",
    desc: "담당자 확인 완료",
  },
  {
    key: "RECEIVED",
    label: "수신(미분석)",
    icon: "inbox",
    numCls: "text-slate-800",
    iconBg: "bg-sky-100 text-sky-600",
    bar: "bg-sky-400",
    barBg: "bg-sky-100",
    border: "border-slate-200",
    desc: "분석 대기 중",
  },
];

export default function StatusCards({ vessels }) {
  const counts = { NORMAL: 0, WARNING: 0, CRITICAL: 0, REVIEWED: 0, RECEIVED: 0, NO_DATA: 0 };
  vessels.forEach((v) => {
    const s = v.analysisStatus || "NO_DATA";
    // legacy REVIEWED → NORMAL로 카운트
    const bucket = s === "REVIEWED" ? "NORMAL" : (s in counts ? s : "NO_DATA");
    counts[bucket]++;
    // 검토완료 별도 카운트 (reviewed 플래그 또는 legacy REVIEWED)
    if (v.reviewed || s === "REVIEWED") counts.REVIEWED++;
  });

  const total = vessels.length || 1;

  return (
    <div className="grid grid-cols-5 gap-4 mb-6">
      {CARD_DEFS.map(({ key, label, icon, emphasized, numCls, iconBg, bar, barBg, border, desc }) => {
        const count = counts[key];
        const pct = Math.round((count / total) * 100);

        return (
          <div
            key={key}
            className={`bg-white rounded-xl p-5 border ${emphasized ? "border-2 border-red-200" : border} shadow-sm relative overflow-hidden`}
          >
            {/* 아이콘 (우상단) */}
            <div className={`absolute top-0 right-0 p-2.5 rounded-bl-xl ${iconBg}`}>
              <span className="material-symbols-outlined" style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}>
                {icon}
              </span>
            </div>

            <p className={`text-xs font-bold mb-1 ${
              key === "CRITICAL" ? "text-red-600"
              : key === "WARNING" ? "text-amber-600"
              : key === "NORMAL" ? "text-emerald-600"
              : key === "REVIEWED" ? "text-indigo-600"
              : "text-sky-600"
            }`}>
              {label}
            </p>

            <h4 className={`text-4xl font-extrabold mb-4 ${numCls}`} style={{ fontFamily: "'Manrope', sans-serif" }}>
              {String(count).padStart(2, "0")}
            </h4>

            {/* 진행 바 */}
            <div className={`w-full h-1.5 ${barBg} rounded-full overflow-hidden`}>
              <div
                className={`h-full ${bar} rounded-full transition-all`}
                style={{ width: `${Math.max(pct, count > 0 ? 8 : 0)}%` }}
              />
            </div>

            <p className="mt-2.5 text-[11px] text-slate-400 leading-tight">{desc}</p>
          </div>
        );
      })}
    </div>
  );
}
