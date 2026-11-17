// deck.scad — fixed base plate: ball race ridge, centre cable tube, pan motor under it.
// Base frame; prints as modelled (underside on the bed).
include <../lib/hardware.scad>
module deck(v = "") {
    rad = [cos(pan_motor_angle), sin(pan_motor_angle)];
    difference() {
        union() {
            translate([0, 0, -deck_t]) cylinder(r = deck_r, h = deck_t, $fn = 360);
            cylinder(r = ridge_r1, h = ridge_h, $fn = 360);                     // race ridge (solid to the tube)
            cylinder(r = tube_r1, h = tube_z1, $fn = 180);                      // centre tube
        }
        translate([0, 0, -deck_t - 1]) cylinder(r = tube_r0, h = deck_t + tube_z1 + 2, $fn = 180);   // cable bore
        difference() { cylinder(r = ridge_r0, h = 50, $fn = 360); translate([0, 0, -1]) cylinder(r = tube_r1 - eps, h = 52, $fn = 180); }   // floor at z=0 inside the ridge
        race_groove(race_r, face_z = ridge_h);
        // pan motor: pinion/boss hole and 4 radial slots
        translate([pan_motor_xy[0], pan_motor_xy[1], -deck_t - 1]) cylinder(d = deck_pin_hole_d, h = deck_t + 2);
        for (sx = [-1, 1], sy = [-1, 1])
            translate([pan_motor_xy[0] + rad[0] * sx * motor_bolt_pitch / 2 - rad[1] * sy * motor_bolt_pitch / 2,
                       pan_motor_xy[1] + rad[1] * sx * motor_bolt_pitch / 2 + rad[0] * sy * motor_bolt_pitch / 2, -deck_t - 1])
                slot(motor_bolt_d, pan_slot_l, deck_t + 2, rad);
        // retainer inserts in the tube top
        for (i = [0 : ret_n - 1]) rotate(i * 360 / ret_n + 60) translate([(tube_r0 + tube_r1) / 2, 0, tube_z1]) insert_hole("m3", extra = 2);
        // housing screws: M4 counterbored from the top
        for (i = [0 : hous_n - 1]) rotate(i * 360 / hous_n) translate([hous_bolt_r, 0, 0]) cbore(m4_d, m4_head_d, m4_head_h);
    }
}
// print placement: underside on the bed
translate([0, 0, deck_t]) deck();
