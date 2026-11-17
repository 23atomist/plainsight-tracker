// upright.scad — fork upright. variant = "left" (tilt motor, pinion window, level stop) or "right".
// Axis frame; print placement puts the OUTER face on the bed (pure rotation, no mirror).
include <../lib/hardware.scad>
variant = "left";
z_foot = plat_top_z;

// 2D outline in XZ, relative to the pivot: tapered plate with a round top
module outline_2d(variant) {
    hull() {
        circle(r = upright_top_r, $fn = 90);
        translate([-upright_hw_bot, z_foot - pivot_z]) square([2 * upright_hw_bot, 1]);
    }
    if (variant == "left") hull() {   // rear ear for the level stop and homing switch
        translate([ear_x0 - pivot_x + 4, (ear_z0 + ear_z1) / 2 - pivot_z]) circle(r = (ear_z1 - ear_z0) / 2, $fn = 48);
        translate([-5, ear_z0 - pivot_z]) square([10, ear_z1 - ear_z0]);
    }
}
module plate(side, variant) {   // extruded along Y between the inner and outer faces
    translate([pivot_x, 0, pivot_z]) rotate([90, 0, 0])
        translate([0, 0, -max(side * upright_y0, side * upright_y1)]) linear_extrude(height = upright_t) outline_2d(variant);
}
module foot(side) {
    translate([pivot_x - upright_hw_bot, min(side * foot_y0, side * foot_y1), z_foot])
        cube([2 * upright_hw_bot, abs(foot_y1 - foot_y0), foot_t]);
}
module stop_boss() {
    translate([stop_x - stop_boss_x / 2, stop_boss_y0, stop_boss_z0])
        cube([stop_boss_x, upright_y0 - stop_boss_y0 + 1, stop_boss_z1 - stop_boss_z0]);
}
module upright(variant = variant) {
    side = variant == "left" ? 1 : -1;
    y_in = side * upright_y0;
    difference() {
        union() {
            plate(side, variant); foot(side);
            if (variant == "left") stop_boss();
        }
        // 608 pocket from the inner face, lip outside
        translate([pivot_x, y_in, pivot_z]) rotate([side > 0 ? 90 : -90, 0, 0]) bearing_pocket(b608, lip_hole = stub_d + 1.5);
        // foot screws: M4 counterbored from the foot top
        for (sx = [-1, 1], y = foot_bolt_y) translate([pivot_x + sx * foot_bolt_dx, side * y, z_foot + foot_t]) cbore(m4_d, m4_head_d, m4_head_h);
        if (variant == "left") {
            // pinion window + 4 slotted NEMA holes (slots radial = along Z), heads counterbored on the inner face
            translate([tilt_motor_xz[0], 0, tilt_motor_xz[1]]) rotate([90, 0, 0]) {
                translate([0, 0, -upright_y1 - 1]) cylinder(d = window_d, h = upright_t + 2);
                for (sx = [-1, 1], sz = [-1, 1]) translate([sx * motor_bolt_pitch / 2, -sz * motor_bolt_pitch / 2, -upright_y1 - 1]) {
                    slot(motor_bolt_d, tilt_slot_l, upright_t + 2, [0, 1]);
                    translate([0, 0, upright_t - m3_head_h + 1]) slot(m3_head_d, tilt_slot_l, m3_head_h + 1, [0, 1]);
                }
            }
            // level stop: M4 insert from the boss top, screw tip is the stop face
            translate([stop_x, stop_screw_y, stop_boss_z1]) insert_hole("m4", extra = stop_boss_z1 - stop_boss_z0 - m4_insert_h + 1);
            // homing switch: 2 x M2.5 self-tap through the plate, next to the boss
            for (x = switch_x) translate([x, 0, switch_z]) ycyl(switch_hole_d, upright_y0 - 1, upright_y1 + 1);
        }
    }
}
// print placement: outer face on the bed
if (variant == "left") translate([0, 0, upright_y1]) rotate([-90, 0, 0]) upright("left");
else                   translate([0, 0, upright_y1]) rotate([ 90, 0, 0]) upright("right");
