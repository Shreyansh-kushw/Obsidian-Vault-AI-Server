from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.utils.config import settings

SQLALCHEMY_DATABASE_URL = settings.database_url


engine = create_async_engine(SQLALCHEMY_DATABASE_URL)

AsyncSessionLocal = async_sessionmaker(
    bind=engine, class_=AsyncSession, expire_on_commit=False
)


class Base(DeclarativeBase): ...


async def get_db():
    """Creates a database session and yields it"""

    async with AsyncSessionLocal() as session:
        yield session
