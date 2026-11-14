FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chrony \
 && rm -rf /var/lib/apt/lists/*
COPY chrony.conf.tmpl /etc/chrony/chrony.conf.tmpl
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# Runs as root on purpose: gpsd's NTP shared-memory units 0/1 are root-only.
# Needs `ipc: host` (to see gpsd's segments), `cap_add: SYS_TIME` (to set
# the clock) and `network_mode: host` (to serve NTP on :123 to the LAN).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
