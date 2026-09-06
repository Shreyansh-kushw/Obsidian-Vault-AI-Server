from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    ARRAY,
    JSON,
    Computed,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from obsidian_vault_ai_server.app.database import Base


class Vaults(Base):
    """Vaults table model for storing vault metadata and ingestion status"""

    __tablename__ = "vaults"

    vault_id: Mapped[str] = mapped_column(String, primary_key=True)
    vault_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    owner_token: Mapped[str] = mapped_column(String, index=True, nullable=False)
    total_files: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    succeeded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_files: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String, nullable=False, default="Processing")

    notes: Mapped[list["ObsidianNotes"]] = relationship(
        back_populates="vault", cascade="all, delete-orphan"
    )
    chunks: Mapped[list["ObsidianChunks"]] = relationship(
        back_populates="vault", cascade="all, delete-orphan"
    )


class ObsidianNotes(Base):
    """Obsidian notes table model storing graph information and note-level metadata"""

    __tablename__ = "obsidian_notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    vault_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("vaults.vault_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    note_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    rel_filepath: Mapped[str | None] = mapped_column(String, nullable=True)

    # Graph and note-level metadata
    wikilinks: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    backlinks: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    tags: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    front_matter: Mapped[dict] = mapped_column(JSON, default=dict)

    vault: Mapped["Vaults"] = relationship(back_populates="notes")
    chunks: Mapped[list["ObsidianChunks"]] = relationship(
        back_populates="note", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_notes_wikilinks", "wikilinks", postgresql_using="gin"),
        Index("ix_notes_backlinks", "backlinks", postgresql_using="gin"),
        Index("ix_notes_tags", "tags", postgresql_using="gin"),
    )


class ObsidianChunks(Base):
    """Chunks table model for text chunks, embeddings, and full-text search"""

    __tablename__ = "obsidian_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    vault_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("vaults.vault_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    note_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("obsidian_notes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[Vector] = mapped_column(Vector(768), nullable=False)

    chunk_tsv: Mapped[TSVECTOR] = mapped_column(
        TSVECTOR,
        Computed("to_tsvector('english', chunk_text)", persisted=True),
        nullable=True,
    )

    vault: Mapped["Vaults"] = relationship(back_populates="chunks")
    note: Mapped["ObsidianNotes"] = relationship(back_populates="chunks")

    __table_args__ = (
        Index("ix_obsidian_chunks_tsv", "chunk_tsv", postgresql_using="gin"),
        Index(
            "ix_obsidian_chunks_vector_idx",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
            postgresql_with={
                "m": 16,
                "ef_construction": 64,
            },
        ),
    )

    @property
    def source_filename(self) -> str:
        if self.note:
            return self.note.rel_filepath or self.note.note_name
        return ""


# Backwards compatibility aliases
Jobs = Vaults
Chunks = ObsidianChunks
