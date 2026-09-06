"""create_vaults_obsidian_notes_and_obsidian_chunks

Revision ID: 7434d8dcdd10
Revises: f90918579177
Create Date: 2026-09-06 14:19:13.373444

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
import pgvector


# revision identifiers, used by Alembic.
revision: str = '7434d8dcdd10'
down_revision: Union[str, Sequence[str], None] = 'f90918579177'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop old tables if they exist to avoid index/table conflicts
    op.execute("DROP TABLE IF EXISTS chunks CASCADE")
    op.execute("DROP TABLE IF EXISTS jobs CASCADE")

    # Create vaults table
    op.create_table(
        'vaults',
        sa.Column('vault_id', sa.String(), nullable=False),
        sa.Column('vault_name', sa.String(length=255), nullable=True),
        sa.Column('owner_token', sa.String(), nullable=False),
        sa.Column('total_files', sa.Integer(), nullable=False),
        sa.Column('succeeded', sa.Integer(), nullable=False),
        sa.Column('failed_files', sa.JSON(), nullable=False),
        sa.Column('status', sa.String(), nullable=False),
        sa.PrimaryKeyConstraint('vault_id'),
    )
    op.create_index(op.f('ix_vaults_owner_token'), 'vaults', ['owner_token'], unique=False)

    # Create obsidian_notes table
    op.create_table(
        'obsidian_notes',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('vault_id', sa.String(), nullable=False),
        sa.Column('note_name', sa.String(), nullable=False),
        sa.Column('rel_filepath', sa.String(), nullable=True),
        sa.Column('wikilinks', sa.ARRAY(sa.Text()), nullable=False),
        sa.Column('backlinks', sa.ARRAY(sa.Text()), nullable=False),
        sa.Column('tags', sa.ARRAY(sa.Text()), nullable=False),
        sa.Column('front_matter', sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(['vault_id'], ['vaults.vault_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_notes_backlinks', 'obsidian_notes', ['backlinks'], unique=False, postgresql_using='gin')
    op.create_index('ix_notes_tags', 'obsidian_notes', ['tags'], unique=False, postgresql_using='gin')
    op.create_index('ix_notes_wikilinks', 'obsidian_notes', ['wikilinks'], unique=False, postgresql_using='gin')
    op.create_index(op.f('ix_obsidian_notes_note_name'), 'obsidian_notes', ['note_name'], unique=False)
    op.create_index(op.f('ix_obsidian_notes_vault_id'), 'obsidian_notes', ['vault_id'], unique=False)

    # Create obsidian_chunks table
    op.create_table(
        'obsidian_chunks',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('vault_id', sa.String(), nullable=False),
        sa.Column('note_id', sa.Integer(), nullable=False),
        sa.Column('chunk_index', sa.Integer(), nullable=False),
        sa.Column('chunk_text', sa.Text(), nullable=False),
        sa.Column('embedding', pgvector.sqlalchemy.vector.VECTOR(dim=768), nullable=False),
        sa.Column('chunk_tsv', postgresql.TSVECTOR(), sa.Computed("to_tsvector('english', chunk_text)", persisted=True), nullable=True),
        sa.ForeignKeyConstraint(['note_id'], ['obsidian_notes.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['vault_id'], ['vaults.vault_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_obsidian_chunks_tsv', 'obsidian_chunks', ['chunk_tsv'], unique=False, postgresql_using='gin')
    op.create_index(
        'ix_obsidian_chunks_vector_idx',
        'obsidian_chunks',
        ['embedding'],
        unique=False,
        postgresql_using='hnsw',
        postgresql_ops={'embedding': 'vector_cosine_ops'},
        postgresql_with={'m': 16, 'ef_construction': 64},
    )
    op.create_index(op.f('ix_obsidian_chunks_note_id'), 'obsidian_chunks', ['note_id'], unique=False)
    op.create_index(op.f('ix_obsidian_chunks_vault_id'), 'obsidian_chunks', ['vault_id'], unique=False)


def downgrade() -> None:
    op.drop_table('obsidian_chunks')
    op.drop_table('obsidian_notes')
    op.drop_table('vaults')
