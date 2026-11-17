// housing.scad — tube under the deck for the pan motor and driver. Base frame; prints standing.
include <../lib/hardware.scad>
module housing(v = "") {
    z0 = -deck_t - hous_h;
    difference() {
        union() {
            translate([0, 0, z0]) cylinder(r = hous_r, h = hous_h, $fn = 360);
            // feet
            for (i = [0 : feet_n - 1]) rotate(i * 360 / feet_n + 45) translate([hous_r - 2, -10, z0]) cube([14, 20, 6]);
        }
        translate([0, 0, z0 - 1]) cylinder(r = hous_r - hous_wall, h = hous_h + 2, $fn = 360);
        for (i = [0 : feet_n - 1]) rotate(i * 360 / feet_n + 45) translate([hous_r + 6, 0, z0 - 1]) slot(foot_slot, 4, 8, [1, 0]);
        // cable slot at the rear (pan motor side)
        rotate(pan_motor_angle) translate([hous_r - hous_wall - 1, -cable_slot[0] / 2, z0 - 1]) cube([hous_wall + 2, cable_slot[0], cable_slot[1] + 1]);
    }
    // rim tabs with M4 inserts, top flush with the deck underside
    for (i = [0 : hous_n - 1]) rotate(i * 360 / hous_n) difference() {
        translate([hous_r - hous_wall - hous_tab[1] + 0.5, -hous_tab[0] / 2, -deck_t - hous_tab[2]]) cube([hous_tab[1] + 0.5, hous_tab[0], hous_tab[2]]);
        translate([hous_bolt_r, 0, -deck_t]) insert_hole("m4");
    }
}
// print placement: open bottom on the bed
translate([0, 0, deck_t + hous_h]) housing();
