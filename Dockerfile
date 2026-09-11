# SPDX-FileCopyrightText: Ryan Madhuwala [rawx18.dev@gmail.com](mailto:rawx18.dev@gmail.com)
# SPDX-License-Identifier: AGPL-3.0-only

ARG PYTHON_IMAGE=python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6

FROM ghcr.io/astral-sh/uv:0.12.3@sha256:2d890623d310b57771ce840f0da5eed5fc6d657da05ffaa45d82797b53fa3abc AS uv

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/index.html frontend/tsconfig.json frontend/vite.config.ts ./
COPY frontend/src/ ./src/
RUN npm run build

FROM ${PYTHON_IMAGE} AS dependencies
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --python /usr/local/bin/python

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH="/app/backend/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libasound2 libssl3 libstdc++6 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g app -m 0700 /data
COPY --from=dependencies /app/backend/.venv /app/backend/.venv
COPY backend/app/ /app/backend/app/
COPY config.toml LICENSE.md ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
RUN python -c "from pipecat.transports.daily.transport import DailyTransport; from pipecat.services.azure.stt import AzureSTTService; from pipecat.services.azure.tts import AzureTTSService; from pipecat.services.azure.llm import AzureLLMService"
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--app-dir", "/app/backend", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--timeout-graceful-shutdown", "10"]
