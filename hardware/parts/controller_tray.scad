// controller_tray.scad — optional add-on: flat tray bolted under the housing's four feet, carrying a
// BTT SKR Pico V1.0 and an Orange Pi Zero 2W on printed standoffs (M2.5 self-tap). The boards sit
// inside the housing cavity, either side of the pan motor; the SKR is turned 45 deg so its USB-C end
// points into the cavity instead of at the wall. Stands on four separate tray_foot pucks. Base
// frame; prints flat on the bed, standoffs up, no supports.
include <../lib/hardware.scad>
use <tray_foot.scad>

module tray_plate_2d() {
    intersection() {
        translate([-tray_w / 2, tray_y0]) offset(r = tray_r) offset(delta = -tray_r) square([tray_w, tray_y1 - tray_y0]);
        circle(r = hous_r, $fn = 360);
    }
    // arms from the plate corners to the pads under the housing feet
    for (sx = [-1, 1], sy = [-1, 1]) hull() {
        translate([sx * tray_foot_xy, sy * tray_foot_xy]) circle(d = tray_pad_d, $fn = 48);
        translate([sx * tray_arm_x, sy > 0 ? tray_y1 - tray_r : tray_y0 + tray_r]) circle(d = tray_pad_d, $fn = 48);
    }
}
// board frame: origin at the board centre, +X along the board's long axis (u), rotated by ang about Z
module board_frame(xy, ang) translate([xy[0], xy[1], 0]) rotate(ang) children();
// children at the four mounting holes of a board (hole pitch, pattern offset from the centre), board frame
module board_holes(holes, off) { for (sx = [-1, 1], sy = [-1, 1]) translate([off[0] + sx * holes[0] / 2, off[1] + sy * holes[1] / 2, 0]) children(); }
module tray_vents(ys, l) { for (y = ys) translate([0, y, 0]) slot(tray_vent_w, l, tray_t, [1, 0]); }
module standoffs(holes, off) board_holes(holes, off) translate([0, 0, tray_z1 - eps]) cylinder(d = tray_so_d, h = tray_so_h + eps, $fn = 36);
module pilots(holes, off)    board_holes(holes, off) translate([0, 0, tray_z1 - tray_t - 1]) cylinder(d = tray_so_pilot, h = tray_t + tray_so_h + 2, $fn = 24);

module controller_tray(v = "") {
    z0 = tray_z1 - tray_t;
    difference() {
        union() {
            translate([0, 0, z0]) linear_extrude(tray_t) tray_plate_2d();
            board_frame(skr_xy, skr_angle) standoffs(skr_holes, skr_hole_off);
            board_frame(opi_xy, opi_angle) standoffs(opi_holes, opi_hole_off);
        }
        // M4 up through the foot puck, the plate and the housing foot slot
        for (sx = [-1, 1], sy = [-1, 1]) translate([sx * tray_foot_xy, sy * tray_foot_xy, z0 - 1]) cylinder(d = m4_d, h = tray_t + 2);
        // standoff pilots (M2.5 self-tapping), through the plate
        board_frame(skr_xy, skr_angle) pilots(skr_holes, skr_hole_off);
        board_frame(opi_xy, opi_angle) pilots(opi_holes, opi_hole_off);
        // vent slots under the boards, along each board's long axis
        translate([0, 0, z0]) { board_frame(skr_xy, skr_angle) tray_vents(skr_vent_ys, skr_vent_l); board_frame(opi_xy, opi_angle) tray_vents(opi_vent_ys, opi_vent_l); }
    }
}
// The four pucks under the plate corners (separate prints), in the base frame.
module tray_feet() { for (sx = [-1, 1], sy = [-1, 1]) translate([sx * tray_foot_xy, sy * tray_foot_xy, tray_z1 - tray_t - tray_pad_h]) tray_foot(); }
// Preview boards (not printed): PCB slab plus a translucent component envelope on the standoffs, and the
// USB-C plug bodies, so the clearance sweep checks plug room against the housing and the motor.
module tray_board(size, plug_xy, plug_sz) translate([0, 0, tray_z1 + tray_so_h]) {
    color("darkgreen") translate([-size[0] / 2, -size[1] / 2, 0]) cube([size[0], size[1], tray_pcb_t]);
    color("darkgreen", 0.25) translate([-size[0] / 2, -size[1] / 2, tray_pcb_t]) cube([size[0], size[1], tray_comp_h]);
    color("dimgray", 0.5) translate([plug_xy[0] - plug_sz[0] / 2, plug_xy[1] - plug_sz[1] / 2, tray_pcb_t]) cube([plug_sz[0], plug_sz[1], 7]);
}
module tray_boards() {
    board_frame(skr_xy, skr_angle) tray_board(skr_size, skr_plug, [tray_plug_l, tray_plug_w]);
    board_frame(opi_xy, opi_angle) tray_board(opi_size, opi_plug, [opi_size[0], tray_plug_l]);
}
// print placement: plate on the bed, standoffs up
translate([0, 0, -(tray_z1 - tray_t)]) controller_tray();
