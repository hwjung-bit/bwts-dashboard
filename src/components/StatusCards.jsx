// StatusCards - 전체 현황 카드
const CARD_DEFS = [
  { key: "NORMAL",   icon: "🟢", label: "정상",    bg: "bg-green-50",  border: "border-green-200",  num: "text-green-600",  sub: "text-green-500"  },
  { key: "WARNING",  icon: "🟡", label: "주의",    bg: "bg-yellow-50", border: "border-yellow-200", num: "text-yellow-600", sub: "text-yellow-500" },
  { key: "CRITICAL", icon: "🔴", label: "이상",    bg: "bg-red-50",    border: "border-red-200",    num: "text-red-600",    sub: "text-red-500"    },
  { key: "REVIEWED", icon: "✅", label: "검토완료", bg: "bg-indigo-50", border: "border-indigo-200", num: "text-indigo-600", sub: "text-indigo-500" },
  { key: "RECEIVED", icon: "📥", label: "수신",    bg: "bg-teal-50",   border: "border-teal-200",   num: "text-teal-600",   sub: "text-teal-500"   },
  { key: "NO_DATA",  icon: "⚪", label: "미수신",   bg: "bg-slate-50",  border: "border-slate-200",  num: "text-slate-500",  sub: "text-slate-400"  },
];

export default function StatusCards({ vessels }) {
  const counts = { NORMAL: 0, WARNING: 0, CRITICAL: 0, REVIEWED: 0, RECEIVED: 0, NO_DATA: 0 };
  vessels.forEach((v) => {
    const s = v.analysisStatus || "NO_DATA";
    if (s in counts) counts[s]++;
    else counts.NO_DATA++;
  });
  // 수신 = PDF 있는 선박 전체 (RECEIVED + 분석완료 상태 모두 포함)
  counts.RECEIVED = counts.RECEIVED + counts.NORMAL + counts.WARNING + counts.CRITICAL + counts.REVIEWED;
  // 미수신 = NO_DATA 그대로

  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
      {CARD_DEFS.map(({ key, icon, label, bg, border, num, sub }) => (
        <div key={key} className={`rounded-xl border p-4 ${bg} ${border} flex flex-col items-center gap-1.5`}>
          <span className="text-xl">{icon}</span>
          <span className={`text-3xl font-bold ${num}`}>{counts[key]}</span>
          <span className={`text-xs font-medium ${sub}`}>{label}</span>
        </div>
      ))}
    </div>
  );
}
