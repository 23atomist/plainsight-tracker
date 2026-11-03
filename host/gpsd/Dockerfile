FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gpsd \
 && rm -rf /var/lib/apt/lists/*
# Device and flags come from compose (`gpsd -N -n <device> -G`).
ENTRYPOINT ["gpsd"]
