// ============================================================
//  firebaseService.js
//  Firebase Firestore + Auth wrapper
//  - Replaces sheetsService.js (vessels, analyses, calibration)
//  - Google Sign-In via Firebase Auth (provides Drive/Gmail access token)
// ============================================================

import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { CONFIG } from "../config.js";

// ── Firebase 초기화 ─────────────────────────────────────────
const app = initializeApp(CONFIG.FIREBASE);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ── 인증 ────────────────────────────────────────────────────

/**
 * Google 로그인 → Firebase Auth 세션 + Google API access_token 동시 획득
 * @returns {Promise<{user, accessToken, email}>}
 */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  // Drive/Gmail/Sheets 스코프 추가
  provider.addScope("https://www.googleapis.com/auth/drive");
  provider.addScope("https://www.googleapis.com/auth/gmail.send");
  provider.addScope("https://www.googleapis.com/auth/spreadsheets");

  const result = await signInWithPopup(auth, provider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken;
  const user = result.user;

  return {
    user,
    accessToken,
    email: user.email,
  };
}

export function signOut() {
  return fbSignOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// ── 공통 유틸: undefined 제거 (Firestore는 undefined 거부) ──
function stripUndefined(obj) {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(stripUndefined).filter(v => v !== undefined);
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return obj;
}

// ── Vessels CRUD ────────────────────────────────────────────

export async function readVessels() {
  const snapshot = await getDocs(collection(db, "vessels"));
  const vessels = [];
  snapshot.forEach((doc) => {
    vessels.push({ id: doc.id, ...doc.data() });
  });
  return vessels;
}

export async function writeVessels(vessels) {
  const batch = writeBatch(db);
  // 기존 문서 전부 읽고, 현재 vessels에 없는 것 삭제
  const existingSnap = await getDocs(collection(db, "vessels"));
  const currentIds = new Set(vessels.map((v) => v.id));
  existingSnap.forEach((docSnap) => {
    if (!currentIds.has(docSnap.id)) {
      batch.delete(doc(db, "vessels", docSnap.id));
    }
  });
  // 현재 vessels 전부 upsert (undefined 제거)
  for (const v of vessels) {
    const { id, ...data } = v;
    const cleaned = stripUndefined(data);
    batch.set(doc(db, "vessels", id), {
      ...cleaned,
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

export async function upsertVessel(vessel) {
  const { id, ...data } = vessel;
  const cleaned = stripUndefined(data);
  await setDoc(
    doc(db, "vessels", id),
    { ...cleaned, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

export async function deleteVessel(id) {
  await deleteDoc(doc(db, "vessels", id));
}

// ── Monthly Analysis ────────────────────────────────────────
// 구조: /analyses/{year}_{month}/vessels/{vesselId}

function monthDocId(year, month) {
  return `${year}_${String(month).padStart(2, "0")}`;
}

export async function readMonthlyData(year, month) {
  const periodId = monthDocId(year, month);
  const snapshot = await getDocs(
    collection(db, "analyses", periodId, "vessels")
  );
  const result = {};
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    result[docSnap.id] = {
      analysisStatus: data.analysisStatus || "NO_DATA",
      analysisError: data.analysisError || null,
      lastAnalyzed: data.lastAnalyzed || null,
      pdfCount: data.pdfCount ?? 0,
      analysisResult: data.analysisResult || null,
      reviewed: data.reviewed || false,
      reviewedAt: data.reviewedAt || null,
      reviewNote: data.reviewNote || "",
      reviewRemark: data.reviewRemark || "",
      hasCsv: data.hasCsv || false,
      hasPdf: data.hasPdf || false,
    };
  });
  return result;
}

export async function upsertMonthlyEntry(vesselId, year, month, entry) {
  const periodId = monthDocId(year, month);
  const ref = doc(db, "analyses", periodId, "vessels", vesselId);
  const cleaned = stripUndefined({
    ...entry,
    year,
    month,
  });
  await setDoc(
    ref,
    { ...cleaned, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

export async function clearMonthlyData(year, month) {
  const periodId = monthDocId(year, month);
  const snapshot = await getDocs(
    collection(db, "analyses", periodId, "vessels")
  );
  const batch = writeBatch(db);
  snapshot.forEach((docSnap) => batch.delete(docSnap.ref));
  await batch.commit();
}

// ── Calibration ─────────────────────────────────────────────
// 구조: /calibration/{vesselCode}

export async function readCalibration() {
  const snapshot = await getDocs(collection(db, "calibration"));
  const result = [];
  snapshot.forEach((docSnap) => {
    result.push({ vesselCode: docSnap.id, ...docSnap.data() });
  });
  return result;
}

export async function upsertCalibration(vesselCode, data) {
  const cleaned = stripUndefined(data);
  await setDoc(
    doc(db, "calibration", vesselCode),
    { ...cleaned, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

// ── User Role (관리자 확인) ─────────────────────────────────

export async function getUserRole(email) {
  if (!email) return null;
  const snap = await getDoc(doc(db, "users", email));
  return snap.exists() ? snap.data().role : null;
}

export async function isAdmin(email) {
  const role = await getUserRole(email);
  return role === "admin";
}
