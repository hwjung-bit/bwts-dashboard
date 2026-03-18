// MailSender - 메일 발송 UI (라이트 테마)
import { useState, useEffect } from "react";
import { sendMail, buildMailBody, buildMailSubject } from "../services/gmailService.js";

export default function MailSender({ vessel, analysisResult, finalRemark, accessToken }) {
  const lang    = vessel?.mailLang || "ko";
  const langLabel = lang === "en" ? "🇬🇧 English" : "🇰🇷 한국어";

  const [showConfirm, setShowConfirm] = useState(false);
  const [customTo, setCustomTo]       = useState(vessel?.contactEmail || "");
  const [sending, setSending]         = useState(false);
  const [sent, setSent]               = useState(false);
  const [error, setError]             = useState("");

  // vessel 설정이 변경되면 수신자 이메일 자동 반영
  useEffect(() => {
    if (vessel?.contactEmail) setCustomTo(vessel.contactEmail);
  }, [vessel?.contactEmail]);

  const status  = analysisResult?.overall_status || "UNKNOWN";
  const period  = analysisResult?.period || "-";
  const subject = buildMailSubject(vessel, period, status, lang);
  const body    = buildMailBody(vessel, analysisResult || {}, finalRemark || "", lang);

  async function handleSend() {
    setSending(true);
    setError("");
    try {
      await sendMail({ to: customTo, subject, body, accessToken });
      setSent(true);
      setShowConfirm(false);
    } catch (e) {
      setError(`발송 실패: ${e.message}`);
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 mt-4 flex items-center gap-3">
        <span className="text-green-500 text-lg">✓</span>
        <div>
          <div className="text-sm text-green-700 font-medium">메일 발송 완료</div>
          <div className="text-xs text-green-500">{customTo}로 발송되었습니다.</div>
        </div>
        <button onClick={() => setSent(false)} className="ml-auto text-xs text-slate-400 hover:text-slate-600">다시 발송</button>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 mt-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-700">✉️ 메일 발송</h3>
        <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{langLabel}</span>
      </div>

      {!showConfirm ? (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-xs text-slate-400 mb-1">수신자</div>
            <div className="text-sm text-slate-700">{vessel?.contactEmail || "(이메일 미설정)"}</div>
          </div>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={!vessel?.contactEmail && !customTo}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg transition-colors"
          >
            메일 발송
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1.5 font-medium">수신자 이메일 확인</label>
            <input
              type="email"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
            <div className="text-slate-400 mb-1 font-medium">제목</div>
            <div className="text-slate-700">{subject}</div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="text-slate-400 font-medium">본문 미리보기</span>
              <span className="text-slate-400">{langLabel}</span>
            </div>
            <pre className="text-slate-600 whitespace-pre-wrap font-sans leading-relaxed max-h-48 overflow-y-auto">{body}</pre>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex gap-3">
            <button onClick={() => setShowConfirm(false)}
              className="flex-1 px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 rounded-lg transition-colors">
              취소
            </button>
            <button onClick={handleSend} disabled={sending || !customTo}
              className="flex-1 px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg transition-colors flex items-center justify-center gap-2">
              {sending ? (
                <><span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />발송중...</>
              ) : "✉️ 발송 확인"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
