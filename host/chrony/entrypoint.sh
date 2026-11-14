#!/bin/sh
# Render the config from env, then run chronyd in the foreground.
set -eu
: "${CHRONY_GPS_OFFSET:=0.0}"
: "${CHRONY_GPS_DELAY:=0.5}"
: "${CHRONY_ALLOW:=192.168.4.0/22}"
case "$CHRONY_GPS_OFFSET$CHRONY_GPS_DELAY" in
  *[!0-9.-]*) echo "chrony: CHRONY_GPS_OFFSET/DELAY must be numbers" >&2; exit 64 ;;
esac
case "$CHRONY_ALLOW" in
  *[!0-9./]*) echo "chrony: CHRONY_ALLOW must be an IPv4 CIDR" >&2; exit 64 ;;
esac
sed -e "s|__GPS_OFFSET__|$CHRONY_GPS_OFFSET|" \
    -e "s|__GPS_DELAY__|$CHRONY_GPS_DELAY|" \
    -e "s|__ALLOW__|$CHRONY_ALLOW|" \
    /etc/chrony/chrony.conf.tmpl > /etc/chrony/chrony.conf
mkdir -p /var/lib/chrony /run/chrony && chmod 0750 /run/chrony
echo "chrony: GPS offset ${CHRONY_GPS_OFFSET}s delay ${CHRONY_GPS_DELAY}s, serving ${CHRONY_ALLOW}"
exec chronyd -d -u root
