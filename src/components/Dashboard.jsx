// Dashboard - 메인 대시보드 (월별 분석 + 연간 현황 탭)
import { useState, useEffect } from "react";
import { collectMonthData } from "../services/driveService.js";
import { analyzeCsvFromDrive, validateAndNormalizeResult } from "../services/analysisService.js";
import { readMonthlyData, upsertMonthlyEntry, clearMonthlyData } from "../services/sheetsService.js";
import { mapOverallStatus, CONFIG } from "../config.js";
import StatusCards from "./StatusCards.jsx";
import VesselTable from "./VesselTable.jsx";
import VesselDetail from "./VesselDetail.jsx";
import RemarkPanel from "./RemarkPanel.jsx";
import AnnualView from "./AnnualView.jsx";

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - i);
const MONTHS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: `${i + 1}월`,
}));

// ── localStorage: 월별 분석 데이터 ────────────────────────────
function loadMonthlyData(year, month) {
  try {
    const raw = localStorage.getItem(`bwts_monthly_${year}_${month}`);
    if (!raw) return {};
    const data = JSON.parse(raw);
    // 분석 도중 중단된 LOADING 상태 → RECEIVED로 자동 복구
    let needSave = false;
    for (const id of Object.keys(data)) {
      if (data[id]?.analysisStatus === "LOADING") {
        data[id].analysisStatus = "RECEIVED";
        data[id].analysisError = "분석이 중단되었습니다. 재분석을 눌러주세요.";
        needSave = true;
      }
    }
    if (needSave) localStorage.setItem(`bwts_monthly_${year}_${month}`, JSON.stringify(data));
    return data;
  } catch { return {}; }
}

function saveMonthlyData(year, month, data) {
  localStorage.setItem(`bwts_monthly_${year}_${month}`, JSON.stringify(data));
}

/**
 * Report/Log 파일 우선 필터링 (우선순위 기반)
 * - 1순위: 정확한 리포트 타입명 포함 (DataReport, EventLog 등)
 * - EventLog가 별도 파일 또는 통합 리포트 PDF 안에 있는 경우 모두 처리하기 위해
 * - 매뉴얼·도면·인증서 등 명백한 비로그 파일만 제외 (관대한 필터)
 * - fallback: 전체 반환
 */
const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30MB 초과 제외

function filterLogPdfs(pdfs) {
  const EXCLUDE_PATTERNS = /manual|drawing|certificate|photo|image|install|setup/i;
  let filtered = pdfs.filter((p) =>
    !EXCLUDE_PATTERNS.test(p.name || "") &&
    (p.size == null || Number(p.size) <= MAX_PDF_BYTES)
  );
  filtered.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
  return filtered.length > 0 ? filtered : pdfs;
}

export default function Dashboard({ vessels, setVessels, accessToken, isAdmin }) {
  const [activeTab, setActiveTab]     = useState("monthly");
  const [year, setYear]               = useState(String(CURRENT_YEAR));
  const [month, setMonth]             = useState(String(new Date().getMonth() + 1));
  const [monthlyData, setMonthlyData] = useState(() =>
    loadMonthlyData(String(CURRENT_YEAR), String(new Date().getMonth() + 1))
  );
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [sheetsError, setSheetsError]     = useState("");
  const [analyzing, setAnalyzing]     = useState(false);
  const [analyzingNames, setAnalyzingNames] = useState([]); // 현재 분석 중인 선박명
  const [analyzeError, setAnalyzeError] = useState("");
  const [analyzingVesselId, setAnalyzingVesselId] = useState(null); // 단일 재분석 중인 선박
  const [scanInfo, setScanInfo]        = useState(null);
  const [scanExpanded, setScanExpanded] = useState(true);
  const [selectedId, setSelectedId]   = useState(null);
  const [eventLogInputs, setEventLogInputs]   = useState({});  // { [vesselId]: string }
  const [eventLogParsing, setEventLogParsing] = useState({});

  // 월/연도 변경 시 해당 월 데이터 로드 (Sheets 우선, fallback localStorage)
  useEffect(() => {
    setSelectedId(null);
    if (accessToken && CONFIG.SHEETS_ID) {
      setSheetsLoading(true);
      readMonthlyData(CONFIG.SHEETS_ID, year, month, accessToken)
        .then((sheetsData) => {
          const localData = loadMonthlyData(year, month);
          // 선박 단위 병합: lastAnalyzed 기준으로 더 최신 데이터 유지
          const merged = { ...localData };
          for (const [id, sheetsEntry] of Object.entries(sheetsData)) {
            const local = localData[id];
            if (!local || (sheetsEntry.lastAnalyzed || "") >= (local.lastAnalyzed || "")) {
              merged[id] = sheetsEntry;
            }
          }
          setMonthlyData(merged);
          saveMonthlyData(year, month, merged);
        })
        .catch(() => setMonthlyData(loadMonthlyData(year, month)))
        .finally(() => setSheetsLoading(false));
    } else {
      setMonthlyData(loadMonthlyData(year, month));
    }
  }, [year, month, accessToken]);

  // 선박 정의 + 이번 달 분석 데이터 병합
  const displayVessels = vessels.map((v) => ({
    ...v,
    ...(monthlyData[v.id] || {}),
    analysisStatus: monthlyData[v.id]?.analysisStatus || "NO_DATA",
  }));

  const selectedVessel = displayVessels.find((v) => v.id === selectedId) || null;

  // 특정 선박의 월별 데이터만 업데이트 (localStorage + Sheets 동기화)
  function updateMonthlyVessel(vesselId, updates) {
    setMonthlyData((prev) => {
      const entry = { ...(prev[vesselId] || {}), ...updates };
      const next = { ...prev, [vesselId]: entry };
      saveMonthlyData(year, month, next);
      // Sheets upsert (비동기)
      if (accessToken && CONFIG.SHEETS_ID) {
        upsertMonthlyEntry(CONFIG.SHEETS_ID, vesselId, year, month, entry, accessToken)
          .catch((e) => {
            console.warn("Sheets upsert 실패:", e.message);
            setSheetsError("Sheets 저장 실패 — 새로고침 시 데이터가 유실될 수 있습니다.");
          });
      }
      return next;
    });
  }

  // 단일 선박 재분석
  async function analyzeVessel(vesselId) {
    const vessel = vessels.find((v) => v.id === vesselId);
    if (!vessel) return;

    // prevStatus를 localStorage에서 직접 읽어 클로저 stale 문제 방지
    const savedData = loadMonthlyData(year, month);
    const prevStatus = savedData[vesselId]?.analysisStatus || "NO_DATA";

    setAnalyzingVesselId(vesselId);
    setAnalyzeError("");
    updateMonthlyVessel(vesselId, { analysisStatus: "LOADING", analysisError: null, analysisResult: null });
    try {
      const monthData = await collectMonthData(CONFIG.DRIVE_ROOT_FOLDER_ID, year, month, accessToken);
      const mk = (vessel.vesselCode || vessel.name).toLowerCase();
      const entry = monthData.find((d) => d.vesselFolderName.toLowerCase().includes(mk));
      const csvFiles = entry?.csvFiles ?? [];
      if (!entry || (entry.pdfs.length === 0 && csvFiles.length === 0)) {
        // Drive 폴더/PDF/CSV 없음 → 기존 상태 유지 + 에러 표시
        updateMonthlyVessel(vesselId, {
          analysisStatus: prevStatus,
          analysisError: `[${year}년 ${month}월] Drive에서 분석 파일을 찾을 수 없습니다.`,
        });
        setAnalyzeError(`${vessel.vesselCode || vessel.name}: Drive 폴더를 찾을 수 없습니다.`);
        return;
      }
      const vesselWithPeriod = { ...vessel, year, month };
      const logPdfs = csvFiles.length > 0 ? [] : filterLogPdfs(entry.pdfs);
      const result = await analyzeCsvFromDrive([...csvFiles, ...logPdfs], accessToken, vesselWithPeriod);
      const mapped = mapOverallStatus(result?.overall_status, result?.error_alarms);
      const finalStatus = mapped === "NO_DATA" ? "RECEIVED" : mapped;
      updateMonthlyVessel(vesselId, {
        analysisStatus: finalStatus,
        analysisResult: result,
        analysisError: null,
        lastAnalyzed: new Date().toISOString(),
      });
    } catch (err) {
      // 분석 실패 → RECEIVED 유지 (파일은 있음) + 에러 표시
      updateMonthlyVessel(vesselId, { analysisStatus: "RECEIVED", analysisError: err.message });
      setAnalyzeError(`재분석 실패 (${vessel.vesselCode || vessel.name}): ${err.message}`);
    } finally {
      setAnalyzingVesselId(null);
    }
  }

  // Drive 스캔 (분석 없이 수신 여부만 확인)
  async function handleScanDrive() {
    if (!accessToken) { setAnalyzeError("Google 로그인이 필요합니다."); return; }
    setAnalyzing(true);
    setAnalyzeError("");
    setScanInfo(null);
    try {
      const monthData = await collectMonthData(CONFIG.DRIVE_ROOT_FOLDER_ID, year, month, accessToken);
      const matchedFolders = [];
      const unmatchedFolders = [];

      // 등록된 선박과 매칭
      vessels.forEach((vessel) => {
        const mk = (vessel.vesselCode || vessel.name).toLowerCase();
        const entry = monthData.find((d) => d.vesselFolderName.toLowerCase().includes(mk));
        const hasPdfs = entry && (entry.pdfs.length > 0 || (entry.csvFiles?.length ?? 0) > 0);
        const current = monthlyData[vessel.id]?.analysisStatus;
        const analyzed = ["NORMAL", "WARNING", "CRITICAL", "REVIEWED"].includes(current);
        if (!analyzed) {
          const csvCount = entry?.csvFiles?.length ?? 0;
          const pdfCount = entry?.pdfs?.length ?? 0;
          updateMonthlyVessel(vessel.id, {
            analysisStatus: hasPdfs ? "RECEIVED" : "NO_DATA",
            pdfCount: hasPdfs ? (csvCount || pdfCount) : 0,
            hasCsv: csvCount > 0,
            hasPdf: pdfCount > 0,
          });
        }
        if (entry) matchedFolders.push({ vesselName: vessel.name, folderName: entry.vesselFolderName, pdfs: entry.pdfs.length, csvs: entry.csvFiles?.length ?? 0 });
      });

      // 미매핑 Drive 폴더 (등록 안된 선박)
      monthData.forEach((d) => {
        const matched = vessels.some((v) =>
          d.vesselFolderName.toLowerCase().includes((v.vesselCode || v.name).toLowerCase())
        );
        if (!matched) unmatchedFolders.push({ folderName: d.vesselFolderName, pdfs: d.pdfs.length, csvs: d.csvFiles?.length ?? 0 });
      });

      setScanInfo({ total: monthData.length, matched: matchedFolders, unmatched: unmatchedFolders });
    } catch (err) {
      setAnalyzeError(`스캔 실패: ${err.message}`);
    } finally {
      setAnalyzing(false);
    }
  }

  // Drive 폴더명에서 선박 코드 추출: "01 KPS (수신)" → "KPS"
  function extractVesselCodeFromFolder(folderName) {
    return folderName
      .replace(/^\d+\s*\.?\s*/, "")       // 앞 숫자 제거
      .replace(/\s*[\(\（][^)\）]*[\)\）].*$/, "") // (수신) 제거
      .trim();
  }

  // 미매핑 폴더를 새 선박으로 추가
  function addVesselFromFolder(folderName) {
    const code = extractVesselCodeFromFolder(folderName);
    const newVessel = {
      id: `vessel_${Date.now()}`,
      name: code,
      vesselCode: code,
      imoNumber: "",
      manufacturer: "",
      model: "",
      contactEmail: "",
      note: "",
    };
    setVessels((prev) => [...prev, newVessel]);
    setScanInfo((prev) => prev ? {
      ...prev,
      unmatched: prev.unmatched.filter((u) => u.folderName !== folderName),
      matched: [...prev.matched, { vesselName: code, folderName, pdfs: prev.unmatched.find(u => u.folderName === folderName)?.pdfs || 0 }],
    } : prev);
  }

  // 전체 선박 일괄 분석
  async function handleAnalyzeAll() {
    if (!accessToken) { setAnalyzeError("Google 로그인이 필요합니다."); return; }
    setAnalyzing(true);
    setAnalyzingNames([]);
    setAnalyzeError("");
    try {
      const monthData = await collectMonthData(CONFIG.DRIVE_ROOT_FOLDER_ID, year, month, accessToken);
      const targets = vessels.filter((vessel) => {
        const mk = (vessel.vesselCode || vessel.name).toLowerCase();
        const entry = monthData.find((d) => d.vesselFolderName.toLowerCase().includes(mk));
        return entry && (entry.pdfs.length > 0 || (entry.csvFiles?.length ?? 0) > 0);
      });

      for (const vessel of targets) {
        const mk = (vessel.vesselCode || vessel.name).toLowerCase();
        const entry = monthData.find((d) => d.vesselFolderName.toLowerCase().includes(mk));
        const displayName = vessel.vesselCode || vessel.name;
        setAnalyzingNames([displayName]);
        updateMonthlyVessel(vessel.id, { analysisStatus: "LOADING", analysisResult: null, analysisError: null });
        try {
          const csvFiles = entry?.csvFiles ?? [];
          const vesselWithPeriod = { ...vessel, year, month };
          const logPdfs = csvFiles.length > 0 ? [] : filterLogPdfs(entry.pdfs);
          const result = await analyzeCsvFromDrive([...csvFiles, ...logPdfs], accessToken, vesselWithPeriod);
          const mapped = mapOverallStatus(result?.overall_status, result?.error_alarms);
          const finalStatus = mapped === "NO_DATA" ? "RECEIVED" : mapped;
          updateMonthlyVessel(vessel.id, {
            analysisStatus: finalStatus,
            analysisResult: result,
            analysisError: null,
            lastAnalyzed: new Date().toISOString(),
          });
        } catch (err) {
          updateMonthlyVessel(vessel.id, { analysisStatus: "RECEIVED", analysisError: err.message });
          setAnalyzeError(`${displayName} 분석 실패: ${err.message}`);
        }
      }
    } catch (err) {
      setAnalyzeError(`분석 실패: ${err.message}`);
    } finally {
      setAnalyzing(false);
      setAnalyzingNames([]);
      // 혹시 LOADING 상태가 남은 선박 → RECEIVED로 복구
      setMonthlyData((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id of Object.keys(next)) {
          if (next[id]?.analysisStatus === "LOADING") {
            next[id] = { ...next[id], analysisStatus: "RECEIVED", analysisError: "분석이 중단되었습니다." };
            changed = true;
          }
        }
        if (changed) saveMonthlyData(year, month, next);
        return changed ? next : prev;
      });
    }
  }

  // EVENTLOG 수동 입력 → 기존 결과에 알람 병합 후 재정규화
  async function handleSubmitEventLog(vesselId) {
    setEventLogParsing(p => ({ ...p, [vesselId]: true }));
    try {
      const text = eventLogInputs[vesselId] ?? '';
      const { parseEventLogCsv } = await import('../services/csvService.js');
      // validateAndNormalizeResult is statically imported at the top
      const newAlarms = parseEventLogCsv(text);
      const existing  = monthlyData[vesselId]?.analysisResult ?? {};
      const merged = {
        ...existing,
        error_alarms:       [...(existing.error_alarms ?? []), ...newAlarms],
        _event_log_missing: false,
      };
      const final = validateAndNormalizeResult(merged, null);
      updateMonthlyVessel(vesselId, { analysisResult: final });
    } finally {
      setEventLogParsing(p => ({ ...p, [vesselId]: false }));
    }
  }

  return (
    <div>
      {/* ── 탭 ── */}
      <div className="flex gap-1 mb-5 bg-white border border-slate-200 rounded-xl p-1 w-fit shadow-sm">
        <button
          onClick={() => setActiveTab("monthly")}
          className={`px-4 py-2 text-sm rounded-lg font-medium transition-colors ${
            activeTab === "monthly"
              ? "bg-blue-600 text-white shadow-sm"
              : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          📋 월별 분석
        </button>
        <button
          onClick={() => setActiveTab("annual")}
          className={`px-4 py-2 text-sm rounded-lg font-medium transition-colors ${
            activeTab === "annual"
              ? "bg-blue-600 text-white shadow-sm"
              : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          }`}
        >
          📊 연간 현황
        </button>
      </div>

      {/* ── 연간 현황 탭 ── */}
      {activeTab === "annual" ? (
        <AnnualView vessels={vessels} />
      ) : (
        <>
          {/* ── 분석 기간 선택 바 ── */}
          <div className="flex flex-wrap items-end gap-3 mb-6 bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div>
              <label className="block text-xs text-slate-500 mb-1.5 font-medium">연도</label>
              <select
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className="bg-white border border-slate-300 text-slate-700 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              >
                {YEARS.map((y) => <option key={y} value={y}>{y}년</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1.5 font-medium">월</label>
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="bg-white border border-slate-300 text-slate-700 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              >
                {MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            {isAdmin && (
              <>
                <button
                  onClick={handleScanDrive}
                  disabled={analyzing || !accessToken}
                  className="px-5 py-2 text-sm bg-teal-600 hover:bg-teal-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg transition-colors flex items-center gap-2 font-medium"
                >
                  {analyzing ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      확인중...
                    </>
                  ) : "📂 수신 확인"}
                </button>
                <button
                  onClick={handleAnalyzeAll}
                  disabled={analyzing || !accessToken}
                  className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg transition-colors flex items-center gap-2 font-medium"
                >
                  {analyzing && analyzingNames.length > 0 ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      분석중 ({analyzingNames.length}척)…
                    </>
                  ) : analyzing ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      준비중...
                    </>
                  ) : "🔍 분석 시작"}
                </button>
                <button
                  onClick={() => {
                    if (!confirm(`${year}년 ${month}월 분석 데이터를 초기화할까요?\n(선박 목록은 유지됩니다)`)) return;
                    setMonthlyData({});
                    saveMonthlyData(year, month, {});
                    setScanInfo(null);
                    setAnalyzeError("");
                    if (accessToken && CONFIG.SHEETS_ID) {
                      clearMonthlyData(CONFIG.SHEETS_ID, year, month, accessToken).catch(console.warn);
                    }
                  }}
                  disabled={analyzing}
                  className="px-3 py-2 text-sm bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-500 border border-slate-200 rounded-lg transition-colors font-medium"
                  title="이번 달 분석 결과만 초기화 (선박 목록 유지)"
                >
                  🗑 초기화
                </button>
              </>
            )}
            {!accessToken && (
              <span className="text-xs text-slate-400">로그인 후 분석 가능합니다</span>
            )}
            {analyzingNames.length > 0 && (
              <div className="text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                🔄 분석중: {analyzingNames.join(", ")}
              </div>
            )}
            {sheetsLoading && (
              <div className="text-xs text-slate-400 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-slate-300 border-t-slate-500 rounded-full animate-spin" />
                Sheets 데이터 로딩중...
              </div>
            )}
            {analyzeError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {analyzeError}
              </div>
            )}
            {sheetsError && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                ⚠ {sheetsError}
                <button onClick={() => setSheetsError("")} className="text-amber-400 hover:text-amber-600 font-bold leading-none">×</button>
              </div>
            )}
            {/* 마지막 분석 시각 표시 */}
            {Object.values(monthlyData).some((d) => d.lastAnalyzed) && (
              <span className="text-xs text-slate-400 ml-auto">
                분석: {new Date(
                  Math.max(...Object.values(monthlyData).filter(d => d.lastAnalyzed).map(d => new Date(d.lastAnalyzed)))
                ).toLocaleString("ko-KR")}
              </span>
            )}
          </div>

          {/* ── Drive 스캔 결과 ── */}
          {scanInfo && (
            <div className="mb-5 bg-white border border-slate-200 rounded-xl shadow-sm text-sm">
              <div
                className="flex items-center justify-between p-4 cursor-pointer select-none"
                onClick={() => setScanExpanded((v) => !v)}
              >
                <span className="font-semibold text-slate-700 flex items-center gap-2">
                  📂 Drive 스캔 결과 — {year}년 {month}월
                  <span className="text-xs font-normal text-teal-600 bg-teal-50 border border-teal-200 rounded-full px-2 py-0.5">
                    수신 {scanInfo.matched.length}척
                  </span>
                  {scanInfo.unmatched.length > 0 && (
                    <span className="text-xs font-normal text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                      미등록 {scanInfo.unmatched.length}개
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 text-xs">{scanExpanded ? "▲ 접기" : "▼ 펼치기"}</span>
                  <button onClick={(e) => { e.stopPropagation(); setScanInfo(null); }} className="text-slate-400 hover:text-slate-600 text-lg leading-none">✕</button>
                </div>
              </div>
              {scanExpanded && (
              <div className="px-4 pb-4 border-t border-slate-100 pt-3">
              {scanInfo.matched.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-slate-500 mb-1.5">✅ 매칭된 선박</div>
                  <div className="flex flex-wrap gap-2">
                    {scanInfo.matched.map((m, i) => (
                      <span key={i} className="bg-teal-50 border border-teal-200 text-teal-700 rounded-lg px-2.5 py-1">
                        {m.vesselName} ← <span className="font-mono text-xs">{m.folderName}</span>
                        <span className="ml-1.5 text-teal-500">
                          {m.csvs > 0 ? `CSV ${m.csvs}개` : `PDF ${m.pdfs}개`}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {scanInfo.unmatched.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-slate-500 mb-1.5">⚠️ 미등록 선박 폴더 (등록하면 분석 가능)</div>
                  <div className="flex flex-wrap gap-2">
                    {scanInfo.unmatched.map((u, i) => (
                      <div key={i} className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1">
                        <span className="font-mono text-xs text-amber-800">{u.folderName}</span>
                        <span className="text-amber-500 text-xs">{(u.csvs ?? 0) > 0 ? `CSV ${u.csvs}개` : `PDF ${u.pdfs}개`}</span>
                        <button
                          onClick={() => addVesselFromFolder(u.folderName)}
                          className="ml-1 text-xs bg-amber-500 hover:bg-amber-600 text-white rounded px-1.5 py-0.5 font-medium"
                        >
                          + 등록
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {scanInfo.total === 0 && (
                <div className="text-slate-400">해당 월에 수신 폴더가 없습니다.</div>
              )}
              </div>
              )}
            </div>
          )}

          {/* ── 현황 카드 ── */}
          <StatusCards vessels={displayVessels} />

          {/* ── 선박 목록 테이블 ── */}
          <VesselTable
            vessels={displayVessels}
            selectedVesselId={selectedId}
            onSelectVessel={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            onAnalyze={analyzeVessel}
            isAdmin={isAdmin}
            globalAnalyzing={analyzing}
            analyzingVesselId={analyzingVesselId}
            year={year}
            month={month}
          />

          {/* ── 선택된 선박 상세 + 검토 패널 ── */}
          {selectedVessel && (
            <>
              <VesselDetail key={`detail-${selectedVessel.id}`} vessel={selectedVessel} onClose={() => setSelectedId(null)} isAdmin={isAdmin} />
              <RemarkPanel
                key={`remark-${selectedVessel.id}`}
                vessel={selectedVessel}
                analysisResult={selectedVessel.analysisResult}
                accessToken={accessToken}
                onUpdate={(updates) => updateMonthlyVessel(selectedId, updates)}
                period={`${year}년 ${month}월`}
              />
              {/* ── EVENTLOG 누락 시 수동 입력 패널 ── */}
              {selectedVessel.analysisResult?._event_log_missing && (
                <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-5">
                  <h3 className="font-semibold text-amber-800 mb-1">⚠ Event Log 수동 입력</h3>
                  <p className="text-sm text-amber-700 mb-3">
                    EVENTLOG.CSV가 없습니다. 원본 PDF에서 알람/이벤트 내용을 CSV 형식으로 복사하여 붙여넣으세요.
                  </p>
                  <textarea
                    className="w-full border border-amber-300 rounded-lg p-2 text-xs font-mono resize-y bg-white"
                    value={eventLogInputs[selectedId] ?? ''}
                    onChange={e => setEventLogInputs(p => ({ ...p, [selectedId]: e.target.value }))}
                    placeholder={"DATE,TIME,LEVEL,CODE,DESCRIPTION,DEVICE\n2026-01-01,05:30,Alarm,CODE200,TRO Concentration Low,PUMP1"}
                    rows={8}
                  />
                  <button
                    className="mt-2 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50"
                    onClick={() => handleSubmitEventLog(selectedId)}
                    disabled={eventLogParsing[selectedId] || !eventLogInputs[selectedId]?.trim()}
                  >
                    {eventLogParsing[selectedId] ? '처리 중...' : '알람 분析 적용'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
