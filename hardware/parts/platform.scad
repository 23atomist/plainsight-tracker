// platform.scad — rotating pan plate: race groove underneath, internal gear skirt, dust lip,
// M4 inserts for the two uprights on top. Base frame; printed top-face down.
include <../lib/hardware.scad>
use <../lib/gears.scad>
module platform(v = "") {
    difference() {
        union() {
            translate([0, 0, plat_z0]) cylinder(r = plat_r, h = plat_t, $fn = 360);
            translate([0, 0, skirt_z0]) linear_extrude(height = plat_z0 - skirt_z0 + eps, convexity = 10)
                internal_gear_2d(gm, pan_N, pan_skirt_r1, backlash = gear_backlash);
            translate([0, 0, lip_z0]) difference() { cylinder(r = lip_r1, h = plat_z0 - lip_z0 + eps, $fn = 360); translate([0, 0, -1]) cylinder(r = lip_r0, h = 50, $fn = 360); }
        }
        translate([0, 0, plat_z0]) mirror([0, 0, 1]) race_groove(race_r, face_z = 0);
        translate([0, 0, plat_z0 - 1]) cylinder(r = plat_hole_r, h = plat_t + 2, $fn = 180);
        translate([0, 0, plat_z0 - 1]) difference() { cylinder(r = shaft_relief[1], h = shaft_relief[2] + 1, $fn = 180); translate([0, 0, -1]) cylinder(r = shaft_relief[0], h = 10, $fn = 180); }   // pan motor shaft tip relief
        // upright feet: 4 x M4 inserts each side
        for (sy = [-1, 1], sx = [-1, 1], y = foot_bolt_y) translate([sx * foot_bolt_dx, sy * y, plat_z1]) insert_hole("m4");
        // cable tie slots either side of the centre hole
        for (s = [-1, 1]) translate([s * 34, 0, plat_z0 - 1]) slot(3.5, 10, plat_t + 2, [0, 1]);
        // orientation mark: notch at +X (lens side at pan 0)
        translate([plat_r - 3, 0, plat_z1 - 1]) cylinder(d = 4, h = 2);
    }
}
// print placement: top face down
translate([0, 0, plat_z1]) rotate([180, 0, 0]) platform();
