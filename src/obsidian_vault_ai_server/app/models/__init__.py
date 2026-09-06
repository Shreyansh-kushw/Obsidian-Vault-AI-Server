from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, Computed, Index, Integer, String, Text, ARRAY
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from obsidian_vault_ai_server.app.database import Base


class ObsidianChunks(Base):
    """Chunks table model for the database"""

    __tablename__ = "obsidian_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    vault_id: Mapped[str] = mapped_column(
        String, unique=False, nullable=False, index=True
    )

    source_filename: Mapped[str] = mapped_column(
        String,
        nullable=False,
    )

    chunk_index: Mapped[int] = mapped_column(
        Integer, nullable=False
    )

    chunk_text: Mapped[str] = mapped_column(
        Text,
        nullable=False,
    )

    embedding: Mapped[Vector] = mapped_column(
        Vector(768),
        nullable=False,
    )

    # Graph information belonging to the parent's node
    parent_wikilinks: Mapped[list[str]] = mapped_column(ARRAY[Text])
    parent_backlinks: Mapped[list[str]] = mapped_column(ARRAY[Text])    

    # creating the TSVECTOR column
    chunk_tsv: Mapped[TSVECTOR] = mapped_column(
        TSVECTOR,
        Computed("to_tsvector('english', chunk_text)", persisted=True),
        nullable=True,
    )

    # creating the GIN index on the TSVECTOR column
    __table_args__ = (
        Index("ix_chunks_tsv", "chunk_tsv", postgresql_using="gin"),
        Index(
            "ix_chunks_vector_idx", # name of the index
            "embedding", # name of the column
            postgresql_using="hnsw",
            postgresql_ops={"embedding":"vector_cosine_ops"},
            postgresql_with={
                "m":16,
                "ef_construction":64,
            }
        ),
        
        # Graph lookups
        Index(
            "chunks_wikilinks_idx",
            "parent_wikilinks",
            postgresql_using="gin",
        ),

        Index(
            "chunks_backlinks_idx",
            "parent_backlinks",
            postgresql_using="gin",
        ),
    )

    """
    Think of tsvector as pgvector but for normal text,
    and GIN as HNSW indexing for vector search, made to make searching queries 
    faster and more efficient.
    """


class Vaults(Base):
    __tablename__ = "vaults"
    vault_id: Mapped[str] = mapped_column(String, primary_key=True)
    vault_name: Mapped[str] = mapped_column(String(255), nullable=True)
    owner_token: Mapped[str] = mapped_column(String, index=True, nullable=False)
    total_files: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    succeeded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_files: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String, nullable=False, default="Processing")
