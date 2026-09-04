import secrets
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import APIKeyHeader

from app.models import Jobs
from app.utils.config import settings

API_KEY = settings.api_key

api_key_header = APIKeyHeader(name="X-API-KEY", auto_error=True)
owner_token = APIKeyHeader(name="X-OWNER-TOKEN", auto_error=True)


async def verify_api_key(
    api_key: Annotated[str, Depends(api_key_header)],
):
    if not api_key or not secrets.compare_digest(api_key, API_KEY):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API Key"
        )

    return api_key


async def get_owner_token(x_owner_token: Annotated[str, Depends(owner_token)]):
    return x_owner_token


async def get_job_or_403(job_id: str, owner_token: str, db):
    job = await db.get(Jobs, job_id)
    if not job or not secrets.compare_digest(job.owner_token, owner_token):
        raise HTTPException(status_code=403, detail="Not your job or Job not found!")
    return job
