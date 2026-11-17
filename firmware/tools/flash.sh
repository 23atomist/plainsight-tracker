#!/bin/sh
# Flash plainsight firmware from the Pi: BOOTSEL over the protocol, then copy
# the UF2 onto the RPI-RP2 drive. Settings (stored in the last flash sector)
# are kept.  Usage: ./flash.sh firmware.uf2
set -e
UF2=${1:-firmware.uf2}
[ -f "$UF2" ] || { echo "no $UF2"; exit 1; }
cd "$(dirname "$0")"
python3 ptz.py repl <<EOF >/dev/null 2>&1 || true
BOOTSEL
EOF
echo "waiting for RPI-RP2 drive..."
for i in $(seq 1 30); do
  DEV=$(lsblk -rno PATH,LABEL | awk '$2=="RPI-RP2"{print $1; exit}')
  [ -n "$DEV" ] && break
  sleep 1
done
[ -n "$DEV" ] || { echo "RPI-RP2 drive did not appear"; exit 1; }
MNT=$(mktemp -d)
sudo mount "$DEV" "$MNT"
sudo cp "$UF2" "$MNT"/
sync
sudo umount "$MNT" 2>/dev/null || true  # the board reboots itself as the copy finishes
rmdir "$MNT"
echo "flashed; waiting for the controller..."
for i in $(seq 1 20); do
  [ -e /dev/serial/by-id/usb-Raspberry_Pi_Pico_* ] 2>/dev/null && ls /dev/serial/by-id/usb-Raspberry_Pi_Pico_* >/dev/null 2>&1 && break
  sleep 1
done
sleep 1
python3 ptz.py status
