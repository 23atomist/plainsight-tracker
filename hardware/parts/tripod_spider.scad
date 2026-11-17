// tripod_spider.scad — optional add-on: one flat plate that puts the head on a Celestron NexStar SE /
// Evolution tripod. Replaces the four tray_foot pucks: the housing feet (and the controller tray) bolt
// down onto four bosses, and the tripod's three captive 3/8-16 thumbscrews thread up into hex nuts
// dropped into pockets on the top face. Base frame; prints flat on the bed, bosses up, no supports.
include <../lib/hardware.scad>

module tripod_plate_2d() {
    difference() { circle(r = tripod_r1, $fn = 360); circle(r = tripod_r0, $fn = 120); }
    for (a = tripod_bolt_a) translate(tripod_bolt_xy(a)) circle(d = tripod_nut_boss_d, $fn = 60);
    // arms from the rim out to the bosses under the housing feet
    for (sx = [-1, 1], sy = [-1, 1]) hull() {
        translate([sx * tray_foot_xy, sy * tray_foot_xy]) circle(d = tray_pad_d, $fn = 48);
        translate([sx, sy] * (tripod_r1 - tray_pad_d / 2) * cos(45)) circle(d = tray_pad_d, $fn = 48);
    }
}
module at_feet() { for (sx = [-1, 1], sy = [-1, 1]) translate([sx * tray_foot_xy, sy * tray_foot_xy, 0]) children(); }
module at_bolts() { for (a = tripod_bolt_a) translate(tripod_bolt_xy(a)) children(); }

module tripod_spider(v = "") difference() {
    union() {
        translate([0, 0, tripod_z0]) linear_extrude(tripod_t) tripod_plate_2d();
        at_feet()  translate([0, 0, tripod_z1 - eps]) cylinder(d = tray_pad_d, h = tripod_boss_h + eps, $fn = 48);
        at_bolts() translate([0, 0, tripod_z1 - eps]) cylinder(d = tripod_nut_boss_d, h = tripod_nut_z1 - tripod_z1 + eps, $fn = 60);
        // pads under the nut bosses fill the shallow recess around each thumbscrew: the plate seats on three pads
        at_bolts() translate([0, 0, tripod_pad_z0]) cylinder(d = tripod_pad_d, h = tripod_recess_d + eps, $fn = 48);
    }
    // M4 up through each foot boss, head pocket from the bottom (3.5 mm of plastic left above the head)
    at_feet() translate([0, 0, tripod_z0]) rotate([180, 0, 0]) cbore(m4_d, m4_head_d + 0.4, tripod_t + tripod_boss_h - 3.5);
    // thumbscrew clearance through the floor, hex nut pocket open at the top
    at_bolts() {
        translate([0, 0, tripod_pad_z0 - 1]) cylinder(d = tripod_screw_d, h = tripod_recess_d + tripod_t + 20);
        translate([0, 0, tripod_nut_z0]) cylinder(d = tripod_nut_pocket_d, h = 30, $fn = 6);
    }
}
// Preview tripod head (not printed): flat top under the plate with a shallow recess around each thumbscrew
// (the spider's pads sit in them), alignment pin on the flat, thumbscrew threads standing up from the recess floors.
module tripod_head() {
    color("dimgray") difference() {
        translate([0, 0, tripod_z0 - tripod_head_t]) cylinder(r = tripod_head_r, h = tripod_head_t, $fn = 120);
        for (a = tripod_bolt_a) rotate(a) translate([tripod_bolt_r - tripod_recess_in, -tripod_recess_w / 2, tripod_pad_z0]) cube([tripod_head_r, tripod_recess_w, tripod_recess_d + 1]);
    }
    color("silver") translate([0, 0, tripod_z0 - eps]) cylinder(d = tripod_pin_d, h = tripod_pin_h + eps, $fn = 36);
    color("silver") at_bolts() translate([0, 0, tripod_pad_z0 - eps]) cylinder(d = tripod_screw_d - 1, h = tripod_screw_up + eps, $fn = 36);
}
// print placement: pads on the bed, bosses up
translate([0, 0, -tripod_pad_z0]) tripod_spider();
