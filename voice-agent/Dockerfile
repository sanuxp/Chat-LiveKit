FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

# build tools for a few native wheels; libgomp for onnxruntime
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libgomp1 && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN uv sync --no-install-project

COPY main.py ./
COPY src ./src
# fetch the turn-detector / VAD model files at build time so the first call doesn't have to
RUN uv run python main.py download-files

CMD ["uv", "run", "python", "main.py", "start"]
