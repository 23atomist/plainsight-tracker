// nose.scad — keel under the lens with the focus (left) and zoom (right) 28BYJ-48 bracket plates.
// Bolts to the saddle block front face. Axis frame; prints keel down.
include <../lib/hardware.scad>
use <../lib/gears.scad>
module bracket_profile_2d(s, cd, a) {   // (Y, Z), one side: stem from the keel, arc around the lens, pad sector at the motor
    a_pad = s > 0 ? a : 180 - a;                 // global YZ angle of the motor (from +Y toward +Z)
    a0 = s > 0 ? -90 : a_pad;  a1 = s > 0 ? a_pad : 270;
    difference() {
        union() {
            polygon([[0, keel_z0], [s * keel_hw, keel_z0], [s * keel_hw, ffb_stem_z1], [0, ffb_stem_z1]]);
            pie_2d(ffb_lens_r + 10, a0, a1);
            pie_2d(ffb_pad_r(cd), a_pad - ffb_pad_half_angle, a_pad + ffb_pad_half_angle);
        }
        circle(r = ffb_lens_r, $fn = 240);
    }
}
module bracket(x0, s, cd, a, body_dir) {   // s = side, a = pinion angle from outward-horizontal toward +Z, body_dir +1 fwd / -1 rear
    dir = [s * cos(a), sin(a)];              // radial unit vector (Y, Z)
    tan_ = [-s * sin(a), cos(a)];            // tangent
    pin = cd * dir; body = (cd + ffm_shaft_off) * dir;
    difference() {
        translate([x0, 0, 0]) rotate([90, 0, 90]) linear_extrude(height = ffb_t, convexity = 6) bracket_profile_2d(s, cd, a);
        translate([x0 - 1, pin[0], pin[1]]) xcyl(ffm_boss_d + fit_hole, 0, ffb_t + 2);
        for (e = [-1, 1]) translate([body_dir > 0 ? x0 + ffb_t : x0, body[0] + e * tan_[0] * ffm_ear_pitch / 2, body[1] + e * tan_[1] * ffm_ear_pitch / 2]) rotate([0, body_dir * 90, 0]) insert_hole("m4", extra = 0);
    }
}
module nose(v = "") {
    difference() {
        union() {
            translate([keel_x0, -keel_hw, keel_z0]) cube([keel_x1 - keel_x0, 2 * keel_hw, keel_z1 - keel_z0]);
            translate([keel_x0, -keel_hw, keel_z0]) cube([nose_flange_t, 2 * keel_hw, nose_flange_z1 - keel_z0]);
            bracket(focus_plate_x0, ff_focus_side, focus_cd, ff_focus_angle, +1);
            bracket(zoom_plate_x0, ff_zoom_side, zoom_cd, ff_zoom_angle, -1);
        }
        // 4 x M4 x 40 from the keel front face, straight through keel + flange into the block inserts
        // (no lightening window: it would cut into the inner two bores)
        for (y = nose_bolt_y, z = nose_bolt_z) translate([0, y, z]) xcyl(m4_d, keel_x0 - 1, keel_x1 + 1);
    }
}
translate([0, 0, -keel_z0]) nose();
