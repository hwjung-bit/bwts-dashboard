// CalibrationView — BWTS 검교정 이력 조회 & 편집
import { useState, useEffect, useCallback } from "react";
import { CALIB_CONFIG } from "../config.js";
import {
  getSheetNameByGid,
  readCalibration,
  updateCalibCell,
} from "../services/sheetsService.js";

const STATUS_OPTIONS = CALIB_CONFIG.STATUS_OPTIONS;

const STATUS_STYLE = {
  "진행 예정":   "bg-blue-50 text-blue-700 border-blue-200",
  "확인필요":    "bg-amber-50 text-amber-700 border-amber-200",
  "업체요청필요": "bg-red-50 text-red-700 border-red-200",
  "":           "bg-slate-50 text-slate-400 border-slate-200",
};

/** "2025. 9. 6." 같은 한국식 날짜 문자열 → Date 변환 */
function parseKoreanDate(str) {
  if (!str) return null;
  const m = str.replace(/\s/g, "").match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})\.?$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function isOverdue(dateStr) {
  const d = parseKoreanDate(dateStr);
  if (!d) return false;
  return d < new Date(new Date().setHours(0, 0, 0, 0));
}

export default function CalibrationView({ accessToken }) {
  const [rows, setRows]           = useState([]);
  const [edited, setEdited]       = useState({});   // { rowIndex: { note, date, status } }
  const [sheetName, setSheetName] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [saving, setSaving]       = useState({});   // { rowIndex: true/false }
  const [toast, setToast]         = useState("");
  const [error, setError]         = useState("");

  // 데이터 로드
  const loadData = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      let name = sheetName;
      if (!name) {
        name = await getSheetNameByGid(CALIB_CONFIG.SHEET_ID, CALIB_CONFIG.GID, accessToken);
        if (!name) throw new Error("시트 탭명을 가져올 수 없습니다 (gid: " + CALIB_CONFIG.GID + ")");
        setSheetName(name);
      }
      const data = await readCalibration(CALIB_CONFIG.SHEET_ID, name, accessToken);
      setRows(data);
      setEdited({});
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  // sheetName 의존성은 내부 캐시용 — 변경 시 재호출 불필요
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  useEffect(() => { loadData(); }, [loadData]);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  }

  function handleChange(rowIndex, field, value) {
    setEdited((prev) => ({
      ...prev,
      [rowIndex]: { ...(prev[rowIndex] || {}), [field]: value },
    }));
  }

  function getVal(row, field) {
    return edited[row.rowIndex]?.[field] !== undefined
      ? edited[row.rowIndex][field]
      : row[field];
  }

  function isDirty(rowIndex) {
    return !!edited[rowIndex] && Object.keys(edited[rowIndex]).length > 0;
  }

  async function handleSave(row) {
    const changes = edited[row.rowIndex];
    if (!changes || Object.keys(changes).length === 0) return;
    if (!sheetName) return;

    setSaving((s) => ({ ...s, [row.rowIndex]: true }));
    try {
      const colMap = { note: "B", date: "C", status: "D" };
      for (const [field, value] of Object.entries(changes)) {
        await updateCalibCell(
          CALIB_CONFIG.SHEET_ID,
          sheetName,
          row.rowIndex,
          colMap[field],
          value,
          accessToken
        );
      }
      // 로컬 state 반영
      setRows((prev) =>
        prev.map((r) =>
          r.rowIndex === row.rowIndex ? { ...r, ...changes } : r
        )
      );
      setEdited((prev) => {
        const next = { ...prev };
        delete next[row.rowIndex];
        return next;
      });
      showToast(`${row.vesselCode} 저장 완료 ✓`);
    } catch (e) {
      showToast(`저장 실패: ${e.message}`);
    } finally {
      setSaving((s) => ({ ...s, [row.rowIndex]: false }));
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-[#003c69]" style={{ fontFamily: "'Manrope', sans-serif" }}>
            🔧 Calibration History
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            BWTS 연간 검교정 이력 — 수정 후 💾 저장하면 Google Sheets에 즉시 반영됩니다
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 transition-colors shadow-sm"
        >
          <span className={`material-symbols-outlined text-base ${loading ? "animate-spin" : ""}`}>
            refresh
          </span>
          새로고침
        </button>
      </div>

      {/* 오류 */}
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600 flex items-center gap-2">
          <span className="material-symbols-outlined text-base">error</span>
          {error}
        </div>
      )}

      {/* 토스트 */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#003c69] text-white px-5 py-3 rounded-xl shadow-lg text-sm font-medium animate-fade-in">
          {toast}
        </div>
      )}

      {/* 테이블 */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        {/* 테이블 헤더 */}
        <div className="grid grid-cols-[80px_1fr_160px_160px_56px] gap-0 bg-slate-50 border-b border-slate-200 px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">
          <div>선명</div>
          <div>특이사항</div>
          <div>날짜</div>
          <div>진행상황</div>
          <div></div>
        </div>

        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-slate-400 text-sm gap-2">
            <span className="w-5 h-5 border-2 border-slate-200 border-t-blue-500 rounded-full animate-spin" />
            데이터 로드 중...
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-slate-400 text-sm">데이터가 없습니다.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((row) => {
              const dateVal   = getVal(row, "date");
              const noteVal   = getVal(row, "note");
              const statusVal = getVal(row, "status");
              const overdue   = isOverdue(dateVal);
              const dirty     = isDirty(row.rowIndex);
              const isSaving  = saving[row.rowIndex];

              return (
                <div
                  key={row.rowIndex}
                  className={`grid grid-cols-[80px_1fr_160px_160px_56px] gap-0 px-4 py-2.5 items-center transition-colors ${
                    dirty ? "bg-blue-50/40" : "hover:bg-slate-50/50"
                  }`}
                >
                  {/* 선명 */}
                  <div className="font-semibold text-sm text-[#003c69]">{row.vesselCode}</div>

                  {/* 특이사항 */}
                  <div className="pr-3">
                    <input
                      type="text"
                      value={noteVal}
                      onChange={(e) => handleChange(row.rowIndex, "note", e.target.value)}
                      placeholder="—"
                      className="w-full text-sm bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-400 focus:outline-none py-0.5 text-slate-700 placeholder-slate-300 transition-colors"
                    />
                  </div>

                  {/* 날짜 */}
                  <div className="pr-3">
                    <input
                      type="text"
                      value={dateVal}
                      onChange={(e) => handleChange(row.rowIndex, "date", e.target.value)}
                      placeholder="예: 2025. 9. 6."
                      className={`w-full text-sm bg-transparent border-b border-transparent hover:border-slate-300 focus:border-blue-400 focus:outline-none py-0.5 placeholder-slate-300 transition-colors ${
                        overdue ? "text-red-500 font-medium" : "text-slate-700"
                      }`}
                    />
                  </div>

                  {/* 진행상황 */}
                  <div className="pr-3">
                    <select
                      value={statusVal}
                      onChange={(e) => handleChange(row.rowIndex, "status", e.target.value)}
                      className={`w-full text-xs font-medium border rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-200 cursor-pointer transition-colors ${
                        STATUS_STYLE[statusVal] || STATUS_STYLE[""]
                      }`}
                    >
                      {STATUS_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt || "—"}</option>
                      ))}
                    </select>
                  </div>

                  {/* 저장 버튼 */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => handleSave(row)}
                      disabled={!dirty || isSaving}
                      title="저장"
                      className={`w-8 h-8 flex items-center justify-center rounded-lg text-sm transition-colors ${
                        dirty
                          ? "bg-[#003c69] text-white hover:bg-[#004d8a] shadow-sm"
                          : "text-slate-300 cursor-default"
                      }`}
                    >
                      {isSaving
                        ? <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                        : <span className="material-symbols-outlined" style={{ fontSize: 16 }}>save</span>
                      }
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="flex items-center gap-4 mt-4 text-xs text-slate-400">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block" />
          날짜 경과 (빨간색)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-100 border border-blue-200 inline-block" />
          수정됨 (저장 전)
        </span>
        <span className="ml-auto">
          시트: <span className="font-medium text-slate-500">{sheetName || "로딩 중..."}</span>
        </span>
      </div>
    </div>
  );
}
