import secrets
import aiofiles
from pathlib import Path
from typing import Annotated

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
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

from app.database import get_db
from app.models import Jobs
from app.schema import QueryRequest
from app.services.pipelines import ingestion_pipeline, retrieval_pipeline
from app.utils.auth import get_job_or_403, get_owner_token, verify_api_key
from app.utils.file_validator import MAX_FILE_BYTES, validate_upload

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
            # NOTE: We cannot raise HTTPExceptions inside middleware endpoints
            # It will crash the fastapi exception handlers.
            # instead we need to return JSONResponse manually for middleware endpoints.
            # raise HTTPException(status_code=status.HTTP_413_PAYLOAD_TOO_LARGE, detail="File too large. (MAX: 25MB)")

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
):
    """Endpoint to upload and ingest documents"""

    job_id = secrets.token_urlsafe(32)  # creating random job ids.

    new_job = Jobs(
        job_id=job_id,
        owner_token=owner_token,
        total_files=len(files),
    )

    try:
        db.add(new_job)
        await db.commit()

    except Exception as e:
        await db.rollback()

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )

    for index, file in enumerate(files):
        try:
            filename = file.filename
            content = await file.read()
            validate_upload(content, filename)
            filepath = UPLOAD_DIR / f"{job_id}{index + 1}{Path(file.filename).suffix}"

            async with aiofiles.open(filepath, mode="wb") as f:
                await f.write(content)

            background_tasks.add_task(ingestion_pipeline, filename, filepath, job_id, index)

        except HTTPException:
            # raise any HTTPException if encountered.
            raise

        except Exception as e:
            # raising standard 500 error if any unknown exceptions are encountered.
            job = await db.execute(
                select(Jobs).where(Jobs.job_id==job_id)
            ).scalars().first()

            job.succeeded = index + 1
            job.failed_files = {"filename": filename, "error": str(e)}
            job.status = "Failed"

            try:
                await db.commit()

            except Exception as e:
                await db.rollback()

                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
                )

            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
            )

    return {"job_id": str(job_id), "message": "Files uploaded successfully"}


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

    job = await get_job_or_403(query_request.job_id, owner_token, db)
    job_id = job.job_id

    response = await retrieval_pipeline(query_request.query, job_id, db)
    return response


@app.get("/status/{job_id}")
async def get_status(
    job_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    job = await get_job_or_403(job_id, owner_token, db)

    return job.status
