"""
BWTS PDF → CSV 변환 Cloud Function
pdfplumber로 PDF 테이블/텍스트 추출 후 CSV 반환
"""
import io
import csv
import json
import requests
import pdfplumber
import functions_framework


# CORS 허용 도메인
ALLOWED_ORIGINS = [
    "https://hwjung-bit.github.io",
    "http://localhost:5173",
    "http://localhost:4173",
]

# EVENTLOG 파일 크기 상한 (50MB) — 추출 자체가 위험한 극단값만 차단.
# 기존엔 5MB만 넘어도 변환을 통째로 포기했으나, 채터링·반복알람이 심한
# (= 가장 분석이 필요한) 선박일수록 EVENTLOG가 커지는 모순이 있어 상한을 올린다.
# 5MB~50MB 구간은 아래 _filter_eventlog_noise로 Normal 노이즈를 걸러 정상 변환한다.
MAX_EVENTLOG_SIZE = 50 * 1024 * 1024

# EVENTLOG에서 LEVEL=Normal 이라도 보존해야 하는 행
# (클라이언트 csvService.parseEventLogCsv가 이 키워드들을 카운트한다):
#   비정상 종료 / GPS 시각 보정 / HMI 전원 / VRCS 밸브 채터링(Valve Opened/Closed)
EVENTLOG_KEEP_NORMAL = (
    "terminated", "gps time set", "hmi power on", "valve opened", "valve closed",
)


def _cors_headers(origin):
    """CORS 응답 헤더 생성"""
    allowed = origin if origin in ALLOWED_ORIGINS else ALLOWED_ORIGINS[0]
    return {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "3600",
    }


def _json_response(data, status=200, origin=""):
    """JSON 응답 헬퍼"""
    headers = _cors_headers(origin)
    headers["Content-Type"] = "application/json"
    return (json.dumps(data, ensure_ascii=False), status, headers)


def _get_file_metadata(file_id, access_token):
    """Drive API로 파일 메타데이터 조회"""
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}"
    params = {"fields": "name,size,mimeType", "supportsAllDrives": "true"}
    headers = {"Authorization": f"Bearer {access_token}"}
    res = requests.get(url, params=params, headers=headers)
    res.raise_for_status()
    return res.json()


def _download_pdf(file_id, access_token):
    """Drive API로 PDF 바이너리 다운로드"""
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}"
    params = {"alt": "media", "supportsAllDrives": "true"}
    headers = {"Authorization": f"Bearer {access_token}"}
    res = requests.get(url, params=params, headers=headers)
    res.raise_for_status()
    return res.content


def _extract_tables(pdf_bytes):
    """pdfplumber로 테이블 추출 → 2D 배열"""
    all_rows = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            if tables:
                for table in tables:
                    for row in table:
                        # None → 빈문자열
                        cleaned = [(cell or "").strip() for cell in row]
                        if any(cleaned):
                            all_rows.append(cleaned)
            else:
                # 테이블 없으면 텍스트 추출 후 행 단위 분할
                text = page.extract_text()
                if text:
                    for line in text.split("\n"):
                        line = line.strip()
                        if line:
                            # 공백 2개 이상을 구분자로 사용
                            parts = [p.strip() for p in line.split("  ") if p.strip()]
                            if parts:
                                all_rows.append(parts)
    return all_rows


def _rows_to_csv(rows):
    """2D 배열 → CSV 문자열 (BOM 포함)"""
    if not rows:
        return ""
    # 최대 컬럼 수 맞추기
    max_cols = max(len(r) for r in rows)
    output = io.StringIO()
    output.write("\ufeff")  # BOM (엑셀 한글 호환)
    writer = csv.writer(output)
    for row in rows:
        # 컬럼 수 맞추기
        padded = row + [""] * (max_cols - len(row))
        writer.writerow(padded)
    return output.getvalue()


def _is_eventlog(filename):
    """파일명으로 EVENTLOG 여부 판별"""
    name_upper = (filename or "").upper()
    return "EVENTLOG" in name_upper or "EVENT_LOG" in name_upper


def _filter_eventlog_noise(rows):
    """EVENTLOG 전용: LEVEL=Normal 이면서 의미 없는 행을 제거해 CSV 크기를 줄인다.
    - 헤더 행, Trip/Alarm/Warning 행은 그대로 유지
    - Normal 행은 EVENTLOG_KEEP_NORMAL 키워드(채터링·비정상종료 등)를 포함할 때만 유지
    EVENTLOG는 대부분 Normal(운전상태) 로그라, 이 필터만으로 크기가 크게 줄어든다.
    """
    filtered = []
    for row in rows:
        cells_lower = [c.strip().lower() for c in row]
        is_normal = "normal" in cells_lower  # LEVEL 컬럼 값이 정확히 'normal'인 행
        if is_normal:
            joined = " ".join(cells_lower)
            if any(kw in joined for kw in EVENTLOG_KEEP_NORMAL):
                filtered.append(row)
            # else: 노이즈 → 제거
        else:
            filtered.append(row)
    return filtered


@functions_framework.http
def convert_pdf(request):
    """
    POST /convert-pdf
    Body: { "file_id": "...", "access_token": "..." }
    Response: { "status": "success", "csv_content": "..." }
    """
    origin = request.headers.get("Origin", "")

    # CORS preflight
    if request.method == "OPTIONS":
        return ("", 204, _cors_headers(origin))

    try:
        body = request.get_json(silent=True) or {}
        file_id = body.get("file_id")
        access_token = body.get("access_token")

        if not file_id or not access_token:
            return _json_response(
                {"status": "error", "message": "file_id와 access_token이 필요합니다."},
                400, origin
            )

        # 1. 파일 메타데이터 조회
        meta = _get_file_metadata(file_id, access_token)
        filename = meta.get("name", "")
        file_size = int(meta.get("size", 0))

        # 2. BWRB 파일 제외
        if "BWRB" in filename.upper():
            return _json_response(
                {"status": "skipped", "reason": "BWRB 파일 제외"},
                200, origin
            )

        is_eventlog = _is_eventlog(filename)

        # 3. EVENTLOG 상한(50MB) 초과만 차단 — 추출 자체가 위험한 극단값
        if is_eventlog and file_size > MAX_EVENTLOG_SIZE:
            csv_content = "\ufeff페이지 과도 : 검토필요\n"
            return _json_response(
                {"status": "success", "csv_content": csv_content, "warning": "EVENTLOG 50MB 초과"},
                200, origin
            )

        # 4. PDF 다운로드
        pdf_bytes = _download_pdf(file_id, access_token)

        # 4-1. 메타에 size가 없던 경우(0) 실제 바이트로 EVENTLOG 상한 재확인
        if is_eventlog and file_size == 0 and len(pdf_bytes) > MAX_EVENTLOG_SIZE:
            return _json_response(
                {"status": "success",
                 "csv_content": "﻿페이지 과도 : 검토필요\n",
                 "warning": "EVENTLOG 50MB 초과(실측)"},
                200, origin
            )

        # 5. pdfplumber 추출
        rows = _extract_tables(pdf_bytes)

        if not rows:
            return _json_response(
                {"status": "error", "message": f"PDF에서 데이터를 추출할 수 없습니다: {filename}"},
                200, origin
            )

        # 5-1. EVENTLOG는 Normal 노이즈 행을 제거해 CSV 크기를 줄인다
        if is_eventlog:
            before = len(rows)
            rows = _filter_eventlog_noise(rows)
            print(f"[EVENTLOG] 노이즈 필터: {before} -> {len(rows)} rows")

        # 6. CSV 변환
        csv_content = _rows_to_csv(rows)

        return _json_response(
            {"status": "success", "csv_content": csv_content, "rows": len(rows), "filename": filename},
            200, origin
        )

    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code if e.response else 500
        return _json_response(
            {"status": "error", "message": f"Drive API 오류 ({status_code}): {str(e)}"},
            200, origin
        )
    except Exception as e:
        return _json_response(
            {"status": "error", "message": f"변환 실패: {str(e)}"},
            500, origin
        )
