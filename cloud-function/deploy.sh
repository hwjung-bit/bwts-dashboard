#!/bin/bash
# BWTS PDF → CSV 변환 Cloud Function 배포 스크립트 (gen2)
#
# 대용량 로그(1,000p+ PDF) 처리를 위해 타임아웃을 상향한다.
#   - 기존: 메모리 2Gi / 타임아웃 300s
#   - 변경: 타임아웃 540s (메모리 2Gi 유지)
#   - 대용량을 못 읽던 핵심 원인이던 EVENTLOG 5MB 즉시 포기 로직은 main.py에서 제거됨.
#
# gen2 함수이므로 엔드포인트 URL은 재배포해도 유지된다
# (cloudfunctions.net alias + run.app 모두 동작).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-bwts-log-analysis}"
REGION="${REGION:-asia-northeast3}"
FUNCTION_NAME="${FUNCTION_NAME:-convert-pdf}"

gcloud functions deploy "$FUNCTION_NAME" \
  --project="$PROJECT_ID" \
  --gen2 \
  --runtime=python311 \
  --region="$REGION" \
  --source=. \
  --entry-point=convert_pdf \
  --trigger-http \
  --allow-unauthenticated \
  --memory=2Gi \
  --timeout=540s

echo ""
echo "✅ 배포 완료. 엔드포인트:"
gcloud functions describe "$FUNCTION_NAME" --gen2 --region="$REGION" --format="value(serviceConfig.uri)"
