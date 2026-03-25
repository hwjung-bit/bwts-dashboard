// RemarkPanel (ReviewPanel) - 검토 & 본선 지침 전달
import { useState } from 'react';
import { generateFinalRemark } from '../services/geminiService.js';
import { sendMail, buildMailBody, buildMailSubject } from '../services/gmailService.js';


export default function RemarkPanel({ vessel, analysisResult, accessToken, onUpdate, period }) {
  const lang = vessel?.mailLang || "ko";
  const [note, setNote]     = useState(vessel?.reviewNote || "");
  const [remark, setRemark] = useState(vessel?.reviewRemark || "");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError]     = useState("");

  // Email state
  const [showEmail, setShowEmail]   = useState(false);
  const [emailTo, setEmailTo]       = useState(vessel?.contactEmail || "");
  const [sending, setSending]       = useState(false);
  const [sent, setSent]             = useState(false);
  const [sendError, setSendError]   = useState("");

  const isReviewed = vessel?.reviewed === true || vessel?.analysisStatus === "REVIEWED";
  const canSendMail = !!vessel?.analysisResult || isReviewed;

  async function handleGenerateAi() {
    if (!analysisResult) { setAiError("먼저 PDF 분석을 완료해주세요."); return; }
    setAiLoading(true);
    setAiError("");
    try {
      const finalRemark = await generateFinalRemark(analysisResult, note, lang);
      setRemark(finalRemark);
      onUpdate?.({ reviewNote: note, reviewRemark: finalRemark });
    } catch (e) {
      setAiError(`리마크 생성 실패: ${e.message}`);
    } finally {
      setAiLoading(false);
    }
  }

  function handleSaveNote() {
    onUpdate?.({ reviewNote: note, reviewRemark: remark });
  }

  function handleMarkReviewed() {
    // AI 판정 유지 + 검토완료 플래그만 추가
    onUpdate?.({
      reviewNote: note,
      reviewRemark: remark,
      reviewed: true,
      reviewedAt: new Date().toISOString(),
    });
  }

  function handleNormalOverride() {
    // 정상확인: AI 판정과 무관하게 이상없음으로 오버라이드
    onUpdate?.({
      reviewNote: note,
      reviewRemark: remark,
      reviewed: true,
      analysisStatus: "NORMAL",
      reviewedAt: new Date().toISOString(),
    });
  }

  async function handleSendEmail() {
    setSending(true);
    setSendError("");
    try {
      const subject = buildMailSubject(vessel, analysisResult?.period || period || "-", analysisResult?.overall_status, lang);
      const body = buildMailBody(vessel, analysisResult || {}, remark || note || "", lang);
      await sendMail({ to: emailTo, subject, body, accessToken });
      setSent(true);
      setShowEmail(false);
      onUpdate?.({ lastMailSentAt: new Date().toISOString() });
    } catch (e) {
      setSendError(`발송 실패: ${e.message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 mt-4">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-700">📝 검토 &amp; 본선 지침 전달</h3>
        {isReviewed && (
          <span className="text-xs bg-indigo-100 text-indigo-700 border border-indigo-200 px-2.5 py-1 rounded-full font-medium">
            ✓ 검토완료
            {vessel?.reviewedAt && (
              <span className="ml-1 opacity-70">
                {new Date(vessel.reviewedAt).toLocaleDateString("ko-KR")}
              </span>
            )}
          </span>
        )}
      </div>

      {/* 담당자 검토 내용 */}
      <div className="mb-4">
        <label className="block text-xs text-slate-500 mb-2 font-medium">담당자 검토 내용</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="예: TRO 센서 수치 이상. 기관실 점검 요청 및 다음 항차 재확인 필요."
          className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none"
        />
      </div>

      {/* 액션 버튼 */}
      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={handleSaveNote}
          className="px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 rounded-lg transition-colors"
        >
          메모 저장
        </button>
        <button
          onClick={handleGenerateAi}
          disabled={aiLoading || !analysisResult}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg transition-colors flex items-center gap-2"
        >
          {aiLoading ? (
            <><span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />AI 생성중...</>
          ) : "🤖 AI 리마크 생성"}
        </button>
        {!isReviewed && analysisResult && (
          <>
            <button
              onClick={handleMarkReviewed}
              className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
            >
              ✓ 검토 완료
            </button>
            {["CRITICAL", "WARNING"].includes(vessel?.analysisStatus) && (
              <button
                onClick={handleNormalOverride}
                className="px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
              >
                ✅ 정상 확인
              </button>
            )}
          </>
        )}
      </div>

      {aiError && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
          {aiError}
        </div>
      )}

      {/* AI 리마크 */}
      {remark && (
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-4">
          <div className="text-xs text-blue-600 font-medium mb-2">AI + 담당자 최종 리마크</div>
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{remark}</p>
        </div>
      )}

      {/* 메일 발송 섹션 */}
      {canSendMail && (
        <div className="border-t border-slate-100 pt-4">
          {sent ? (
            <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl p-3">
              <span className="text-green-500 text-lg">✓</span>
              <div>
                <div className="text-sm text-green-700 font-medium">본선 지침 메일 발송 완료</div>
                <div className="text-xs text-green-500">{emailTo}로 발송되었습니다.</div>
              </div>
              <button
                onClick={() => { setSent(false); setShowEmail(true); }}
                className="ml-auto text-xs text-slate-400 hover:text-slate-600"
              >
                재발송
              </button>
            </div>
          ) : !showEmail ? (
            <button
              onClick={() => setShowEmail(true)}
              className="px-4 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
            >
              ✉️ 본선 지침 전달
            </button>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1.5 font-medium">수신자 이메일</label>
                <input
                  type="email"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div className="text-xs text-slate-400 mb-2 font-medium">본문 미리보기</div>
                <pre className="text-xs text-slate-600 whitespace-pre-wrap font-sans leading-relaxed max-h-40 overflow-y-auto">
                  {buildMailBody(vessel, analysisResult || {}, remark || note || "", lang)}
                </pre>
              </div>

              {sendError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {sendError}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={() => setShowEmail(false)}
                  className="flex-1 px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 rounded-lg transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleSendEmail}
                  disabled={sending || !emailTo || !accessToken}
                  className="flex-1 px-4 py-2 text-sm bg-green-600 hover:bg-green-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {sending ? (
                    <><span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />발송중...</>
                  ) : "✉️ 발송 확인"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
