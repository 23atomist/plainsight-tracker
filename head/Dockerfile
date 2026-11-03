FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml ./
COPY plainsight_head/ plainsight_head/
RUN pip install .

# Serial and I2C devices are made accessible via compose group_add; no root needed.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin head \
    && mkdir -p /data && chown head:head /data
USER head

EXPOSE 8780
CMD ["python", "-m", "plainsight_head"]
