// cradle_body.scad — camera shelf + spine + lens saddle block. Axis frame; prints bottom down.
include <../lib/hardware.scad>
module cradle_body(v = "") {
    difference() {
        union() {
            translate([saddle_x0, -saddle_hw, block_z0]) cube([saddle_x1 - saddle_x0, 2 * saddle_hw, ledge_z - block_z0]);   // saddle block
            translate([shelf_x0, -spine_hw, block_z0]) cube([saddle_x0 - shelf_x0 + eps, 2 * spine_hw, spine_z1 - block_z0]);  // spine
            translate([shelf_x0, -spine_hw, shelf_z1 - shelf_t]) cube([shelf_x1 - shelf_x0, 2 * spine_hw, shelf_t]);         // shelf
            for (s = [-1, 1]) translate([cam_x0, s > 0 ? cam_w / 2 + 0.5 : -spine_hw, shelf_z1]) cube([cam_body_l, spine_hw - cam_w / 2 - 0.5, 4]);  // side rails
        }
        xcyl(2 * saddle_r, saddle_x0 - 1, saddle_x1 + 1);                                                  // trough
        translate([saddle_x0 - 1, -relief_hw, relief_z]) cube([saddle_x1 - saddle_x0 + 2, 2 * relief_hw, 60]);   // relief above the contact arc
        // camera mount: two slotted M3 holes 9 mm apart, one driver access channel from below
        pitch_dir = cam_mount_axis == "y" ? [0, 1] : [1, 0];      // direction of the hole pair
        slot_dir  = cam_mount_axis == "y" ? [1, 0] : [0, 1];      // slots run across the pair
        chan_h = -block_z0 + shelf_z1 - shelf_t;                  // channel stops at the shelf underside
        for (sy = [-1, 1]) translate([cam_xc + cam_mount_x + pitch_dir[0] * sy * cam_mount_pitch / 2, pitch_dir[1] * sy * cam_mount_pitch / 2, block_z0 - 1])
            slot(cam_mount_hole_d, cam_mount_slot, 60, slot_dir);
        translate([cam_xc + cam_mount_x, 0, block_z0 - 1]) hull() for (sy = [-1, 1])
            translate([pitch_dir[0] * sy * cam_mount_pitch / 2, pitch_dir[1] * sy * cam_mount_pitch / 2, 0]) slot(9, cam_mount_slot, chan_h, slot_dir);
        if (cam_mount_center_d > 0) translate([cam_xc + cam_mount_x, 0, block_z0 - 1]) slot(cam_mount_center_d, cam_mount_slot, 60, slot_dir);
        // counterweight bar holes (M8 bolts or 8 mm rod) across the spine
        for (z = cw_z) translate([cw_x, 0, z]) ycyl(cw_hole_d, -spine_hw - 1, spine_hw + 1);
        // clamp cap: M3 inserts down into the ledges
        for (s = [-1, 1]) translate([clamp_screw_x, s * clamp_screw_y, ledge_z]) insert_hole("m3");
        // trunnion arms: M4 inserts into both sides
        for (s = [-1, 1], x = arm_bolt_x, z = arm_bolt_z) translate([x, s * saddle_hw, z]) rotate([s > 0 ? -90 : 90, 0, 0]) insert_hole("m4");
        // nose: M4 inserts into the front face
        for (y = nose_bolt_y, z = nose_bolt_z) translate([saddle_x1, y, z]) rotate([0, 90, 0]) insert_hole("m4");
        // cable tie slots in the shelf
        for (s = [-1, 1], x = [cam_x0 + 8, shelf_x1 - 10]) translate([x, s * (cam_w / 2 + 2.8), shelf_z1 - shelf_t - 1]) slot(3.2, 6, shelf_t + 6, [1, 0]);
    }
}
translate([0, 0, -block_z0]) cradle_body();
