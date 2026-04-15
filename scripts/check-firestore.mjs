// Firestore 연결 + 현재 상태 확인
import { readFileSync } from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccount = JSON.parse(readFileSync("./scripts/service-account.json", "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

console.log("✅ Firebase 연결 성공");
console.log("   프로젝트:", serviceAccount.project_id);
console.log("");

// vessels 컬렉션 확인
const vesselsSnap = await db.collection("vessels").get();
console.log(`📋 vessels: ${vesselsSnap.size}개`);
vesselsSnap.forEach((doc) => {
  const d = doc.data();
  console.log(`   - ${doc.id}: ${d.name || d.vesselCode || "(이름없음)"}`);
});

// users 컬렉션 확인
const usersSnap = await db.collection("users").get();
console.log(`\n👤 users: ${usersSnap.size}개`);
usersSnap.forEach((doc) => {
  console.log(`   - ${doc.id}: role=${doc.data().role}`);
});

// analyses 컬렉션 확인
const analysesSnap = await db.collection("analyses").get();
console.log(`\n📊 analyses (월별): ${analysesSnap.size}개 월`);
analysesSnap.forEach((doc) => {
  console.log(`   - ${doc.id}`);
});

process.exit(0);
