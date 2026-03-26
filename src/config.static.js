// ============================================================
//  비민감 설정 (GitHub에 커밋 OK)
//  선박 초기값, UI 색상, 상태 매핑 함수
// ============================================================

export const INITIAL_VESSELS = [
  {
    id: "vessel_001",
    name: "VESSEL A",
    vesselCode: "KPS",
    imoNumber: "IMO1234567",
    manufacturer: "Techcross",
    model: "ECS-1000",
    contactEmail: "vessel-a@example.com",
    note: "",
  },
  {
    id: "vessel_002",
    name: "VESSEL B",
    vesselCode: "KPS2",
    imoNumber: "IMO7654321",
    manufacturer: "Techcross",
    model: "ECS-2000",
    contactEmail: "vessel-b@example.com",
    note: "",
  },
];

export const STATUS_CONFIG = {
  NORMAL: {
    label: "정상",
    color: "text-green-400",
    bg: "bg-green-900/30",
    border: "border-green-700",
    dot: "bg-green-400",
    badge: "bg-green-900 text-green-300",
  },
  WARNING: {
    label: "주의",
    color: "text-yellow-400",
    bg: "bg-yellow-900/30",
    border: "border-yellow-700",
    dot: "bg-yellow-400",
    badge: "bg-yellow-900 text-yellow-300",
  },
  CRITICAL: {
    label: "이상",
    color: "text-red-400",
    bg: "bg-red-900/30",
    border: "border-red-700",
    dot: "bg-red-400",
    badge: "bg-red-900 text-red-300",
  },
  REVIEWED: {
    label: "검토완료",
    color: "text-indigo-400",
    bg: "bg-indigo-900/30",
    border: "border-indigo-700",
    dot: "bg-indigo-400",
    badge: "bg-indigo-900 text-indigo-300",
  },
  RECEIVED: {
    label: "수신",
    color: "text-teal-600",
    bg: "bg-teal-50",
    border: "border-teal-200",
    dot: "bg-teal-500",
    badge: "bg-teal-100 text-teal-700",
  },
  NO_DATA: {
    label: "미수신",
    color: "text-slate-400",
    bg: "bg-slate-800/50",
    border: "border-slate-700",
    dot: "bg-slate-500",
    badge: "bg-slate-800 text-slate-400",
  },
  LOADING: {
    label: "분석중",
    color: "text-blue-400",
    bg: "bg-blue-900/30",
    border: "border-blue-700",
    dot: "bg-blue-400",
    badge: "bg-blue-900 text-blue-300",
  },
};

export function mapOverallStatus(status, alarms = []) {
  if (status) {
    const s = status.toUpperCase();
    if (s === "NORMAL")                      return "NORMAL";
    if (s === "WARNING")                     return "WARNING";
    if (s === "CRITICAL" || s === "FAILURE") return "CRITICAL";
  }
  const levels = (alarms ?? []).map((a) => (a.level ?? "").toLowerCase());
  if (levels.some((l) => l === "trip"))                      return "CRITICAL";
  if (levels.some((l) => l === "alarm" || l === "warning"))  return "WARNING";
  if (alarms && alarms.length === 0)                         return "NORMAL";
  return "NO_DATA";
}

// ── 검교정 이력 설정 (비민감 — GitHub 커밋 OK) ─────────────
export const CALIB_CONFIG = {
  SHEET_ID:       "1Kv7dIhAs_QfvccAxjGev-EutU_VtgOm4TQclDB72Y6A",
  GID:            297341548,
  STATUS_OPTIONS: ["", "진행 예정", "확인필요", "업체요청필요"],
};
