# Pydent LiveKit worker — built and run by LiveKit Cloud (`lk agent create`).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py .

# Download model files (turn detector etc.) at build time so cold starts are fast.
RUN python agent.py download-files || true

CMD ["python", "agent.py", "start"]
