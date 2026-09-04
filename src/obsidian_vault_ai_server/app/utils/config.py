from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    database_url: str
    database_url_alembic: str
    groq_api_key: str
    groq_model: str
    api_key: str


settings = Settings()
