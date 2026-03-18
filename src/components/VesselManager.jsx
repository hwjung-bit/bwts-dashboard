// VesselManager - 선박 추가/수정/삭제 관리 UI (라이트 테마)
import { useState } from "react";

const EMPTY_VESSEL = {
  name: "", vesselCode: "", imoNumber: "", manufacturer: "Techcross",
  model: "", contactEmail: "", mailLang: "ko", note: "",
};

function VesselForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY_VESSEL, ...(initial || {}) });
  const update = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) onSave(form); }} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[
          { field: "name",         label: "선박명 *",    type: "text",  placeholder: "VESSEL A",          hint: "" },
          { field: "vesselCode",   label: "폴더 코드 *", type: "text",  placeholder: "KPS",                hint: "Drive 폴더 '01. KPS (수신)' → KPS 입력" },
          { field: "imoNumber",    label: "IMO 번호",     type: "text",  placeholder: "IMO1234567",        hint: "" },
          { field: "manufacturer", label: "BWTS 제조사",  type: "text",  placeholder: "Techcross",         hint: "" },
          { field: "model",        label: "모델명",        type: "text",  placeholder: "ECS-1000",          hint: "" },
          { field: "contactEmail", label: "담당자 이메일", type: "email", placeholder: "vessel@example.com",hint: "메일 발송 시 수신자로 자동 입력됩니다" },
        ].map(({ field, label, type, placeholder, hint }) => (
          <div key={field}>
            <label className="block text-xs text-slate-500 mb-1.5 font-medium">{label}</label>
            <input
              type={type}
              value={form[field] ?? ""}
              onChange={(e) => update(field, e.target.value)}
              placeholder={placeholder}
              className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
            {hint && <p className="text-[10px] text-slate-400 mt-1">{hint}</p>}
          </div>
        ))}
      </div>

      {/* 메일 언어 선택 */}
      <div>
        <label className="block text-xs text-slate-500 mb-1.5 font-medium">메일 발송 언어</label>
        <div className="flex gap-4">
          {[{ value: "ko", label: "🇰🇷 한국어" }, { value: "en", label: "🇬🇧 English" }].map(({ value, label }) => (
            <label key={value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="mailLang"
                value={value}
                checked={(form.mailLang || "ko") === value}
                onChange={() => update("mailLang", value)}
                className="accent-blue-600"
              />
              <span className="text-sm text-slate-700">{label}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] text-slate-400 mt-1">선박 담당자에게 발송되는 메일 본문 언어를 설정합니다.</p>
      </div>

      <div>
        <label className="block text-xs text-slate-500 mb-1.5 font-medium">메모</label>
        <input
          type="text"
          value={form.note ?? ""}
          onChange={(e) => update("note", e.target.value)}
          placeholder="관리 메모 (선택)"
          className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        />
      </div>
      <div className="flex gap-3 justify-end pt-2">
        <button type="button" onClick={onCancel}
          className="px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 rounded-lg transition-colors">
          취소
        </button>
        <button type="submit"
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
          저장
        </button>
      </div>
    </form>
  );
}

export default function VesselManager({ vessels, onAdd, onUpdate, onDelete, onClose }) {
  const [mode, setMode]                 = useState("list");
  const [editTarget, setEditTarget]     = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="text-base font-semibold text-slate-800">
            🛳 선박 관리{mode === "add" ? " — 추가" : mode === "edit" ? " — 수정" : ""}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
        </div>

        <div className="p-6">
          {mode === "list" && (
            <>
              <button onClick={() => setMode("add")}
                className="mb-4 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
                + 선박 추가
              </button>

              {vessels.length === 0 ? (
                <div className="text-center py-8 text-slate-400">등록된 선박이 없습니다.</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {vessels.map((v) => (
                    <div key={v.id}
                      className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-slate-700 text-sm font-mono">{v.vesselCode || v.name}</span>
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">{v.imoNumber} · {v.manufacturer} {v.model}</div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => { setEditTarget(v); setMode("edit"); }}
                          className="px-3 py-1.5 text-xs bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 rounded-lg transition-colors">
                          수정
                        </button>
                        <button onClick={() => setDeleteTarget(v)}
                          className="px-3 py-1.5 text-xs bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-lg transition-colors">
                          삭제
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {mode === "add" && (
            <VesselForm
              onSave={(form) => { onAdd({ ...form, id: `vessel_${Date.now()}` }); setMode("list"); }}
              onCancel={() => setMode("list")}
            />
          )}

          {mode === "edit" && editTarget && (
            <VesselForm
              initial={editTarget}
              onSave={(form) => { onUpdate({ ...editTarget, ...form }); setMode("list"); setEditTarget(null); }}
              onCancel={() => setMode("list")}
            />
          )}
        </div>
      </div>

      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 z-60 flex items-center justify-center">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xl p-6 w-80">
            <h3 className="font-semibold text-slate-800 mb-2">선박 삭제</h3>
            <p className="text-sm text-slate-500 mb-4">
              <span className="text-slate-700 font-medium">{deleteTarget.name}</span>을(를) 삭제하시겠습니까?
              <br />이 작업은 되돌릴 수 없습니다.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)}
                className="flex-1 px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 rounded-lg transition-colors">
                취소
              </button>
              <button onClick={() => { onDelete(deleteTarget.id); setDeleteTarget(null); }}
                className="flex-1 px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
