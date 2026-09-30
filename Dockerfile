FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libgl1 \
    libglib2.0-0 \
    libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# This public repository contains the tracked Keras checkpoint and landmarker.
RUN git clone --depth 1 https://github.com/anjalika-r/Modeltraining.git /opt/model
RUN pip install --no-cache-dir -r /opt/model/requirements.txt

WORKDIR /app
COPY api_server.py /app/api_server.py
COPY ["SignSense/Main files/letter_signs", "/app/letter_signs"]
ENV SIGNSENSE_MODEL_REPO=/opt/model
ENV PYTHONUNBUFFERED=1
CMD ["python", "api_server.py"]
