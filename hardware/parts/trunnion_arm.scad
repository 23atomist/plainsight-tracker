// trunnion_arm.scad — variant "left": sector-gear arm (tilt drive); "right": plain arm.
// Bolts to the saddle block side; carries the 8 mm steel stub. Axis frame; printed inner face down.
include <../lib/hardware.scad>
use <../lib/gears.scad>
variant = "left";
module outline_2d(variant) {   // XZ relative to the pivot
    if (variant == "left") union() {
        sector_gear_2d(gm, tilt_N, sector_a0, sector_a1, gpa, gear_backlash);
        circle(r = hub_r, $fn = 90);
    } else hull() {
        circle(r = hub_r, $fn = 90);
        translate([saddle_x0 - pivot_x, block_z0 - pivot_z]) square([saddle_x1 - saddle_x0, arm_bolt_z[0] + 8 - block_z0]);
    }
}
module arm(variant = variant) {
    side = variant == "left" ? 1 : -1;
    y0 = side > 0 ? arm_y0 : -arm_y1;
    difference() {
        translate([pivot_x, y0, pivot_z]) rotate([90, 0, 0]) translate([0, 0, -arm_t]) linear_extrude(height = arm_t, convexity = 10) outline_2d(variant);
        // stub bore (press fit) and M4 set screw from the top of the hub
        translate([pivot_x, 0, pivot_z]) ycyl(stub_d + stub_fit, -100, 100);
        translate([pivot_x, side * (arm_y0 + arm_t / 2), pivot_z + hub_r]) insert_hole("m4", extra = hub_r - m4_insert_h - stub_d / 2 + 1);
        // 4 x M4 into the block side, heads counterbored on the outer face
        for (x = arm_bolt_x, z = arm_bolt_z) translate([x, side * arm_y1, z]) rotate([side > 0 ? -90 : 90, 0, 0]) cbore(m4_d, m4_head_d, m4_head_h, through = arm_t + 2);
    }
}
if (variant == "left") translate([0, 0, -arm_y0]) rotate([ 90, 0, 0]) arm("left");
else                   translate([0, 0, -arm_y0]) rotate([-90, 0, 0]) arm("right");
