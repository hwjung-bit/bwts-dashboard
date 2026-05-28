#!/bin/bash
# BWTS Analyze Cloud Function 배포 스크립트
#
# 사전 준비 (1회만):
#   1. Gemini API 키 발급: https://aistudio.google.com/apikey
#   2. Secret 등록:
#      echo -n "YOUR_API_KEY" | gcloud secrets create gemini-api-key --data-file=-
#   3. 실행 SA에 secretAccessor 권한 부여:
#      gcloud secrets add-iam-policy-binding gemini-api-key \
#        --member="serviceAccount:$(gcloud config get-value project)@appspot.gserviceaccount.com" \
#        --role="roles/secretmanager.secretAccessor"
#   4. Firestore에 settings/global 도큐먼트 생성 (Firebase 콘솔에서):
#      { useGeminiAnalysis: false }   ← 초기엔 false (점진 활성화)
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-bwts-log-analysis}"
FIRESTORE_PROJECT_ID="${FIRESTORE_PROJECT_ID:-bwts-dashboard}"
REGION="${REGION:-asia-northeast3}"
FUNCTION_NAME="${FUNCTION_NAME:-bwts-analyze}"

gcloud functions deploy "$FUNCTION_NAME" \
  --project="$PROJECT_ID" \
  --gen2 \
  --runtime=nodejs20 \
  --region="$REGION" \
  --source=. \
  --entry-point=analyze \
  --trigger-http \
  --allow-unauthenticated \
  --memory=512Mi \
  --timeout=60s \
  --concurrency=10 \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest" \
  --set-env-vars="RULEBOOK_VERSION=2026-05,GEMINI_MODEL=gemini-2.5-flash,FIRESTORE_PROJECT_ID=${FIRESTORE_PROJECT_ID},ALLOWED_ORIGINS=https://bwts-dashboard.web.app,https://bwts-dashboard.firebaseapp.com,https://hwjung-bit.github.io,http://localhost:5173,http://localhost:4173"

echo ""
echo "✅ 배포 완료. 엔드포인트:"
gcloud functions describe "$FUNCTION_NAME" --gen2 --region="$REGION" --format="value(serviceConfig.uri)"
echo ""
echo "다음 단계: 위 URL을 src/config.js의 ANALYZE_FUNCTION_URL에 추가"
