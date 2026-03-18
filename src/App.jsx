import { useState, useCallback, useEffect } from "react";
import { CONFIG, INITIAL_VESSELS } from "./config.js";
import { readVessels, writeVessels } from "./services/sheetsService.js";
import Dashboard from "./components/Dashboard.jsx";
import VesselManager from "./components/VesselManager.jsx";

// Google Tokeninfo로 로그인 계정 이메일 조회
async function fetchUserEmail(accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.email || null;
}

// ── Google Identity Services (GIS) 로드 ─────────────────────
function loadGsi() {
  return new Promise((resolve) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = resolve;
    document.head.appendChild(script);
  });
}

// ── 로컬 스토리지: 선박 데이터 영속화 ──────────────────────
const LS_KEY = "bwts_vessels";

function loadVessels() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveVessels(vessels) {
  localStorage.setItem(LS_KEY, JSON.stringify(vessels));
}

export default function App() {
  const [vessels, setVesselsRaw]      = useState(() => loadVessels() || INITIAL_VESSELS);
  const [accessToken, setAccessToken] = useState(null);
  const [userEmail, setUserEmail]     = useState(null);
  const [authError, setAuthError]     = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [autoLoginDone, setAutoLoginDone] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [sheetsError, setSheetsError] = useState("");

  const isAdmin = userEmail && CONFIG.ADMIN_EMAIL !== "YOUR_ADMIN_EMAIL@gmail.com"
    ? userEmail === CONFIG.ADMIN_EMAIL
    : !!accessToken;

  const setVessels = useCallback((updater, token) => {
    setVesselsRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveVessels(next);
      // Sheets 동기화 (accessToken은 클로저보다 인자 우선)
      const tok = token || accessToken;
      if (tok && CONFIG.SHEETS_ID) {
        writeVessels(CONFIG.SHEETS_ID, next, tok).catch(console.warn);
      }
      return next;
    });
  }, [accessToken]);

  // 로그인 성공 후 공통 처리
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

  // GIS 토큰 클라이언트 초기화 (prompt 제어용)
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

  // 페이지 로드 시 자동 재로그인 (이전에 로그인한 적 있는 경우)
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
      .catch(() => {
        // 자동 로그인 실패 시 로그인 화면 표시 (에러 노출 없이)
        setAuthLoading(false);
      })
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      {/* ── 헤더 ── */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">🚢</span>
            <span className="font-bold text-slate-800 text-base">BWTS LOG ANALYZER</span>
            <span className="text-xs text-slate-400 hidden sm:inline">자동 분석 대시보드</span>
          </div>

          <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                onClick={() => setShowManager(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 rounded-lg transition-colors"
              >
                🛳 선박관리
              </button>
            )}

            {accessToken ? (
              <div className="flex items-center gap-2">
                <div className="hidden sm:flex flex-col items-end">
                  {userEmail && (
                    <span className="text-xs text-slate-500 leading-tight">{userEmail}</span>
                  )}
                  {isAdmin && (
                    <span className="text-[10px] bg-amber-100 text-amber-700 border border-amber-300 px-1.5 py-0.5 rounded-full leading-tight">
                      관리자
                    </span>
                  )}
                </div>
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 rounded-lg transition-colors"
                >
                  <span className="w-2 h-2 bg-green-500 rounded-full" />
                  로그아웃
                </button>
              </div>
            ) : (
              <button
                onClick={handleLogin}
                disabled={authLoading || !isConfigured}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg transition-colors"
              >
                {authLoading ? (
                  <>
                    <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    인증중...
                  </>
                ) : (
                  "🔑 Google 로그인"
                )}
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── 메인 컨텐츠 ── */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {!isConfigured && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
            <div className="text-amber-700 font-medium text-sm mb-1">⚙️ API 키 설정 필요</div>
            <p className="text-amber-600 text-xs leading-relaxed">
              <code className="bg-amber-100 px-1 rounded text-amber-800">src/config.js</code>에서{" "}
              <code className="bg-amber-100 px-1 rounded text-amber-800">GOOGLE_CLIENT_ID</code>,{" "}
              <code className="bg-amber-100 px-1 rounded text-amber-800">GEMINI_API_KEY</code>,{" "}
              <code className="bg-amber-100 px-1 rounded text-amber-800">DRIVE_ROOT_FOLDER_ID</code>,{" "}
              <code className="bg-amber-100 px-1 rounded text-amber-800">ADMIN_EMAIL</code>을 입력하세요.
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
          <Dashboard
            vessels={vessels}
            setVessels={setVessels}
            accessToken={accessToken}
            isAdmin={isAdmin}
          />
        ) : (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-10 py-10 flex flex-col items-center gap-5 max-w-sm w-full">
              <span className="text-5xl">🚢</span>
              <div className="text-center">
                <div className="font-bold text-slate-800 text-lg mb-1">BWTS LOG ANALYZER</div>
                <div className="text-slate-500 text-sm">회사 계정으로 로그인하여 이용하세요</div>
              </div>
              {authError && (
                <div className="w-full bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-600 text-center">
                  {authError}
                </div>
              )}
              <button
                onClick={handleLogin}
                disabled={authLoading || !isConfigured}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-sm font-medium rounded-xl transition-colors"
              >
                {authLoading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    인증중...
                  </>
                ) : (
                  <>🔑 Google 로그인 (@ekmtc.com)</>
                )}
              </button>
              <p className="text-xs text-slate-400 text-center">ekmtc.com 도메인 계정만 접근 가능합니다</p>
            </div>
          </div>
        )}
      </main>

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
