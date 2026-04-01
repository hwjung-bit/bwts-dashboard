// ShipLogs - 연도별 선박×월 수신현황 매트릭스 + CSV 변환
import { useState } from "react";
import { CONFIG } from "../config.js";
import { collectMonthData } from "../services/driveService.js";
import {
  detectLogType,
  buildCsvFileName,
  extractVesselCode,
  callCloudFunction,
  uploadCsvToDrive,
} from "../services/conversionService.js";

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

function StatusCell({ status }) {
  const s = STATUS_CELL[status] || STATUS_CELL.NO_DATA;
  if (status === "NO_DATA") {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-slate-200 text-sm font-medium">—</span>
      </div>
    );
  }
  return (
    <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-semibold ${s.cls}`}>
      {s.dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />}
      {s.label}
    </div>
  );
}

export default function ShipLogs({ vessels, accessToken, isAdmin }) {
  const [year, setYear] = useState(String(CURRENT_YEAR));

  // CSV 변환 상태
  const [converting, setConverting] = useState(false);
  const [convertingMonth, setConvertingMonth] = useState(null);
  const [progress, setProgress] = useState(null);    // { current, total, vesselName, logType }
  const [result, setResult] = useState(null);         // { success, failed, skipped, errors[] }

  // 12개월 × 선박별 상태 매트릭스 계산
  const allMonthData = MONTHS.map((m) => loadMonthlyData(year, m));

  const matrix = vessels.map((v) => ({
    vessel: v,
    months: MONTHS.map((_, idx) => {
      const data = allMonthData[idx];
      return data[v.id]?.analysisStatus || "NO_DATA";
    }),
  }));

  const monthSummary = MONTHS.map((_, idx) => {
    const data = allMonthData[idx];
    const received = Object.values(data).filter(
      (d) => d?.analysisStatus && d.analysisStatus !== "NO_DATA"
    ).length;
    return received;
  });

  // ── CSV 변환 핸들러 ─────────────────────────────────────────
  async function handleConvertMonth(monthNum) {
    if (!accessToken || converting) return;

    setConverting(true);
    setConvertingMonth(monthNum);
    setProgress(null);
    setResult(null);

    let success = 0, failed = 0, skipped = 0;
    const errors = [];

    try {
      // 1. Drive에서 해당 월 모든 선박 폴더 조회
      const monthStr = String(monthNum).padStart(2, "0");
      const folders = await collectMonthData(
        CONFIG.DRIVE_ROOT_FOLDER_ID, year, monthNum, accessToken
      );

      if (!folders || folders.length === 0) {
        setResult({ success: 0, failed: 0, skipped: 0, errors: ["해당 월에 수신 폴더가 없습니다."] });
        return;
      }

      // 2. 변환 작업 목록 구축 (CSV 없는 PDF만)
      const tasks = [];
      for (const folder of folders) {
        const vesselCode = extractVesselCode(folder.vesselFolderName);
        const existingCsvs = new Set(
          (folder.csvFiles || []).map(f => f.name.toUpperCase())
        );

        for (const pdf of (folder.pdfs || [])) {
          if (pdf.name.toUpperCase().includes("BWRB")) continue;

          const logType = detectLogType(pdf.name);
          const csvName = buildCsvFileName(vesselCode, year, monthStr, logType);

          // 이미 CSV가 있으면 skip
          if (existingCsvs.has(csvName.toUpperCase())) continue;

          tasks.push({
            pdf,
            folderId: folder.folderId,
            vesselCode,
            logType,
            csvName,
          });
        }
      }

      if (tasks.length === 0) {
        setResult({ success: 0, failed: 0, skipped: 0, errors: [], message: "변환할 파일이 없습니다 (모든 CSV가 이미 존재)." });
        return;
      }

      // 3. 순차 처리
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        setProgress({ current: i + 1, total: tasks.length, vesselName: t.vesselCode, logType: t.logType });

        try {
          const cfResult = await callCloudFunction(t.pdf.id, accessToken);

          if (cfResult.status === "skipped") {
            skipped++;
            continue;
          }
          if (cfResult.status === "error") {
            failed++;
            errors.push(`${t.vesselCode} ${t.logType}: ${cfResult.message}`);
            continue;
          }

          // Drive에 업로드
          await uploadCsvToDrive(t.folderId, t.csvName, cfResult.csv_content, accessToken);
          success++;

          if (cfResult.warning) {
            errors.push(`${t.vesselCode} ${t.logType}: ${cfResult.warning} (변환은 완료)`);
          }
        } catch (err) {
          failed++;
          errors.push(`${t.vesselCode} ${t.logType}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`전체 오류: ${err.message}`);
      failed++;
    } finally {
      setConverting(false);
      setConvertingMonth(null);
      setProgress(null);
      setResult({ success, failed, skipped, errors });
    }
  }

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

      {/* 진행 표시 */}
      {progress && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 flex items-center gap-3">
          <span className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin shrink-0" />
          <div className="text-sm text-blue-700">
            <span className="font-semibold">{progress.vesselName}</span> {progress.logType} 변환 중...
            <span className="ml-2 text-blue-500">({progress.current}/{progress.total})</span>
          </div>
        </div>
      )}

      {/* 결과 요약 */}
      {result && (
        <div className={`mb-4 border rounded-xl px-5 py-3 ${
          result.failed > 0 ? "bg-amber-50 border-amber-200" : "bg-green-50 border-green-200"
        }`}>
          <div className="flex items-center justify-between">
            <div className="text-sm">
              {result.message ? (
                <span className="text-slate-600">{result.message}</span>
              ) : (
                <>
                  <span className="text-green-700 font-semibold">{result.success}건 완료</span>
                  {result.failed > 0 && <span className="text-red-600 font-semibold ml-2">{result.failed}건 실패</span>}
                  {result.skipped > 0 && <span className="text-slate-500 ml-2">{result.skipped}건 제외</span>}
                </>
              )}
            </div>
            <button onClick={() => setResult(null)} className="text-slate-400 hover:text-slate-600 text-sm">✕</button>
          </div>
          {result.errors?.length > 0 && (
            <div className="mt-2 text-xs text-red-600 space-y-0.5">
              {result.errors.map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}
        </div>
      )}

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
                  {monthSummary[m - 1] > 0 && (
                    <div className="text-[10px] font-normal text-slate-300 mt-0.5">
                      {monthSummary[m - 1]}척
                    </div>
                  )}
                  {/* CSV 변환 버튼 (관리자 전용) */}
                  {accessToken && isAdmin && (
                    <button
                      onClick={() => handleConvertMonth(m)}
                      disabled={converting}
                      className={`mt-1 px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                        convertingMonth === m
                          ? "bg-blue-500 text-white"
                          : "bg-slate-100 text-slate-400 hover:bg-blue-100 hover:text-blue-600"
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {convertingMonth === m ? "변환중..." : "CSV"}
                    </button>
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

                {months.map((status, idx) => (
                  <td key={idx} className="px-2 py-3 text-center">
                    <div className="flex items-center justify-center">
                      <StatusCell status={status} />
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
