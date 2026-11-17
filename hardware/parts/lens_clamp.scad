// lens_clamp.scad — cap over the lens barrel with the IMU pad on top. Axis frame; printed pad down.
include <../lib/hardware.scad>
leg_y0 = relief_hw; leg_y1 = clamp_screw_y + m3_head_d / 2 + 0.4;   // 44 .. 51.5
bar_z0 = 26; bar_z1 = 33; leg_z1 = bar_z1;
cap_r1 = saddle_r + clamp_t;
module profile_2d() {   // in (Y, Z)
    difference() {
        union() {
            intersection() { circle(r = cap_r1, $fn = 240); translate([-cap_r1, bar_z0]) square([2 * cap_r1, cap_r1]); }   // band, +/-47 deg, clear of the switch panel
            translate([-leg_y1, bar_z0]) square([2 * leg_y1, bar_z1 - bar_z0]);                                      // bar over the panel zone
            for (s = [-1, 1]) translate([s > 0 ? leg_y0 : -leg_y1, ledge_z]) square([leg_y1 - leg_y0, leg_z1 - ledge_z]);   // legs
        }
        circle(r = saddle_r, $fn = 240);
    }
}
module lens_clamp(v = "") {
    difference() {
        union() {
            translate([clamp_x0, 0, 0]) rotate([90, 0, 90]) linear_extrude(height = clamp_x1 - clamp_x0, convexity = 6) profile_2d();
            translate([imu_pad_xc - imu_pad[0] / 2, -imu_pad[1] / 2, cap_r1 - 0.5]) cube([imu_pad[0], imu_pad[1], imu_pad[2] + 0.5]);
        }
        // shoulder screws: M3 x 16 from the leg top, deep counterbore for the driver
        for (s = [-1, 1]) translate([clamp_screw_x, s * clamp_screw_y, leg_z1]) {
            translate([0, 0, -(leg_z1 - ledge_z) - 1]) cylinder(d = m3_d, h = leg_z1 - ledge_z + 2);
            translate([0, 0, -(leg_z1 - ledge_z) + 16 - 1]) cylinder(d = m3_cs_d + 0.5, h = 60);
        }
        // IMU grid: self-tap M2.5 holes
        n = floor((imu_pad[0] - 6) / imu_grid);
        m = floor((imu_pad[1] - 6) / imu_grid);
        for (i = [0 : n], j = [0 : m]) translate([imu_pad_xc - n * imu_grid / 2 + i * imu_grid, -m * imu_grid / 2 + j * imu_grid, cap_r1 + imu_pad[2]]) zcyl(imu_hole_d, -6, 1);
        // cable tie slot through the pad edge
        translate([imu_pad_xc, 0, 0]) for (s = [-1, 1]) translate([s * (imu_pad[0] / 2 - 4), 0, cap_r1 + imu_pad[2] - 2]) slot(3.2, 14, 6, [0, 1]);
    }
}
translate([0, 0, cap_r1 + imu_pad[2]]) rotate([180, 0, 0]) lens_clamp();
