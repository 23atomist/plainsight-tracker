// ring_gear.scad — clamp-on half ring for the focus or zoom ring: an m1 spur ring gear (ff_drive "gear"), a flanged GT2
// belt pulley ring (ff_drive "belt"; flat flange on the bed, 45 deg flange on top), or for "nema" the same GT2 band with
// a collar on top that carries the clamp lugs in line with the bore (lugs on the lens side away from the camera).
// Two identical halves per ring: each half has one insert lug and one through lug, so assembled 180 deg apart every
// joint has both. Local frame: gear axis = Z, split plane = XZ, this half is y >= 0. Prints as modelled (lugs up).
include <../lib/hardware.scad>
use <../lib/gears.scad>
variant = "focus";
module ring_half(variant = variant) {
    N   = variant == "focus" ? focus_gear_N : zoom_gear_N;
    rid = variant == "focus" ? focus_rid : zoom_rid;
    lrid = variant == "focus" ? focus_lug_rid : zoom_lug_rid;
    rl1 = variant == "focus" ? focus_lug_r1 : zoom_lug_r1;
    if (ff_nema) collar_ring_half(variant, N, rid, rl1);
    else difference() {
        union() {
            if (ff_belt) belt_band(N);
            else linear_extrude(height = ff_ring_w, convexity = 10) involute_gear_2d(ff_m, N, gpa, gear_backlash);
            translate([lrid, 0, ff_ring_w - eps]) cube([rl1 - lrid, ff_lug_t, ff_lug_l + eps]);        // insert lug at +X
            translate([-rl1, 0, ff_ring_w - eps]) cube([rl1 - lrid, ff_lug_t, ff_lug_l + eps]);        // through lug at -X
        }
        translate([0, 0, -1]) cylinder(r = rid, h = ff_ring_w + 2, $fn = 240);
        translate([-200, -200, -1]) cube([400, 200, ff_ring_w + ff_lug_l + 2]);                            // keep y >= 0
        translate([(lrid + rl1) / 2, 0, ff_ring_w + ff_lug_l / 2]) rotate([90, 0, 0]) insert_hole("m3");
        translate([-(lrid + rl1) / 2, ff_lug_t, ff_ring_w + ff_lug_l / 2]) rotate([-90, 0, 0]) cbore(m3_d, m3_head_d, m3_head_h, through = ff_lug_t + 2);
    }
}
// nema: GT2 band (z 0..9.5) + full collar (to ff_ring_w) at the flange radius; lugs from the top of the teeth (z 8) to the
// top, their underside chamfered 45 deg out from the flange (no overhang over the grooves beyond a 1.5 mm ledge).
// Bore = lens ring + liner; past the front edge of the lens ring it steps out to clear the barrel by 1 mm.
module collar_ring_half(variant, N, rid, r1) {
    od  = variant == "focus" ? focus_ring_od : zoom_ring_od;
    x0  = variant == "focus" ? focus_gear_x0 : zoom_gear_x0;
    lens_x1 = variant == "focus" ? focus_ring_x + focus_ring_w / 2 : zoom_ring_x + zoom_ring_w / 2;
    ro = ring_out_r(od);
    zt = ff_flange_t + ff_tooth_w;               // top of the teeth
    zh = (zt + ff_ring_w) / 2;  rh = (rid + r1) / 2;
    module lug(s) translate([0, ff_lug_t, 0]) rotate([90, 0, 0]) linear_extrude(height = ff_lug_t)
        polygon([[s * rid, zt], [s * ro, zt], [s * r1, zt + r1 - ro], [s * r1, ff_ring_w], [s * rid, ff_ring_w]]);
    difference() {
        union() {
            belt_band(N);
            translate([0, 0, ff_band_w - eps]) cylinder(r = ro, h = ff_ring_w - ff_band_w + eps, $fn = max(60, 2 * N));
            lug(1); lug(-1);
        }
        translate([0, 0, -1]) cylinder(r = rid, h = ff_ring_w + 2, $fn = 240);
        translate([0, 0, lens_x1 - x0]) cylinder(r = max(rid, lens_rear_barrel_d / 2 + 1), h = ff_ring_w + 1, $fn = 240);
        translate([-200, -200, -1]) cube([400, 200, ff_ring_w + 2]);                                       // keep y >= 0
        translate([rh, 0, zh]) rotate([90, 0, 0]) insert_hole("m3");   // M3 x 12: head seat 5.8 above the split, tip 6.2 into the insert
        translate([-rh, -1, zh]) rotate([-90, 0, 0]) cylinder(d = m3_d, h = ff_lug_t + 2);
        // head pocket: the screw axis runs inside the collar, so the head and the driver come in through a slot open to
        // the top and the outside (no bridge to print, no thin fin left beside it)
        hull() for (x = [-rh, -r1 - 5], z = [zh, ff_ring_w + 5])
            translate([x, ff_lug_t - m3_head_h, z]) rotate([-90, 0, 0]) cylinder(d = m3_head_d + 0.6, h = 40);
    }
}
ring_half(variant);
