# readsb built from source with ADALM-Pluto support (the ultrafeeder image's
# readsb lacks it). Publishes Beast on 127.0.0.1:31005 for ultrafeeder to consume.
ARG READSB_VERSION=v3.16.21

FROM debian:bookworm-slim AS build
ARG READSB_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config git ca-certificates libncurses-dev zlib1g-dev \
      libzstd-dev libusb-1.0-0-dev libiio-dev libad9361-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${READSB_VERSION}" https://github.com/wiedehopf/readsb /src
WORKDIR /src
RUN make -j"$(nproc)" PLUTOSDR=yes && install -m 0755 readsb /usr/local/bin/readsb

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libiio0 libad9361-0 libusb-1.0-0 libzstd1 libncurses6 zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/readsb /usr/local/bin/readsb
ENTRYPOINT []
