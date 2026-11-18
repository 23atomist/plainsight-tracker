// ============================================================================
// lib/hardware.scad — inserts, bearing pockets, motor patterns, race groove, helpers.
// ============================================================================
include <../config.scad>
eps = 0.01;

// Rounded box from z=0 up, corner radius r in XY.
module rbox(size, r = 3) {
    linear_extrude(height = size[2]) offset(r = r) offset(delta = -r) square([size[0], size[1]]);
}
// Cylinder along +X from x0 to x1 / along +Y / along +Z
module xcyl(d, x0, x1) { translate([x0, 0, 0]) rotate([0, 90, 0]) cylinder(d = d, h = x1 - x0); }
module ycyl(d, y0, y1) { translate([0, y0, 0]) rotate([-90, 0, 0]) cylinder(d = d, h = y1 - y0); }
module zcyl(d, z0, z1) { translate([0, 0, z0]) cylinder(d = d, h = z1 - z0); }

// Heat-set insert hole, axis -Z from z=0 (the face). size: "m3" | "m4" | "m5".
module insert_hole(size = "m3", extra = insert_extra) {
    d = size == "m3" ? m3_insert_d : size == "m4" ? m4_insert_d : m5_insert_d;
    h = size == "m3" ? m3_insert_h : size == "m4" ? m4_insert_h : m5_insert_h;
    pilot = size == "m3" ? 2.6 : size == "m4" ? 3.4 : 4.4;
    translate([0, 0, -h]) cylinder(d = d, h = h + eps);
    translate([0, 0, -h - extra]) cylinder(d = pilot, h = extra + eps);
    translate([0, 0, -0.6]) cylinder(d1 = d, d2 = d + 1.2, h = 0.6 + eps);   // lead-in chamfer
}
// Through hole with a counterbore for the head, axis Z, face at z=0, part below.
module cbore(d, head_d, head_h, through = 30) {
    translate([0, 0, -head_h]) cylinder(d = head_d, h = head_h + eps);
    translate([0, 0, -through]) cylinder(d = d, h = through + eps);
}
// Slot (stadium) along a direction vector dir (2D), length l, width w, extruded through t (z 0..t)
module slot(w, l, t, dir = [1, 0]) {
    a = atan2(dir[1], dir[0]);
    rotate(a) hull() { translate([-l / 2, 0, -eps]) cylinder(d = w, h = t + 2 * eps); translate([l / 2, 0, -eps]) cylinder(d = w, h = t + 2 * eps); }
}

// 608 pocket open on +Z (z=0 is the open face), with a lip hole below for the stub.
module bearing_pocket(b = b608, lip_hole = undef) {
    od = b[1] + fit_bearing;
    lh = lip_hole == undef ? b[0] + 1.5 : lip_hole;
    translate([0, 0, -b[2]]) cylinder(d = od, h = b[2] + eps);
    translate([0, 0, -50]) cylinder(d = lh, h = 100);
}

// NEMA 17 face cut along Z through thickness t (z 0..t); slot_l > 0 slots the bolt holes along slot_dir.
module nema17_cut(t, slot_l = 0, slot_dir = [0, 1], boss_d = motor_boss_d + fit_hole) {
    for (sx = [-1, 1], sy = [-1, 1]) translate([sx * motor_bolt_pitch / 2, sy * motor_bolt_pitch / 2, 0])
        if (slot_l > 0) slot(motor_bolt_d, slot_l, t, slot_dir); else translate([0, 0, -eps]) cylinder(d = motor_bolt_d, h = t + 2 * eps);
    translate([0, 0, -eps]) cylinder(d = boss_d, h = t + 2 * eps);
}
// Preview NEMA 17: face at z=0, shaft +Z, body below.
module nema17_body() {
    color("silver") translate([-motor_w / 2, -motor_w / 2, -motor_l]) cube([motor_w, motor_w, motor_l]);
    color("gray") cylinder(d = motor_boss_d - 0.3, h = motor_boss_h);
    color("gray") cylinder(d = motor_shaft_d, h = motor_shaft_l);
}
// D-shaft bore along +Z from z=0 to depth.
module d_bore(depth, d = motor_shaft_d + 0.25, flat = motor_shaft_flat + 0.15) {
    translate([0, 0, -eps]) intersection() {
        cylinder(d = d, h = depth + 2 * eps);
        translate([-d / 2, -d / 2 + (d - flat), 0]) cube([d, d, depth + 2 * eps]);
    }
}

// 28BYJ-48 face cut through thickness t (z 0..t): shaft/boss hole at the origin, body centre offset
// along +Y by ffm_shaft_off, ears along X through the body centre.
module ffm_cut(t) {
    translate([0, 0, -eps]) cylinder(d = ffm_boss_d + fit_hole, h = t + 2 * eps);
    for (s = [-1, 1]) translate([s * ffm_ear_pitch / 2, ffm_shaft_off, 0]) insert_hole("m4", extra = 0);
}
// Preview 28BYJ-48: face at z=0, shaft +Z, body below (offset +Y).
module ffm_body() {
    color("steelblue") translate([0, ffm_shaft_off, -ffm_body_l]) cylinder(d = ffm_body_d, h = ffm_body_l);
    color("steelblue") translate([0, ffm_shaft_off, -1]) hull() for (s = [-1, 1]) translate([s * ffm_ear_pitch / 2, 0, 0]) cylinder(d = ffm_ear_w, h = 1);
    color("gray") cylinder(d = ffm_boss_d, h = ffm_boss_h);
    color("gray") cylinder(d = ffm_shaft_d, h = ffm_shaft_l);
}
module ffm_d_bore(depth) { d_bore(depth, d = ffm_shaft_d + 0.25, flat = ffm_shaft_flat + 0.15); }

// 35 mm PM geared stepper (belt drive). Preview: flange face at z=0, shaft +Z (centred), can below.
module pm_body() {
    color("steelblue") translate([0, 0, -pm_body_l]) cylinder(d = pm_body_d, h = pm_body_l);
    color("steelblue") translate([0, 0, -pm_flange_t]) hull() for (s = [-1, 1]) translate([s * pm_ear_pitch / 2, 0, 0]) cylinder(d = pm_ear_w, h = pm_flange_t);
    color("gray") cylinder(d = pm_shaft_d, h = pm_pulley_gap);
}
// Its 20T 1.5GT pulley (preview): lips pm_pulley_lip_d, tooth tips at the belt-ring tip radius rule.
module pm_pulley() {
    tip_d = 2 * (pm_pulley_pr - belt_pld);
    color("silver") translate([0, 0, pm_pulley_gap]) {
        cylinder(d = tip_d, h = pm_pulley_w);
        for (z = [0, pm_pulley_w - 0.5]) translate([0, 0, z]) cylinder(d = pm_pulley_lip_d, h = 0.5);
    }
}
// 2D toothed rim of a printed 1.5GT pulley ring: N grooves, round-bottomed, width ff_groove_w, depth ff_groove_d.
module belt_rim_2d(N) {
    rt = belt_pr(N) - belt_pld;
    difference() {
        circle(r = rt, $fn = N * 2);
        for (i = [0 : N - 1]) rotate(i * 360 / N) translate([rt, 0]) hull() {
            translate([-(ff_groove_d - ff_groove_w / 2), 0]) circle(d = ff_groove_w, $fn = 16);
            translate([0.5, 0]) square([1, ff_groove_w], center = true);
        }
    }
}
// Open belt loop (preview / clearance): land only, belt_land thick just outside the tooth tips, around a ring of
// pitch radius R at the origin and a pulley of pitch radius r at distance C along +X.
// The 0.2 mm gap keeps faceted circles from registering as overlap with the ring and pulley previews.
module belt_loop_2d(R, r, C) difference() {
    hull() { circle(r = R - belt_pld + 0.2 + belt_land, $fn = 360); translate([C, 0]) circle(r = r - belt_pld + 0.2 + belt_land, $fn = 48); }
    hull() { circle(r = R - belt_pld + 0.2, $fn = 360); translate([C, 0]) circle(r = r - belt_pld + 0.2, $fn = 48); }
}

// 90-degree V race groove cutting tool, axis Z, in a face at z=face_z, apex below it by `depth`.
module race_groove(r, depth = groove_d, face_z = 0, clearance = 0.1) {
    w = depth + clearance;
    rotate_extrude($fn = 360)
        polygon([[r - w - eps, face_z + eps], [r + w + eps, face_z + eps], [r, face_z - depth - clearance * sqrt(2)]]);
}
// Preview balls on a race, centred at z.
module race_balls(r, z) { color("silver") for (i = [0 : n_balls - 1]) rotate(i * 360 / n_balls) translate([r, 0, z]) sphere(d = ball_d, $fn = 24); }
