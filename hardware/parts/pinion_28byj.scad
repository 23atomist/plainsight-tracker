// pinion_28byj.scad — 24T module 1 pinion with a double-D bore for the 28BYJ-48 (focus and zoom).
include <../lib/hardware.scad>
use <../lib/gears.scad>
module pinion_28byj(v = "") difference() {
    union() {
        cylinder(d = ff_pin_hub_d, h = ff_pin_hub_l);
        translate([0, 0, ff_pin_hub_l - eps]) linear_extrude(height = ff_pin_face + eps, convexity = 10) involute_gear_2d(ff_m, ff_pin_N, gpa, gear_backlash);
    }
    // double-D bore: 5 mm shaft, 3 mm across flats
    translate([0, 0, -1]) intersection() {
        cylinder(d = ffm_shaft_d + 0.25, h = ff_pin_hub_l + ff_pin_face + 2);
        translate([-5, -(ffm_shaft_flat + 0.2) / 2, 0]) cube([10, ffm_shaft_flat + 0.2, ff_pin_hub_l + ff_pin_face + 2]);
    }
    translate([0, 0, ff_pin_hub_l + ff_pin_face - 2]) cylinder(d = ffm_shaft_d + 0.25, h = 3);   // round relief at the tip
    translate([0, 0, ff_pin_hub_l / 2]) rotate([90, 0, 0]) cylinder(d = 2.5, h = 20);   // M3 grub, self-tapped, onto a flat
}
pinion_28byj();
