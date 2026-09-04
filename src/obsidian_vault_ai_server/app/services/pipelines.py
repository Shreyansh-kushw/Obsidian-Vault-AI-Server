from pathlib import Path

from docling.document_converter import DocumentConverter
from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from obsidian_vault_ai_server.app.database import AsyncSessionLocal
from obsidian_vault_ai_server.app.models import Chunks, Jobs
from obsidian_vault_ai_server.app.services import embedder
from obsidian_vault_ai_server.app.services.chunker import chunker, generate_chunks
from obsidian_vault_ai_server.app.services.llm_service import generate_response
from obsidian_vault_ai_server.app.services.reranker_service import rerank
from obsidian_vault_ai_server.app.utils.retrieval_utils import reciprocal_rank_fusion

# Helper Pipelines

def markdown_pipeline(filepath: Path):
    """Processes the markdown file and returns the chunks of the extracted text"""

    # initializing the converter
    converter = DocumentConverter()

    return generate_chunks(dl_doc=converter.convert(filepath).document)


# Main data ingestion pipeline


async def ingestion_pipeline(
    filename: str, filepath: Path, job_id: str, index: int
):
    """The main ingest data pipeline"""

    try:
        # getting the filename and filetype
        file_ext = filepath.suffix
        
        chunks = markdown_pipeline(filepath)

        # generating embeddings and adding to the table in database
        embeddings = embedder.generate_embeddings(
            [chunker.contextualize(chunk) for chunk in chunks]
        )

        async with AsyncSessionLocal() as db:
            for chunk, embedding in zip(chunks, embeddings):
                new_chunk_field = Chunks(
                    job_id=job_id,
                    source_filename=filename,
                    chunk_text=chunker.contextualize(chunk),
                    embedding=embedding,
                )

                db.add(new_chunk_field)

            try:
                await db.commit()

            except Exception:
                await db.rollback()
                raise

    except Exception as e:
        async with AsyncSessionLocal() as db:
            job = await db.get(Jobs, job_id)
            if job:
                job.succeeded = index + 1
                job.failed_files = {"filename": filename, "error": str(e)}
                job.status = "Failed"

                try:
                    await db.commit()
                except Exception:
                    await db.rollback()
        raise
    
    else:
        async with AsyncSessionLocal() as db:
            job = await db.get(Jobs, job_id)
            if job:
                job.succeeded += 1

                if job.succeeded == job.total_files:
                    job.status = "Success"

                try:
                    await db.commit()
                except Exception:
                    await db.rollback()

    finally:
        # Clean up local file from upload_files directory
        if filepath.exists():
            filepath.unlink(missing_ok=True)


# Main retrieval pipeline


async def retrieval_pipeline(query: str, job_id: str, db: AsyncSession):
    """Main retrieval pipeline"""

    # generating embeddings for the query
    query_embedding = embedder.generate_embeddings(query)

    stmt = select(Jobs).where(Jobs.job_id == job_id).exists()
    job_exists = await db.scalar(select(stmt))
    
    if not job_exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Job ID not found!"
        )

    # getting all the database fields with the given filename.
    vector_search = await db.execute(
        select(Chunks)
        .where(Chunks.job_id == job_id)
        .where(Chunks.embedding.cosine_distance(query_embedding) < 0.5)
        .order_by(Chunks.embedding.cosine_distance(query_embedding))
        .limit(20)
    )

    vector_search_results = vector_search.scalars().all()

    keyword_search = await db.execute(
        select(Chunks)
        .where(Chunks.job_id == job_id)
        .where(Chunks.chunk_tsv.op("@@")(
            func.websearch_to_tsquery("english", query)
        ))
        .order_by(
            func.ts_rank_cd(
                Chunks.chunk_tsv,
                func.websearch_to_tsquery("english", query)
            ).desc()
        )
        .limit(20)
    )

    keyword_search_results = keyword_search.scalars().all()

    fused_chunks = reciprocal_rank_fusion([vector_search_results, keyword_search_results])

    if fused_chunks:
        top_chunks = rerank(query, fused_chunks)

    else:
        top_chunks = []

    response = await generate_response(chunks=top_chunks, question=query)
    return response
