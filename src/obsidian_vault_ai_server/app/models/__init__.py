from pgvector.sqlalchemy import Vector
from sqlalchemy import Integer, String, Text, JSON, Index, Computed
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.dialects.postgresql import TSVECTOR

from app.database import Base


class Chunks(Base):
    """Chunks table model for the database"""

    __tablename__ = "chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    job_id: Mapped[str] = mapped_column(
        String, unique=False, nullable=False, index=True
    )

    source_filename: Mapped[str] = mapped_column(
        String,
        nullable=False,
    )

    chunk_text: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )


    embedding: Mapped[Vector] = mapped_column(
        Vector(768),
        nullable=False,
    )

    # creating the TSVECTOR column
    chunk_tsv: Mapped[TSVECTOR] = mapped_column(
        TSVECTOR,
        Computed("to_tsvector('english', chunk_text)", persisted=True),
        nullable=True,
    )

    # creating the GIN index on the TSVECTOR column
    __table_args__ = (
        Index("ix_chunks_tsv", "chunk_tsv", postgresql_using="gin"),
    )

    """
    Think of tsvector as pgvector but for normal text,
    and GIN as HNSW indexing for vector search, made to make searching queries 
    faster and more efficient.
    """


class Jobs(Base):
    __tablename__ = "jobs"
    job_id: Mapped[str] = mapped_column(String, primary_key=True)
    owner_token: Mapped[str] = mapped_column(String, index=True, nullable=False)
    total_files: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    succeeded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_files: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String, nullable=False, default="Processing")
