import magic
from fastapi import HTTPException, status


MAX_FILE_BYTES = 25 * 1024 * 1024  # 25MB


def validate_upload(content: bytes, filename: str):
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_PAYLOAD_TOO_LARGE,
            detail=f"{filename} exceeds size limit",
        )
    mime = magic.from_buffer(content, mime=True)
    if not mime.startswith("text/"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"{filename}: unsupported type {mime}",
        )
