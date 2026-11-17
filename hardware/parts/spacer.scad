// spacer.scad — trunnion washer between arm and upright (2 needed).
include <../lib/hardware.scad>
module spacer(v = "") difference() { cylinder(d = spacer_d, h = spacer_t, $fn = 90); translate([0, 0, -1]) cylinder(d = stub_d + 0.4, h = spacer_t + 2, $fn = 60); }
spacer();
