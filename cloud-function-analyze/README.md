# BWTS Analyze Cloud Function

Gemini 2.5 Flash로 BWTS 월간 운전 로그 판정/요약을 수행한다. CSV 파싱·결정론적 정제는 클라이언트에서 끝낸 결과(JSON)를 받아 자연어 분석을 반환.

## 동작

```
POST /analyze
  body: { input: <정제된 분석 데이터>, rulebook_version?: "2026-05" }

1) Firestore `settings/global.useGeminiAnalysis` 토글 확인
   - false → JS 폴백만 실행 후 반환 (_toggle_off: true)
2) 입력 SHA-256 해시 → `analyses_cache/{hash}` 캐시 조회
   - 히트 → 즉시 반환 (_cached: true)
3) Gemini 2.5 Flash 호출 (responseSchema 강제)
   - 성공 → 캐시 저장 후 반환
   - 실패 → JS 폴백 (_fallback: true, _gemini_error 포함)
```

## 입력 스키마

`input` 필드는 클라이언트가 정제 단계(1~5단계: normalizeAlarmLevels, groupRepeatAlarms, sanitizeTroValues, validateOperationDates, checkEventLogPages)를 끝낸 결과여야 한다.

```json
{
  "input": {
    "vessel_name": "KMTC PUSAN",
    "imo_number": "9...",
    "period": "2026_03",
    "operations": [...],
    "tro_data": {...},
    "error_alarms": [...],
    "op_time_stats": {...},
    "op_time_anomalies": [...],
    "event_log_analysis": {...},
    "data_log_efficiency": {...},
    "gps_areas": [...]
  },
  "rulebook_version": "2026-05"
}
```

## 응답 스키마

```json
{
  "overall_status": "NORMAL" | "WARNING" | "CRITICAL",
  "ai_remarks":    ["[운전 현황] ...", ...],
  "ai_remarks_en": ["[Operations] ...", ...],
  "alarm_summary": [{ "cat","icon","label","labelEn","trips","alarms","codes","action","actionEn" }],
  "_gemini_meta":  { "model","prompt_tokens","output_tokens","latency_ms","finish_reason" },
  "_fallback":     false,
  "_cached":       false,
  "_toggle_off":   false,
  "_gemini_error": "..."   // 폴백 발동 시
}
```

## 로컬 실행

```bash
cd cloud-function-analyze
npm install
cp .env.example .env
# .env에 GEMINI_API_KEY 입력
npm start
# http://localhost:8080
```

`gcloud auth application-default login`으로 Firestore 접근 자격증명도 준비.

## 배포

```bash
chmod +x deploy.sh
./deploy.sh
```

deploy.sh 헤더의 사전 준비(시크릿 등록, IAM, Firestore 토글 도큐먼트)를 1회 수행.

## 점진 활성화

1. 배포 직후 Firestore `settings/global` = `{ useGeminiAnalysis: false }` → 모든 요청 JS 폴백
2. 1척만 토글 ON으로 분석 — 결과 확인 (Firebase 콘솔 UI에 클라이언트 코드 임시 분기 추가하거나, 토글에 `enabledVessels: ["KPS"]` 같은 필드 추가)
3. 1주일 안정 확인 후 `useGeminiAnalysis: true` 전체 활성화
4. 1개월 후 Firestore `_gemini_meta.fallback_used` 빈도 모니터링

## 룰북 변경

`rulebook.js`의 `SYSTEM_PROMPT` 수정 + `RULEBOOK_VERSION` 갱신 + `fallback.js`의 동등 로직 동시 갱신. 재배포 시 모든 캐시 자동 무효화(해시에 버전 포함).
