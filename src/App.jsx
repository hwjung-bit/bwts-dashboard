import { useState, useCallback, useEffect } from "react";
import { CONFIG, INITIAL_VESSELS } from "./config.js";
import { readVessels, writeVessels } from "./services/sheetsService.js";
import Dashboard from "./components/Dashboard.jsx";
import VesselManager from "./components/VesselManager.jsx";
import ShipLogs from "./components/ShipLogs.jsx";

async function fetchUserEmail(accessToken) {
  const res = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.email || null;
}

function loadGsi() {
  return new Promise((resolve) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = resolve;
    document.head.appendChild(script);
  });
}

const LS_KEY = "bwts_vessels";
function loadVessels() {
  try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function saveVessels(vessels) { localStorage.setItem(LS_KEY, JSON.stringify(vessels)); }

export default function App() {
  const [vessels, setVesselsRaw]      = useState(() => loadVessels() || INITIAL_VESSELS);
  const [accessToken, setAccessToken] = useState(null);
  const [userEmail, setUserEmail]     = useState(null);
  const [authError, setAuthError]     = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [autoLoginDone, setAutoLoginDone] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [sheetsError, setSheetsError] = useState("");
  const [activeView, setActiveView] = useState("dashboard");

  const isAdmin = userEmail && CONFIG.ADMIN_EMAIL !== "YOUR_ADMIN_EMAIL@gmail.com"
    ? userEmail === CONFIG.ADMIN_EMAIL
    : !!accessToken;

  const setVessels = useCallback((updater, token) => {
    setVesselsRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveVessels(next);
      const tok = token || accessToken;
      if (tok && CONFIG.SHEETS_ID) {
        writeVessels(CONFIG.SHEETS_ID, next, tok).catch(console.warn);
      }
      return next;
    });
  }, [accessToken]);

  async function onLoginSuccess(token, email) {
    localStorage.setItem("bwts_user_email", email);
    setAccessToken(token);
    setUserEmail(email);
    if (CONFIG.SHEETS_ID) {
      try {
        const sheetVessels = await readVessels(CONFIG.SHEETS_ID, token);
        if (sheetVessels.length > 0) {
          setVesselsRaw(sheetVessels);
          saveVessels(sheetVessels);
          setSheetsError("");
        } else {
          const localVessels = loadVessels() || INITIAL_VESSELS;
          writeVessels(CONFIG.SHEETS_ID, localVessels, token).catch(console.warn);
          setSheetsError("Sheets가 비어있어 로컬 데이터를 사용합니다.");
        }
      } catch (e) {
        setSheetsError(`Sheets 로드 실패: ${e.message}`);
      }
    }
    setAuthLoading(false);
  }

  async function requestToken(silent = false) {
    await loadGsi();
    return new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope: CONFIG.SCOPES,
        prompt: silent ? "" : undefined,
        callback: (tokenResponse) => {
          if (tokenResponse.error) reject(new Error(tokenResponse.error));
          else resolve(tokenResponse.access_token);
        },
        error_callback: (err) => reject(new Error(err?.type || "auth_error")),
      });
      client.requestAccessToken(silent ? { prompt: "" } : {});
    });
  }

  useEffect(() => {
    const savedEmail = localStorage.getItem("bwts_user_email");
    if (!savedEmail) { setAutoLoginDone(true); return; }
    setAuthLoading(true);
    requestToken(true)
      .then((token) => fetchUserEmail(token).then((email) => {
        if (email && email.endsWith("@ekmtc.com")) return onLoginSuccess(token, email);
        localStorage.removeItem("bwts_user_email");
        setAuthLoading(false);
      }))
      .catch(() => setAuthLoading(false))
      .finally(() => setAutoLoginDone(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin() {
    setAuthLoading(true);
    setAuthError("");
    try {
      const token = await requestToken(false);
      const email = await fetchUserEmail(token);
      if (!email || !email.endsWith("@ekmtc.com")) {
        window.google?.accounts?.oauth2?.revoke(token);
        setAuthError("회사 계정(@ekmtc.com)으로만 접속 가능합니다.");
        setAuthLoading(false);
        return;
      }
      await onLoginSuccess(token, email);
    } catch (e) {
      setAuthError(`로그인 실패: ${e.message}`);
      setAuthLoading(false);
    }
  }

  function handleLogout() {
    if (accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(accessToken);
    }
    localStorage.removeItem("bwts_user_email");
    setAccessToken(null);
    setUserEmail(null);
  }

  function addVessel(vessel)   { setVessels((prev) => [...prev, vessel]); }
  function updateVessel(upd)   { setVessels((prev) => prev.map((v) => v.id === upd.id ? upd : v)); }
  function deleteVessel(id)    { setVessels((prev) => prev.filter((v) => v.id !== id)); }

  const isConfigured =
    CONFIG.GOOGLE_CLIENT_ID !== "YOUR_GOOGLE_CLIENT_ID_HERE" &&
    CONFIG.GEMINI_API_KEY !== "YOUR_GEMINI_API_KEY_HERE" &&
    CONFIG.DRIVE_ROOT_FOLDER_ID !== "YOUR_DRIVE_ROOT_FOLDER_ID_HERE";

  const initials = userEmail ? userEmail[0].toUpperCase() : "?";

  return (
    <div className="flex min-h-screen bg-[#f7f9fb] text-[#191c1e]" style={{ fontFamily: "'Inter', sans-serif" }}>

      {/* ── 사이드바 ── */}
      <aside className="fixed left-0 top-0 h-full w-64 bg-[#f2f4f6] border-r border-slate-200 z-50 flex flex-col">
        {/* 로고 */}
        <div className="px-5 pt-7 pb-4">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 bg-[#003c69] rounded-xl flex items-center justify-center text-white">
              <span className="material-symbols-outlined" style={{ fontSize: 20 }}>anchor</span>
            </div>
            <div>
              <h1 className="font-bold text-[#003c69] text-sm leading-tight" style={{ fontFamily: "'Manrope', sans-serif" }}>BWTS Monitor</h1>
              <p className="text-[11px] text-slate-500">Vessel Logistics</p>
            </div>
          </div>

          {/* 네비게이션 */}
          <nav className="space-y-1">
            <button
              onClick={() => setActiveView("dashboard")}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors text-left ${
                activeView === "dashboard"
                  ? "bg-white text-[#003c69] shadow-sm"
                  : "text-slate-500 hover:text-[#003c69] hover:bg-white/70"
              }`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>dashboard</span>
              Dashboard
            </button>
            <button
              onClick={() => setActiveView("shiplogs")}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors text-left ${
                activeView === "shiplogs"
                  ? "bg-white text-[#003c69] shadow-sm font-semibold"
                  : "text-slate-500 hover:text-[#003c69] hover:bg-white/70"
              }`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>sailing</span>
              Ship Logs
            </button>
            <div className="flex items-center gap-3 px-4 py-2.5 text-slate-300 rounded-xl text-sm font-medium cursor-not-allowed">
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>assessment</span>
              Reports
              <span className="ml-auto text-[10px] bg-slate-100 text-slate-300 px-1.5 py-0.5 rounded-full">준비중</span>
            </div>
            {isAdmin && (
              <button
                onClick={() => setShowManager(true)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-slate-500 hover:text-[#003c69] hover:bg-white/70 rounded-xl text-sm font-medium cursor-pointer transition-colors text-left"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>settings_applications</span>
                선박 관리
              </button>
            )}
          </nav>
        </div>

        {/* 하단 사용자 영역 */}
        <div className="mt-auto px-5 py-5 border-t border-slate-200/70 space-y-1">
          {accessToken ? (
            <>
              <div className="flex items-center gap-3 px-3 py-2 mb-1">
                <div className="w-8 h-8 rounded-full bg-[#003c69] text-white text-xs flex items-center justify-center font-bold shrink-0">
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-700 truncate">{userEmail}</p>
                  {isAdmin && <p className="text-[10px] text-amber-600 font-semibold">관리자</p>}
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-slate-500 hover:text-red-500 hover:bg-red-50 rounded-xl text-sm font-medium transition-colors text-left"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>logout</span>
                로그아웃
              </button>
            </>
          ) : (
            <button
              onClick={handleLogin}
              disabled={authLoading || !isConfigured}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-[#003c69] bg-white hover:bg-blue-50 rounded-xl text-sm font-semibold transition-colors text-left shadow-sm"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>login</span>
              {authLoading ? "인증중..." : "Google 로그인"}
            </button>
          )}
        </div>
      </aside>

      {/* ── 메인 콘텐츠 ── */}
      <div className="flex-1 ml-64 flex flex-col min-h-screen">
        {/* 상단 헤더 */}
        <header className="sticky top-0 z-40 bg-[#f7f9fb] border-b border-slate-200/60 px-8 py-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-[#003c69]" style={{ fontFamily: "'Manrope', sans-serif" }}>
            BWTS Log Analyzer
          </h2>
          <div className="flex items-center gap-3">
            {!accessToken && (
              <button
                onClick={handleLogin}
                disabled={authLoading || !isConfigured}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-[#003c69] hover:bg-[#004d8a] disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg transition-colors font-medium"
              >
                {authLoading ? (
                  <><span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />인증중...</>
                ) : (
                  <><span className="material-symbols-outlined" style={{ fontSize: 16 }}>key</span>Google 로그인</>
                )}
              </button>
            )}
          </div>
        </header>

        {/* 콘텐츠 */}
        <main className="flex-1 px-8 py-6">
          {!isConfigured && (
            <div className="mb-5 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
              <div className="text-amber-700 font-medium text-sm mb-1">⚙️ API 키 설정 필요</div>
              <p className="text-amber-600 text-xs leading-relaxed">
                <code className="bg-amber-100 px-1 rounded text-amber-800">src/config.js</code>에서 GOOGLE_CLIENT_ID, GEMINI_API_KEY, DRIVE_ROOT_FOLDER_ID, ADMIN_EMAIL을 입력하세요.
              </p>
            </div>
          )}

          {authError && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
              {authError}
            </div>
          )}
          {sheetsError && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700 flex justify-between items-center">
              <span>⚠️ {sheetsError}</span>
              <button onClick={() => setSheetsError("")} className="text-amber-400 hover:text-amber-600 ml-4">✕</button>
            </div>
          )}

          {!autoLoginDone ? (
            <div className="flex items-center justify-center min-h-[60vh]">
              <span className="w-6 h-6 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
            </div>
          ) : accessToken ? (
            activeView === "shiplogs" ? (
              <ShipLogs vessels={vessels} />
            ) : (
              <Dashboard
                vessels={vessels}
                setVessels={setVessels}
                accessToken={accessToken}
                isAdmin={isAdmin}
              />
            )
          ) : (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-10 py-10 flex flex-col items-center gap-5 max-w-sm w-full">
                <div className="w-16 h-16 bg-[#003c69] rounded-2xl flex items-center justify-center text-white">
                  <span className="material-symbols-outlined" style={{ fontSize: 32 }}>anchor</span>
                </div>
                <div className="text-center">
                  <div className="font-bold text-slate-800 text-lg mb-1" style={{ fontFamily: "'Manrope', sans-serif" }}>BWTS LOG ANALYZER</div>
                  <div className="text-slate-500 text-sm">회사 계정으로 로그인하여 이용하세요</div>
                </div>
                {authError && (
                  <div className="w-full bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-600 text-center">{authError}</div>
                )}
                <button
                  onClick={handleLogin}
                  disabled={authLoading || !isConfigured}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#003c69] hover:bg-[#004d8a] disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-semibold rounded-xl transition-colors"
                >
                  {authLoading ? (
                    <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />인증중...</>
                  ) : (
                    <><span className="material-symbols-outlined" style={{ fontSize: 18 }}>key</span>Google 로그인 (@ekmtc.com)</>
                  )}
                </button>
                <p className="text-xs text-slate-400 text-center">ekmtc.com 도메인 계정만 접근 가능합니다</p>
              </div>
            </div>
          )}
        </main>
      </div>

      {showManager && isAdmin && (
        <VesselManager
          vessels={vessels}
          onAdd={addVessel}
          onUpdate={updateVessel}
          onDelete={deleteVessel}
          onClose={() => setShowManager(false)}
        />
      )}
    </div>
  );
}
