import shutil
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

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
    """2-stage graph-aware retrieval pipeline:

    1. Primary Search: Top 20 Vector + Top 20 Keyword -> RRF -> Rerank to Top 5
    2. Graph Expansion: Extract wikilinks and backlinks from top 5 notes, deduplicate
    3. Connected Search: Top 20 Vector + Top 20 Keyword on connected notes -> RRF -> Rerank to Top 5
    4. Generation: Pass separated primary and connected contexts to LLM
    """

    # Ensure vault exists
    stmt = select(Vaults).where(Vaults.vault_id == job_id).exists()
    vault_exists = await db.scalar(select(stmt))

    if not vault_exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Vault ID not found!"
        )

    # 1. Primary Hybrid Search
    query_embedding = embedder.generate_embeddings(query)
    if hasattr(query_embedding, "tolist"):
        query_embedding = query_embedding.tolist()

    # Vector search top 20
    vector_search = await db.execute(
        select(ObsidianChunks)
        .options(selectinload(ObsidianChunks.note))
        .where(ObsidianChunks.vault_id == job_id)
        .where(ObsidianChunks.embedding.cosine_distance(query_embedding) < 0.5)
        .order_by(ObsidianChunks.embedding.cosine_distance(query_embedding))
        .limit(20)
    )
    vector_search_results = vector_search.scalars().all()

    # Keyword search top 20
    keyword_search = await db.execute(
        select(ObsidianChunks)
        .options(selectinload(ObsidianChunks.note))
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

    # Reciprocal Rank Fusion
    fused_chunks = reciprocal_rank_fusion(
        [vector_search_results, keyword_search_results]
    )

    # Rerank to top 5 primary chunks
    primary_chunks = rerank(query, fused_chunks, top_k=5)

    # 2. Graph Expansion: find connected notes (wikilinks and backlinks)
    connected_chunks = []
    if primary_chunks:
        primary_note_ids = {c.note_id for c in primary_chunks if c.note_id}

        notes_stmt = select(ObsidianNotes).where(
            ObsidianNotes.vault_id == job_id,
            ObsidianNotes.id.in_(primary_note_ids),
        )
        notes_res = await db.execute(notes_stmt)
        primary_parent_notes = notes_res.scalars().all()

        # Deduplicate all connected note names from wikilinks & backlinks
        connected_note_names = set()
        for note in primary_parent_notes:
            for link in note.wikilinks or []:
                if link and link.strip():
                    connected_note_names.add(link.strip())
            for link in note.backlinks or []:
                if link and link.strip():
                    connected_note_names.add(link.strip())

        # 3. Secondary Search on Connected Notes
        if connected_note_names:
            conn_notes_stmt = select(ObsidianNotes.id).where(
                ObsidianNotes.vault_id == job_id,
                ObsidianNotes.note_name.in_(list(connected_note_names)),
            )
            conn_notes_res = await db.execute(conn_notes_stmt)
            connected_note_ids = conn_notes_res.scalars().all()

            if connected_note_ids:
                conn_vector_search = await db.execute(
                    select(ObsidianChunks)
                    .options(selectinload(ObsidianChunks.note))
                    .where(ObsidianChunks.vault_id == job_id)
                    .where(ObsidianChunks.note_id.in_(connected_note_ids))
                    .where(
                        ObsidianChunks.embedding.cosine_distance(
                            query_embedding
                        )
                        < 0.5
                    )
                    .order_by(
                        ObsidianChunks.embedding.cosine_distance(
                            query_embedding
                        )
                    )
                    .limit(20)
                )
                conn_vector_results = conn_vector_search.scalars().all()

                conn_keyword_search = await db.execute(
                    select(ObsidianChunks)
                    .options(selectinload(ObsidianChunks.note))
                    .where(ObsidianChunks.vault_id == job_id)
                    .where(ObsidianChunks.note_id.in_(connected_note_ids))
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
                conn_keyword_results = conn_keyword_search.scalars().all()

                fused_connected_chunks = reciprocal_rank_fusion(
                    [conn_vector_results, conn_keyword_results]
                )

                connected_chunks = rerank(
                    query, fused_connected_chunks, top_k=5
                )

    # 4. Generate LLM response with separated primary and connected context
    response = await generate_response(
        primary_chunks=primary_chunks,
        connected_chunks=connected_chunks,
        question=query,
    )
    return response
