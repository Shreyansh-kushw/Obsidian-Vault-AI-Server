# ==============================================================================
# Backend Dockerfile for Obsidian-Vault-AI-Server
# Python 3.12 with uv fast package manager
# ==============================================================================

FROM python:3.12-slim AS base

# Prevent Python from writing .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/root/.cache/huggingface

# Install system dependencies (build tools, curl, libmagic for file validation)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    libmagic1 \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Install uv from official Astral binary
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Copy dependency definition files first for optimal layer caching
COPY pyproject.toml uv.lock* ./

# Install CPU-only PyTorch first to avoid downloading 2.5GB of unused NVIDIA CUDA packages, then install project dependencies
RUN uv pip install --system --no-cache torch --index-url https://download.pytorch.org/whl/cpu && \
    uv pip install --system --no-cache --extra-index-url https://download.pytorch.org/whl/cpu -r pyproject.toml

# Copy application source and configuration
COPY src/ ./src/
COPY alembic/ ./alembic/
COPY alembic.ini ./

# Ensure upload directory exists
RUN mkdir -p /app/upload_files

EXPOSE 8000

# Health check against server /health endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Start server using uvicorn
CMD ["uvicorn", "obsidian_vault_ai_server:app", "--host", "0.0.0.0", "--port", "8000"]
