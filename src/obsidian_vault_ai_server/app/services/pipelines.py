from pathlib import Path

import fitz
from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    EasyOcrOptions,
    PdfPipelineOptions,
)
from docling.document_converter import DocumentConverter, PdfFormatOption
from fastapi import HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chunks
from app.services import embedder
from app.services.chunker import chunker, generate_chunks
from app.services.llm_service import generate_response
from app.utils.retrieval_utils import reciprocal_rank_fusion
from app.services.reranker_service import rerank
from app.database import AsyncSessionLocal
from app.models import Jobs

# Helper Pipelines


def pdf_pipeline(
    filepath: Path,
):
    """Processes a PDF file and returns the chunks of the extracted text"""

    # initializing the PDF pipeline
    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = True
    pipeline_options.ocr_options = EasyOcrOptions()

    # initializing the docling converter
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=pipeline_options,
                backend=PyPdfiumDocumentBackend,  # Using PyPdfiumDocumentBackend to fix utf-8 codec error
            )
        }
    )

    # getting the total number of pages in pdf - for batching
    doc = fitz.open(filepath)
    page_count = doc.page_count
    doc.close()

    # checking if there is any need for batching.
    batching = True if page_count > 10 else False

    if batching:  # batching logic
        final_chunks = []
        for start in range(1, page_count + 1, 10):
            end = min(start + 9, page_count)
            print(f"Processing pages: {start}-{end}")

            result = converter.convert(filepath, page_range=(start, end))
            chunks = generate_chunks(dl_doc=result.document)
            final_chunks.extend(chunks)

        return final_chunks

    result = converter.convert(filepath)
    return generate_chunks(dl_doc=result.document)


def image_and_text_pipeline(filepath: Path):
    """Processes the text and image files and returns the chunks of the extracted text"""

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

        # calling the proper pipeline based on filetype
        if file_ext.lower() == ".pdf":  # pdf pipeline
            chunks = pdf_pipeline(filepath)

        elif file_ext.lower() in {
            ".txt",
            ".jpg",
            ".jpeg",
            ".png",
            ".gif",
            ".bmp",
            ".webp",
            ".tiff",
            ".tif",
        }:  # image and text pipeline
            chunks = image_and_text_pipeline(filepath)

        else:  # unsupported file type
            raise ValueError(f"Unsupported file type: {file_ext}")

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
        raise
    
    else:
        async with AsyncSessionLocal() as db:
            job = await db.execute(
                select(Jobs).where(Jobs.job_id==job_id)
            )
            job = job.scalars().first()

            job.succeeded += 1

            if job.succeeded == job.total_files:
                job.status = "Success"

            try:
                await db.commit()

            except Exception as e:
                await db.rollback()

                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
                )

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
