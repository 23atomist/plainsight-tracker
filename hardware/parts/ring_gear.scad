// ring_gear.scad — clamp-on half ring gear for the focus or zoom ring. Two identical halves per ring:
// each half has one insert lug and one through lug, so assembled 180 deg apart every joint has both.
// Local frame: gear axis = Z, split plane = XZ, this half is y >= 0. Prints as modelled (lugs up).
include <../lib/hardware.scad>
use <../lib/gears.scad>
variant = "focus";
module ring_half(variant = variant) {
    N   = variant == "focus" ? focus_gear_N : zoom_gear_N;
    rid = variant == "focus" ? focus_rid : zoom_rid;
    lrid = variant == "focus" ? focus_lug_rid : zoom_lug_rid;
    rl1 = variant == "focus" ? focus_lug_r1 : zoom_lug_r1;
    difference() {
        union() {
            linear_extrude(height = ff_ring_w, convexity = 10) involute_gear_2d(ff_m, N, gpa, gear_backlash);
            translate([lrid, 0, ff_ring_w - eps]) cube([rl1 - lrid, ff_lug_t, ff_lug_l + eps]);        // insert lug at +X
            translate([-rl1, 0, ff_ring_w - eps]) cube([rl1 - lrid, ff_lug_t, ff_lug_l + eps]);        // through lug at -X
        }
        translate([0, 0, -1]) cylinder(r = rid, h = ff_ring_w + 2, $fn = 240);
        translate([-200, -200, -1]) cube([400, 200, ff_ring_w + ff_lug_l + 2]);                            // keep y >= 0
        translate([(lrid + rl1) / 2, 0, ff_ring_w + ff_lug_l / 2]) rotate([90, 0, 0]) insert_hole("m3");
        translate([-(lrid + rl1) / 2, ff_lug_t, ff_ring_w + ff_lug_l / 2]) rotate([-90, 0, 0]) cbore(m3_d, m3_head_d, m3_head_h, through = ff_lug_t + 2);
    }
}
ring_half(variant);
