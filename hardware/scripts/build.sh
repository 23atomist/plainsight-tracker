#!/usr/bin/env bash
# Renders every printable part to build/stl/*.stl (+ preview PNG) and the assembly views.
set -u
cd "$(dirname "$0")/.."
OS=${OPENSCAD:-/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD}
mkdir -p build/stl build/png
if bad=$(grep -n -E '^[^ /].*(mirror\(|scale\(\[[^]]*-)' parts/*.scad); then
    echo "FAIL  top-level mirror()/negative scale in a print placement:"; echo "$bad"; exit 1
fi
R=scripts/render.sh
$R deck             parts/deck.scad &
$R housing          parts/housing.scad &
$R platform         parts/platform.scad &
$R retainer         parts/retainer.scad &
$R pinion_nema      parts/pinion_nema.scad &
$R upright_left     parts/upright.scad -D 'variant="left"' &
$R upright_right    parts/upright.scad -D 'variant="right"' &
$R cradle_body      parts/cradle_body.scad &
wait
$R lens_clamp       parts/lens_clamp.scad &
$R arm_left         parts/trunnion_arm.scad -D 'variant="left"' &
$R arm_right        parts/trunnion_arm.scad -D 'variant="right"' &
$R spacer           parts/spacer.scad &
$R controller_tray  parts/controller_tray.scad &
$R tray_foot        parts/tray_foot.scad &
$R tripod_spider    parts/tripod_spider.scad &
wait
# focus / zoom drive parts, one set per motor type -- the suffix names the motor:
#   _tb35  = 35 mm PM geared stepper (TB35-4-10.5) + GT2 belt    (ff_drive = "belt")
#   _28byj = 28BYJ-48 + m1 spur gears                            (ff_drive = "gear")
#   _nema17 = NEMA 17 pancake + stock GT2 pulley, FOCUS ONLY      (ff_drive = "nema")
$R nose_tb35         parts/nose.scad         -D 'ff_drive="belt"' &
$R ring_focus_tb35   parts/ring_gear.scad    -D 'variant="focus"' -D 'ff_drive="belt"' &
$R ring_zoom_tb35    parts/ring_gear.scad    -D 'variant="zoom"'  -D 'ff_drive="belt"' &
$R pulley_tb35       parts/pulley_tb35.scad  -D 'ff_drive="belt"' &
$R nose_28byj        parts/nose.scad         -D 'ff_drive="gear"' &
$R ring_focus_28byj  parts/ring_gear.scad    -D 'variant="focus"' -D 'ff_drive="gear"' &
$R ring_zoom_28byj   parts/ring_gear.scad    -D 'variant="zoom"'  -D 'ff_drive="gear"' &
$R pinion_28byj      parts/pinion_28byj.scad -D 'ff_drive="gear"' &
wait
$R nose_nema17       parts/nose.scad         -D 'ff_drive="nema"' &
$R ring_focus_nema17 parts/ring_gear.scad    -D 'variant="focus"' -D 'ff_drive="nema"' &
wait
for t in 0 45 90; do
    "$OS" -o "build/png/assembly_tilt$t.png" --render --viewall --autocenter --imgsize=1200,900 --colorscheme=Tomorrow -D "tilt_angle=$t" assembly.scad > "build/png/assembly_tilt$t.log" 2>&1 &
done
"$OS" -o "build/png/assembly_payload.png" --render --viewall --autocenter --imgsize=1200,900 --colorscheme=Tomorrow -D show_base=false assembly.scad > build/png/assembly_payload.log 2>&1 &
wait
echo "done"
