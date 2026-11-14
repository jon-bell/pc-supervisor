# Local OCR for injection.hidden's render-and-OCR diff (docs/agent.md §3.2).
# Build: docker build -t pcs-ocr:latest agent/ocr
# Run (the agent does this): docker run --rm --network none -v <dir>:/work pcs-ocr:latest /work/page.png stdout
FROM debian:stable-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENTRYPOINT ["tesseract"]
