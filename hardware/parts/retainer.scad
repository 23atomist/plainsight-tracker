// retainer.scad — ring on the centre tube that catches platform lift-off. Prints flat.
include <../lib/hardware.scad>
module retainer(v = "") difference() {
    cylinder(r = ret_r1, h = ret_t, $fn = 180);
    translate([0, 0, -1]) cylinder(r = tube_r0, h = ret_t + 2, $fn = 180);
    for (i = [0 : ret_n - 1]) rotate(i * 360 / ret_n + 60) translate([(tube_r0 + tube_r1) / 2, 0, ret_t]) {
        translate([0, 0, -ret_t - 1]) cylinder(d = m3_d, h = ret_t + 2);
        translate([0, 0, -2]) cylinder(d1 = m3_d, d2 = m3_cs_d, h = 2.01);   // countersink
    }
}
retainer();
