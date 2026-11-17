// pinion_nema.scad — 12T module 1.25 pinion for a NEMA 17 D-shaft; same part for pan and tilt.
// Hub down on the bed, M3 insert radial in the hub for a set screw.
include <../lib/hardware.scad>
use <../lib/gears.scad>
module pinion_nema(v = "") {
    difference() {
        union() {
            cylinder(d = pin_hub_d, h = pin_hub_l);
            translate([0, 0, pin_hub_l - eps]) linear_extrude(height = pin_face + eps, convexity = 10) involute_gear_2d(gm, pin_N, gpa, gear_backlash);
        }
        d_bore(pin_hub_l + pin_face + 1);
        // set screw: M3 insert from the hub surface to the shaft flat side
        translate([0, -motor_shaft_d / 2 + 0.3, pin_hub_l / 2]) rotate([90, 0, 0]) translate([0, 0, pin_hub_d / 2 - motor_shaft_d / 2 + 0.3]) insert_hole("m3", extra = 1);
    }
}
pinion_nema();
