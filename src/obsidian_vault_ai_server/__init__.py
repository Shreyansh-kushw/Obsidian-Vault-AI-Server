import secrets
from pathlib import Path
from typing import Annotated

import aiofiles
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from obsidian_vault_ai_server.app.database import get_db
from obsidian_vault_ai_server.app.models import Vaults
from obsidian_vault_ai_server.app.schema import QueryRequest
from obsidian_vault_ai_server.app.services.pipelines import (
    ingestion_pipeline,
    retrieval_pipeline,
)
from obsidian_vault_ai_server.app.utils.auth import (
    get_owner_token,
    get_vault_or_403,
    verify_api_key,
)
from obsidian_vault_ai_server.app.utils.file_validator import (
    MAX_FILE_BYTES,
    validate_upload,
)

app = FastAPI()

UPLOAD_DIR = Path("upload_files")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://context-engine-alpha.vercel.app", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    if request.method == "POST":
        content_length = request.headers.get("content-length")

        if content_length and int(content_length) > MAX_FILE_BYTES:
            return JSONResponse(
                status_code=status.HTTP_413_PAYLOAD_TOO_LARGE,
                content={"detail": "File too large. (MAX: 25MB)"},
            )

    return await call_next(request)


@app.post("/upload-files")
@limiter.limit("5/minute")
async def upload_file(
    request: Request,
    background_tasks: BackgroundTasks,
    files: Annotated[list[UploadFile], File(description="Files to be analysed.")],
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
    job_name: Annotated[str | None, Form()] = None,
    local_vault_path: Annotated[str | None, Form()] = None,
):
    """Endpoint to upload and ingest an Obsidian vault"""

    vault_id = secrets.token_urlsafe(32)
    vault_name = (
        job_name.strip() if job_name and job_name.strip() else f"vault_{vault_id[:8]}"
    )
    clean_local_path = (
        local_vault_path.strip()
        if local_vault_path and local_vault_path.strip()
        else None
    )

    new_vault = Vaults(
        vault_id=vault_id,
        vault_name=vault_name,
        local_vault_path=clean_local_path,
        owner_token=owner_token,
        total_files=len(files),
        status="Processing",
    )

    try:
        db.add(new_vault)
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )

    # Save files inside upload_files/{vault_name}
    vault_dir = (UPLOAD_DIR / vault_name).resolve()
    vault_dir.mkdir(parents=True, exist_ok=True)

    try:
        for file in files:
            filename = file.filename or "untitled.md"
            content = await file.read()
            validate_upload(content, filename)

            # Prevent directory traversal while supporting relative subfolder paths
            clean_relpath = Path(filename)
            if clean_relpath.is_absolute() or ".." in clean_relpath.parts:
                clean_relpath = Path(clean_relpath.name)

            target_filepath = (vault_dir / clean_relpath).resolve()
            if not str(target_filepath).startswith(str(vault_dir)):
                target_filepath = vault_dir / clean_relpath.name

            target_filepath.parent.mkdir(parents=True, exist_ok=True)

            async with aiofiles.open(target_filepath, mode="wb") as f:
                await f.write(content)

        # Trigger background ingestion on the full vault folder
        background_tasks.add_task(ingestion_pipeline, vault_id, vault_dir)

    except HTTPException:
        raise
    except Exception as e:
        vault = await db.get(Vaults, vault_id)
        if vault:
            vault.failed_files = {"error": str(e)}
            vault.status = "Failed"
            try:
                await db.commit()
            except Exception:
                await db.rollback()

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )

    return {
        "job_id": str(vault_id),
        "vault_id": str(vault_id),
        "message": "Files uploaded successfully",
    }


@app.post("/qna")
@limiter.limit("10/minute")
async def ques_answer(
    request: Request,
    query_request: QueryRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    """Endpoint to generate response for the asked query"""

    vault = await get_vault_or_403(query_request.job_id, owner_token, db)
    vault_id = vault.vault_id

    response = await retrieval_pipeline(query_request.query, vault_id, db)
    return response


@app.get("/status/{job_id}")
async def get_status(
    job_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    vault = await get_vault_or_403(job_id, owner_token, db)
    return vault.status


@app.get("/health")
async def health(
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    return {"status": "ok"}


@app.get("/jobs")
@app.get("/vaults")
async def list_jobs(
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    stmt = (
        select(Vaults)
        .where(Vaults.owner_token == owner_token)
        .order_by(Vaults.vault_id.desc())
    )
    result = await db.execute(stmt)
    vaults = result.scalars().all()
    return [
        {
            "id": vault.vault_id,
            "job_id": vault.vault_id,
            "vault_id": vault.vault_id,
            "name": f"{vault.vault_name if vault.vault_name else vault.vault_id[:8]}",
            "vault_name": vault.vault_name,
            "local_vault_path": vault.local_vault_path,
            "totalFiles": vault.total_files,
            "status": vault.status,
            "succeeded": vault.succeeded,
        }
        for vault in vaults
    ]
