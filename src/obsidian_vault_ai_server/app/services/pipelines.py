import shutil
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import obsidiantools.api as o_api

from obsidian_vault_ai_server.app.database import AsyncSessionLocal
from obsidian_vault_ai_server.app.models import ObsidianChunks, ObsidianNotes, Vaults
from obsidian_vault_ai_server.app.services import embedder
from obsidian_vault_ai_server.app.services.chunker import chunk_text
from obsidian_vault_ai_server.app.services.llm_service import generate_response
from obsidian_vault_ai_server.app.services.reranker_service import rerank
from obsidian_vault_ai_server.app.utils.retrieval_utils import reciprocal_rank_fusion

# Helper Pipelines


def markdown_pipeline(vault_dir: Path):
    """Processes the markdown files in a vault directory and returns gathered Vault object"""
    vault = o_api.Vault(vault_dir).connect().gather()
    return vault


# Main data ingestion pipeline


async def ingestion_pipeline(vault_id: str, vault_dir: Path):
    """The main ingestion pipeline for an Obsidian vault directory"""

    try:
        vault = markdown_pipeline(vault_dir)

        async with AsyncSessionLocal() as db:
            vault_record = await db.get(Vaults, vault_id)
            if not vault_record:
                raise ValueError(f"Vault {vault_id} not found in database.")

            processed_notes_count = 0

            for note_name, rel_filepath in vault.md_file_index.items():
                source_text = vault.get_source_text(note_name) or ""
                wikilinks = list(vault.get_wikilinks(note_name) or [])
                backlinks = list(vault.get_backlinks(note_name) or [])
                tags = list(vault.get_tags(note_name) or [])
                front_matter = vault.get_front_matter(note_name) or {}

                # Create ObsidianNotes entry
                note_entry = ObsidianNotes(
                    vault_id=vault_id,
                    note_name=note_name,
                    rel_filepath=str(rel_filepath),
                    wikilinks=wikilinks,
                    backlinks=backlinks,
                    tags=tags,
                    front_matter=front_matter,
                )
                db.add(note_entry)
                await db.flush()  # Populates note_entry.id for chunk foreign key linking

                # Chunk the note text
                chunks = chunk_text(source_text)
                if chunks:
                    embeddings = embedder.generate_embeddings(chunks)
                    if hasattr(embeddings, "tolist"):
                        embeddings = embeddings.tolist()

                    for chunk_idx, (chunk_str, emb) in enumerate(
                        zip(chunks, embeddings)
                    ):
                        chunk_entry = ObsidianChunks(
                            vault_id=vault_id,
                            note_id=note_entry.id,
                            chunk_index=chunk_idx,
                            chunk_text=chunk_str,
                            embedding=emb,
                        )
                        db.add(chunk_entry)

                processed_notes_count += 1

            vault_record.succeeded = processed_notes_count
            vault_record.status = "Success"
            await db.commit()

    except Exception as e:
        async with AsyncSessionLocal() as db:
            vault_record = await db.get(Vaults, vault_id)
            if vault_record:
                vault_record.failed_files = {"error": str(e)}
                vault_record.status = "Failed"
                try:
                    await db.commit()
                except Exception:
                    await db.rollback()
        raise

    finally:
        # Clean up local vault files from upload_files directory
        if vault_dir and vault_dir.exists():
            shutil.rmtree(vault_dir, ignore_errors=True)


# Main retrieval pipeline


async def retrieval_pipeline(query: str, job_id: str, db: AsyncSession):
    """Main retrieval pipeline"""

    # generating embeddings for the query
    query_embedding = embedder.generate_embeddings(query)
    if hasattr(query_embedding, "tolist"):
        query_embedding = query_embedding.tolist()

    stmt = select(Vaults).where(Vaults.vault_id == job_id).exists()
    job_exists = await db.scalar(select(stmt))

    if not job_exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Vault ID not found!"
        )

    # getting all the database fields with the given vault_id
    vector_search = await db.execute(
        select(ObsidianChunks)
        .where(ObsidianChunks.vault_id == job_id)
        .where(ObsidianChunks.embedding.cosine_distance(query_embedding) < 0.5)
        .order_by(ObsidianChunks.embedding.cosine_distance(query_embedding))
        .limit(20)
    )

    vector_search_results = vector_search.scalars().all()

    keyword_search = await db.execute(
        select(ObsidianChunks)
        .where(ObsidianChunks.vault_id == job_id)
        .where(
            ObsidianChunks.chunk_tsv.op("@@")(
                func.websearch_to_tsquery("english", query)
            )
        )
        .order_by(
            func.ts_rank_cd(
                ObsidianChunks.chunk_tsv,
                func.websearch_to_tsquery("english", query),
            ).desc()
        )
        .limit(20)
    )

    keyword_search_results = keyword_search.scalars().all()

    fused_chunks = reciprocal_rank_fusion(
        [vector_search_results, keyword_search_results]
    )

    if fused_chunks:
        top_chunks = rerank(query, fused_chunks)
    else:
        top_chunks = []

    response = await generate_response(chunks=top_chunks, question=query)
    return response
