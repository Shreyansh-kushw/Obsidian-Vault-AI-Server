import json
import os
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
from obsidian_vault_ai_server.app.models import ObsidianNotes, Vaults
from obsidian_vault_ai_server.app.schema import (
    DeleteFileRequest,
    QueryRequest,
    SyncFileRequest,
    UpdateVaultPathRequest,
)
from obsidian_vault_ai_server.app.services.pipelines import (
    delete_single_file,
    ingestion_pipeline,
    retrieval_pipeline,
    sync_single_file,
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
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def resolve_local_vault_path(
    explicit_path: str | None = None,
    candidate_names: list[str] | None = None,
    file_names: list[str] | None = None,
) -> str | None:
    """Intelligently resolve the absolute filesystem path for an Obsidian vault."""
    if explicit_path and explicit_path.strip():
        p = Path(explicit_path.strip()).expanduser().resolve()
        if p.exists() and p.is_dir():
            return str(p)
        return explicit_path.strip()

    names_to_match = [n.strip() for n in (candidate_names or []) if n and n.strip()]

    # 1. Check Obsidian's global config (~/.config/obsidian/obsidian.json)
    obsidian_config_paths = [
        Path.home() / ".config" / "obsidian" / "obsidian.json",
        Path.home() / "Library" / "Application Support" / "obsidian" / "obsidian.json",
        Path(os.getenv("APPDATA", "")) / "obsidian" / "obsidian.json" if os.getenv("APPDATA") else None,
    ]
    for cfg in obsidian_config_paths:
        if cfg and cfg.exists():
            try:
                with open(cfg, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for _, vinfo in data.get("vaults", {}).items():
                        vpath = vinfo.get("path")
                        if vpath:
                            vp = Path(vpath).resolve()
                            if vp.exists():
                                # Check exact name match first
                                for cname in names_to_match:
                                    if vp.name.lower() == cname.lower():
                                        return str(vp)
                                # Check if candidate name is inside vault path or vice versa
                                for cname in names_to_match:
                                    if cname.lower() in vp.name.lower() or vp.name.lower() in cname.lower():
                                        return str(vp)
            except Exception:
                pass

    # 2. Check standard search locations for an exact folder match
    search_roots = [
        Path.home() / "Documents" / "Obsidian",
        Path.home() / "Documents",
        Path.home() / "Obsidian",
        Path.home() / "Notes",
        Path.home() / "Projects",
        Path.home(),
    ]

    for s_root in search_roots:
        if s_root.exists() and s_root.is_dir():
            for cname in names_to_match:
                candidate = (s_root / cname).resolve()
                if candidate.exists() and candidate.is_dir():
                    return str(candidate)

    # 3. Check sample file names against subdirectories
    if file_names and len(file_names) > 0:
        sample_files = [Path(f).name for f in file_names[:5] if f]
        for s_root in search_roots[:3]:
            if s_root.exists() and s_root.is_dir():
                try:
                    for sub in s_root.iterdir():
                        if sub.is_dir() and not sub.name.startswith("."):
                            if any((sub / sf).exists() for sf in sample_files):
                                return str(sub.resolve())
                except Exception:
                    pass

    # 4. Check case-insensitive folder names
    for s_root in search_roots:
        if s_root.exists() and s_root.is_dir():
            try:
                for sub in s_root.iterdir():
                    if sub.is_dir() and not sub.name.startswith("."):
                        for cname in names_to_match:
                            if cname.lower() == sub.name.lower():
                                return str(sub.resolve())
            except Exception:
                pass

    return None


@app.get("/discovered-vaults")
async def get_discovered_vaults():
    """Return all discovered Obsidian vaults on the host machine"""
    discovered = []
    seen = set()

    cfg = Path.home() / ".config" / "obsidian" / "obsidian.json"
    if cfg.exists():
        try:
            with open(cfg, "r", encoding="utf-8") as f:
                data = json.load(f)
                for _, vinfo in data.get("vaults", {}).items():
                    p = vinfo.get("path")
                    if p:
                        resolved = str(Path(p).resolve())
                        if Path(resolved).exists() and resolved not in seen:
                            seen.add(resolved)
                            discovered.append({
                                "name": Path(resolved).name,
                                "path": resolved,
                                "source": "Obsidian Config",
                            })
        except Exception:
            pass

    for base in [Path.home() / "Documents" / "Obsidian", Path.home() / "Documents", Path.home() / "Obsidian"]:
        if base.exists() and base.is_dir():
            try:
                for child in base.iterdir():
                    if child.is_dir() and not child.name.startswith("."):
                        resolved = str(child.resolve())
                        if (child / ".obsidian").exists() and resolved not in seen:
                            seen.add(resolved)
                            discovered.append({
                                "name": child.name,
                                "path": resolved,
                                "source": "Local Directory (.obsidian)",
                            })
            except Exception:
                pass

    return discovered


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
@limiter.limit("20/minute")
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
    if not clean_local_path:
        qp = request.query_params.get("local_vault_path") or request.query_params.get("local_path") or request.query_params.get("path")
        if qp and qp.strip():
            clean_local_path = qp.strip()
    if not clean_local_path:
        hdr = request.headers.get("x-local-vault-path") or request.headers.get("x-vault-path")
        if hdr and hdr.strip():
            clean_local_path = hdr.strip()

    # Collect candidate names for intelligent path resolution
    folder_prefix = None
    if files and files[0].filename and "/" in files[0].filename:
        folder_prefix = files[0].filename.split("/")[0]

    candidate_names = [vault_name]
    if job_name and job_name.strip():
        candidate_names.append(job_name.strip())
    if folder_prefix:
        candidate_names.append(folder_prefix)

    file_names = [f.filename for f in files if f.filename]

    clean_local_path = resolve_local_vault_path(
        explicit_path=clean_local_path,
        candidate_names=candidate_names,
        file_names=file_names,
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
@limiter.limit("20/minute")
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
    vaults_data = []
    has_updates = False
    for vault in vaults:
        if not vault.local_vault_path:
            resolved = resolve_local_vault_path(
                candidate_names=[vault.vault_name] if vault.vault_name else [],
            )
            if resolved:
                vault.local_vault_path = resolved
                has_updates = True

        vaults_data.append({
            "id": vault.vault_id,
            "job_id": vault.vault_id,
            "vault_id": vault.vault_id,
            "name": f"{vault.vault_name if vault.vault_name else vault.vault_id[:8]}",
            "vault_name": vault.vault_name,
            "local_vault_path": vault.local_vault_path,
            "totalFiles": vault.total_files,
            "status": vault.status,
            "succeeded": vault.succeeded,
        })

    if has_updates:
        try:
            await db.commit()
        except Exception:
            await db.rollback()

    return vaults_data


@app.delete("/vaults/{vault_id}")
async def delete_vault(
    vault_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    """Delete a vault and all its cascading notes and chunks"""
    vault = await get_vault_or_403(vault_id, owner_token, db)
    await db.delete(vault)
    await db.commit()
    return {"status": "deleted", "vault_id": vault_id, "message": "Vault removed successfully"}


@app.post("/vaults/{vault_id}/sync-file")
async def sync_file(
    vault_id: str,
    req: SyncFileRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    """Sync, chunk, and embed a created or modified single markdown file"""
    await get_vault_or_403(vault_id, owner_token, db)
    return await sync_single_file(vault_id, req.rel_filepath, req.content, db)


@app.delete("/vaults/{vault_id}/files")
async def delete_file(
    vault_id: str,
    req: DeleteFileRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    """Delete an indexed note and its chunks from the vault"""
    await get_vault_or_403(vault_id, owner_token, db)
    return await delete_single_file(vault_id, req.rel_filepath, db)


@app.patch("/vaults/{vault_id}/path")
async def update_vault_path(
    vault_id: str,
    req: UpdateVaultPathRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    """Update the local vault directory path in the database"""
    vault = await get_vault_or_403(vault_id, owner_token, db)
    vault.local_vault_path = req.local_vault_path.strip()
    await db.commit()
    return {
        "status": "updated",
        "vault_id": vault_id,
        "local_vault_path": vault.local_vault_path,
    }


@app.get("/vaults/{vault_id}/files")
async def list_vault_files(
    vault_id: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    api_key: Annotated[str, Depends(verify_api_key)],
    owner_token: Annotated[str, Depends(get_owner_token)],
):
    """List all indexed notes in a vault for client reconciliation"""
    await get_vault_or_403(vault_id, owner_token, db)
    stmt = (
        select(ObsidianNotes)
        .where(ObsidianNotes.vault_id == vault_id)
        .order_by(ObsidianNotes.note_name.asc())
    )
    result = await db.execute(stmt)
    notes = result.scalars().all()
    return [
        {
            "id": note.id,
            "note_name": note.note_name,
            "rel_filepath": note.rel_filepath or f"{note.note_name}.md",
            "wikilinks": note.wikilinks or [],
            "tags": note.tags or [],
        }
        for note in notes
    ]


def main():
    """CLI entrypoint for running the server"""
    import uvicorn
    uvicorn.run("obsidian_vault_ai_server:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":
    main()


