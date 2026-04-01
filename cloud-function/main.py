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

# EVENTLOG 파일 크기 제한 (5MB)
MAX_EVENTLOG_SIZE = 5 * 1024 * 1024


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
    params = {"fields": "name,size,mimeType"}
    headers = {"Authorization": f"Bearer {access_token}"}
    res = requests.get(url, params=params, headers=headers)
    res.raise_for_status()
    return res.json()


def _download_pdf(file_id, access_token):
    """Drive API로 PDF 바이너리 다운로드"""
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}"
    params = {"alt": "media"}
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

        # 3. EVENTLOG 5MB 초과 체크
        if _is_eventlog(filename) and file_size > MAX_EVENTLOG_SIZE:
            csv_content = "\ufeff페이지 과도 : 검토필요\n"
            return _json_response(
                {"status": "success", "csv_content": csv_content, "warning": "EVENTLOG 5MB 초과"},
                200, origin
            )

        # 4. PDF 다운로드
        pdf_bytes = _download_pdf(file_id, access_token)

        # 5. pdfplumber 추출
        rows = _extract_tables(pdf_bytes)

        if not rows:
            return _json_response(
                {"status": "error", "message": f"PDF에서 데이터를 추출할 수 없습니다: {filename}"},
                200, origin
            )

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
