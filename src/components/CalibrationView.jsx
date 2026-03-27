// CalibrationView — BWTS 검교정 이력 조회 & 편집
import { useState, useEffect, useCallback } from "react";
import { CONFIG, CALIB_CONFIG } from "../config.js";
import {
  getSheetNameByGid,
  listSheetNames,
  readCalibration,
  updateCalibCell,
} from "../services/sheetsService.js";

// 검교정 시트는 메인 스프레드시트 내 별도 탭 (CALIB_CONFIG.SHEET_ID가 없으면 CONFIG.SHEETS_ID 사용)
const CALIB_SHEET_ID = CALIB_CONFIG.SHEET_ID || CONFIG.SHEETS_ID;

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

/** 3단계 상태 분류
 *  'valid'    — 완료 (날짜 없음 or 10개월 미만 경과)
 *  'expiring' — 만료예정 (10~12개월 경과)
 *  'expired'  — 만료 (12개월 초과)
 */
function getCalibStatus(dateStr) {
  if (!dateStr || dateStr.trim() === "" || dateStr === "-") return "valid";
  const d = parseKoreanDate(dateStr);
  if (!d) return "valid";
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const exp10 = new Date(d); exp10.setMonth(exp10.getMonth() + 10);
  const exp12 = new Date(d); exp12.setMonth(exp12.getMonth() + 12);
  if (today >= exp12) return "expired";
  if (today >= exp10) return "expiring";
  return "valid";
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
        // SHEET_NAME이 설정된 경우 GID 조회 없이 직접 사용
        if (CALIB_CONFIG.SHEET_NAME) {
          name = CALIB_CONFIG.SHEET_NAME;
        } else {
          name = await getSheetNameByGid(CALIB_SHEET_ID, CALIB_CONFIG.GID, accessToken);
          if (!name) throw new Error("시트 탭명을 가져올 수 없습니다 (gid: " + CALIB_CONFIG.GID + ")");
        }
        setSheetName(name);
      }
      const data = await readCalibration(CALIB_SHEET_ID, name, accessToken);
      setRows(data);
      setEdited({});
    } catch (e) {
      // 400 에러 시 실제 탭 목록 조회해서 힌트 제공
      if (e.message.includes("400")) {
        const names = await listSheetNames(CALIB_SHEET_ID, accessToken).catch(() => []);
        const hint = names.length > 0
          ? `\n실제 탭 목록: ${names.map(n => `"${n}"`).join(", ")}`
          : "";
        setError(e.message + hint);
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
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
          CALIB_SHEET_ID,
          sheetName,
          row.rowIndex,
          colMap[field],
          value,
          accessToken
        );
      }
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

  // 현황 카운트
  const statusCounts = rows.reduce(
    (acc, row) => {
      const s = getCalibStatus(getVal(row, "date"));
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    { valid: 0, expiring: 0, expired: 0 }
  );

  return (
    <div className="max-w-5xl mx-auto flex gap-6 items-start">
      {/* ── 좌측: 테이블 영역 ── */}
      <div className="flex-1 min-w-0">
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
          <div className="fixed bottom-6 right-6 z-50 bg-[#003c69] text-white px-5 py-3 rounded-xl shadow-lg text-sm font-medium">
            {toast}
          </div>
        )}

        {/* 테이블 */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
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
                const calibSt   = getCalibStatus(dateVal);
                const overdue   = calibSt !== "valid";
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
                          calibSt === "expired"  ? "text-red-500 font-medium" :
                          calibSt === "expiring" ? "text-orange-500 font-medium" :
                          "text-slate-700"
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
            <span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block" />
            만료예정 (검교정 후 10개월 경과)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" />
            만료 (1년 초과)
          </span>
          <span className="ml-auto">
            시트: <span className="font-medium text-slate-500">{sheetName || "로딩 중..."}</span>
          </span>
        </div>
      </div>

      {/* ── 우측: 현황 대쉬보드 ── */}
      <div className="w-44 flex-shrink-0 flex flex-col gap-3 pt-1">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
          검교정 현황
        </div>

        {/* 완료 */}
        <div className="bg-green-50 border border-green-100 rounded-2xl p-4 text-center shadow-sm">
          <div className="text-4xl font-bold text-green-600 leading-none">
            {loading ? "—" : statusCounts.valid}
          </div>
          <div className="text-sm font-semibold text-green-600 mt-2">완료</div>
          <div className="text-[11px] text-green-400 mt-0.5">유효기간 내</div>
        </div>

        {/* 만료예정 */}
        <div className="bg-orange-50 border border-orange-100 rounded-2xl p-4 text-center shadow-sm">
          <div className="text-4xl font-bold text-orange-500 leading-none">
            {loading ? "—" : statusCounts.expiring}
          </div>
          <div className="text-sm font-semibold text-orange-500 mt-2">만료예정</div>
          <div className="text-[11px] text-orange-400 mt-0.5">2개월 이내</div>
        </div>

        {/* 만료 */}
        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 text-center shadow-sm">
          <div className="text-4xl font-bold text-red-500 leading-none">
            {loading ? "—" : statusCounts.expired}
          </div>
          <div className="text-sm font-semibold text-red-500 mt-2">만료</div>
          <div className="text-[11px] text-red-400 mt-0.5">1년 이상 경과</div>
        </div>

        {/* 총 척수 */}
        {!loading && rows.length > 0 && (
          <div className="text-center text-[11px] text-slate-400 mt-1">
            총 <span className="font-semibold text-slate-500">{rows.length}</span>척
          </div>
        )}
      </div>
    </div>
  );
}
