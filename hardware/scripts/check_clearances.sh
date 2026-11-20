#!/usr/bin/env bash
# Interference checks: renders intersection() of item pairs and fails if any has real volume (> 1 mm^3).
# FF_DRIVE=belt|gear|nema checks that focus/zoom drive instead of config.scad's default.
set -u
cd "$(dirname "$0")/.."
OS=${OPENSCAD:-/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD}
mkdir -p build/clearance; rm -f build/clearance/*
check() {   # a b tilt [ring_rot]
    local a=$1 b=$2 t=$3 rr=${4:-0}
    local out="build/clearance/${a}__${b}_t${t}_r${rr}.stl"
    "$OS" -o "$out" --export-format asciistl ${FF_DRIVE:+-D "ff_drive=\"$FF_DRIVE\""} -D "a=\"$a\"" -D "b=\"$b\"" -D "tilt=$t" -D "ring_rot=$rr" tests/clearance.scad > "${out%.stl}.log" 2>&1
    if grep -q "ERROR" "${out%.stl}.log"; then echo "99999 OPENSCAD-ERROR see ${out%.stl}.log" > "${out%.stl}.result";
    else python3 scripts/stl_volume.py "$out" > "${out%.stl}.result"; fi
}
J=${JOBS:-8}; n=0
run() { check "$@" & n=$((n+1)); if [ $((n % J)) -eq 0 ]; then wait; fi; }
tilts="-3 0 20 45 70 90 93"
for t in $tilts; do for b in upright_left upright_right tilt_motor tilt_pinion platform deck; do run payload $b $t; done; done
for t in 0 20 45 70 90 93; do run payload stop_screw $t; done   # at -3 deg the stop is meant to touch
for t in $tilts; do run arm_left tilt_pinion $t; done
# static pairs inside the payload
for p in "cradle clamp" "cradle arm_left" "cradle arm_right" "cradle nose" "cradle lens" "cradle camera" "cradle adapter" "cradle panel" \
         "clamp lens" "clamp arm_left" "clamp arm_right" "clamp panel" "arm_left lens" "arm_right lens" "arm_left panel" \
         "nose lens" "nose ff_motors" "nose ff_pinions" "nose arm_left" "nose arm_right" "ff_pinions lens" "ff_motors lens" "ff_motors cradle" \
         "ff_motors arm_left" "ff_motors arm_right" "ff_motors clamp" \
         "ff_pinions ff_motors" "ff_pinions cradle" "ff_pinions clamp" "ff_pinions arm_left" "ff_pinions arm_right" "ff_pinions panel" "stubs arm_left" "stubs arm_right" "spacers arm_left" "spacers arm_right" \
         "nose_bolts nose" "nose_bolts cradle" "nose_bolt_access nose" "nose_bolt_access ff_motors" "nose_bolt_access ff_pinions" \
         "nose_bolt_access lens" "nose_bolt_access cradle"; do run $p 0; done
for rr in -70 0 70; do for a in nose_bolts nose_bolt_access; do run ring_gears $a 0 $rr; done; done
for rr in -70 -35 0 35 70; do for b in cradle nose clamp ff_pinions lens ff_motors arm_left arm_right; do run ring_gears $b 0 $rr; done; done
for rr in -150 -120 -90 -60 -30 0 30 60 90 120 150 180; do run ring_gears panel 0 $rr; done   # lugs vs the AF/VR switches, full turn
# fork and base
for p in "upright_left platform" "upright_right platform" "tilt_motor upright_left" "tilt_motor platform" "tilt_pinion upright_left" "tilt_motor deck" \
         "platform deck" "platform retainer" "platform balls" "deck balls" "platform pan_pinion" "pan_pinion deck" "pan_motor deck" "pan_motor housing" \
         "deck housing" "platform housing" "platform pan_motor" "retainer deck" \
         "tray housing" "tray deck" "tray pan_motor" "boards pan_motor" "boards housing" "boards deck" "boards tray" \
         "tripod tray" "tripod housing" "tripod pan_motor" "tripod boards" "tripod deck" "tripod_head tripod" "tripod_head tray" "tripod_head housing"; do run $p 0; done
wait
n=0; fail=0
for r in build/clearance/*.result; do
    n=$((n+1)); name=$(basename "${r%.result}")
    vol=$(cut -d' ' -f1 "$r"); bbox=$(cut -d' ' -f2- "$r")
    if awk "BEGIN{exit !($vol > 1)}"; then echo "FAIL  $name : overlap ${vol} mm^3 bbox $bbox"; fail=$((fail+1)); fi
done
echo "----"; echo "$n checks, $fail failures"
[ "$fail" -eq 0 ]
