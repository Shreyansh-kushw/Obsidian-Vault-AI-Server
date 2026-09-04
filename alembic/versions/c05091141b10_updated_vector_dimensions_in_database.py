"""updated vector dimensions in database

Revision ID: c05091141b10
Revises: 84fedeb34456
Create Date: 2026-06-14 12:51:23.882093

"""

from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c05091141b10"
down_revision: str | Sequence[str] | None = "84fedeb34456"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade():
    op.drop_column("chunks", "embedding")
    op.add_column("chunks", sa.Column("embedding", Vector(768), nullable=True))


def downgrade():
    op.drop_column("chunks", "embedding")
    op.add_column("chunks", sa.Column("embedding", Vector(384), nullable=True))
