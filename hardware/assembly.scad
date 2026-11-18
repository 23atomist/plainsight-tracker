// assembly.scad — the whole head. -D tilt_angle=.. -D pan_angle=.. -D show_bodies=false -D show_base=false
include <lib/hardware.scad>
use <lib/gears.scad>
use <parts/cradle_body.scad>
use <parts/lens_clamp.scad>
use <parts/trunnion_arm.scad>
use <parts/nose.scad>
use <parts/spacer.scad>
use <parts/ring_gear.scad>
use <parts/pinion_28byj.scad>
use <parts/pinion_nema.scad>
use <parts/upright.scad>
use <parts/platform.scad>
use <parts/deck.scad>
use <parts/housing.scad>
use <parts/retainer.scad>
use <parts/controller_tray.scad>
use <parts/tripod_spider.scad>
tilt_angle = 0; pan_angle = 0; ring_rot = 0;
show_bodies = true; show_base = true; show_tray = true; show_tripod = true;   // optional controller tray / tripod spider (the spider replaces the tray_foot pucks)

module tilt_xf(t = tilt_angle) { translate([pivot_x, 0, pivot_z]) rotate([0, -t, 0]) translate([-pivot_x, 0, -pivot_z]) children(); }
module pan_xf(p = pan_angle)  { translate([pivot_x, 0, 0]) rotate([0, 0, p]) translate([-pivot_x, 0, 0]) children(); }
module base_xf() { translate([pivot_x, 0, base_z_in_axis]) children(); }

// ---- preview bodies (not printed) -------------------------------------------------------
module camera_body() { color("dimgray") { translate([cam_x0, -cam_w / 2, -cam_h / 2]) cube([cam_body_l, cam_w, cam_h]); xcyl(cam_boss_d, 0, cam_boss_l); } }
module adapter_body() { color("gray") xcyl(adapter_d, cam_boss_l, lens_flange_x); }
module lens_body() { color("black") {
    xcyl(lens_rear_barrel_d, lens_flange_x, focus_gear_x0);
    xcyl(focus_ring_od, focus_gear_x0, focus_gear_x1);
    xcyl(lens_rear_barrel_d, focus_gear_x1, zoom_gear_x0 - (zoom_ring_w - ff_ring_w) / 2);
    xcyl(zoom_ring_od, zoom_ring_x - zoom_ring_w / 2, zoom_ring_x + zoom_ring_w / 2);
    xcyl(lens_d, zoom_ring_x + zoom_ring_w / 2, lens_front_x);
} }
// AF/VR switch panel: wedge on the +Y (left) side between 30 deg below and 30 deg above horizontal
module switch_panel() { color("black") translate([switch_panel_x0, 0, 0]) rotate([90, 0, 90])
    linear_extrude(switch_panel_x1 - switch_panel_x0) intersection() {
        circle(r = lens_rear_barrel_d / 2 + switch_panel_protrude, $fn = 120);
        polygon([[0, 0], [60 * cos(30), 60 * sin(30)], [60 * cos(-30), 60 * sin(-30)]]);   // (Y, Z)
    }
}
module stubs() { color("silver") for (s = [-1, 1]) translate([pivot_x, 0, pivot_z]) ycyl(stub_d + stub_fit, s > 0 ? arm_y0 - 2 : -(arm_y0 - 2 + stub_l), s > 0 ? arm_y0 - 2 + stub_l : -(arm_y0 - 2)); }
module ff_motors() {
    if (ff_belt) {   // flange on the plate's rear face, can forward, shaft rearward to the belt plane; ears tangential
        translate([focus_plate_x0 - pm_flange_t, focus_pin_yz[0], focus_pin_yz[1]]) rotate([ff_focus_angle, 0, 0]) rotate([0, -90, 0]) pm_body();
        translate([zoom_plate_x0 - pm_flange_t,  zoom_pin_yz[0],  zoom_pin_yz[1]])  rotate([180 - ff_zoom_angle, 0, 0]) rotate([0, -90, 0]) pm_body();
    } else {
        translate([focus_plate_x1, focus_pin_yz[0], focus_pin_yz[1]]) rotate([ff_focus_angle, 0, 0]) rotate([0, -90, 0]) ffm_body();        // body forward
        translate([zoom_plate_x0,  zoom_pin_yz[0],  zoom_pin_yz[1]])  rotate([180 - ff_zoom_angle, 0, 0]) rotate([0, 90, 0]) ffm_body();   // body rearward
    }
}
// pinions turn with their ring gears in the sweep (opposite sense)
module ff_pinions(rr = ring_rot) if (ff_belt) ff_belts(); else {
    translate([focus_plate_x0, focus_pin_yz[0], focus_pin_yz[1]]) rotate([0, -90, 0]) rotate([0, 0, focus_pin_phase - rr * focus_gear_N / ff_pin_N]) pinion_28byj();
    translate([zoom_plate_x1,  zoom_pin_yz[0],  zoom_pin_yz[1]])  rotate([0,  90, 0]) rotate([0, 0, zoom_pin_phase - rr * zoom_gear_N / ff_pin_N]) pinion_28byj();
}
// belt drive: motor pulleys + belt loops (land only) in the belt planes
module ff_belts() {
    for (f = [[focus_belt_x, focus_pin_yz, focus_gear_pr, focus_cd, ff_focus_angle],
              [zoom_belt_x,  zoom_pin_yz,  zoom_gear_pr,  zoom_cd,  180 - ff_zoom_angle]]) {
        translate([f[0] + pm_pulley_z, f[1][0], f[1][1]]) rotate([0, -90, 0]) pm_pulley();
        color("dimgray") translate([f[0] - belt_w / 2, 0, 0]) rotate([90, 0, 90]) linear_extrude(height = belt_w)
            rotate(f[4]) belt_loop_2d(f[2], pm_pulley_pr, f[3]);
    }
}
module ring_gears(rr = ring_rot) {
    translate([focus_gear_x1, 0, 0]) rotate([0, -90, 0]) rotate([0, 0, rr + focus_ring_phase]) { ring_half("focus"); rotate(180) ring_half("focus"); }
    translate([zoom_gear_x0, 0, 0])  rotate([0,  90, 0]) rotate([0, 0, rr + zoom_ring_phase])  { ring_half("zoom");  rotate(180) ring_half("zoom"); }
}
module spacers() { for (s = [-1, 1]) translate([pivot_x, s > 0 ? arm_y1 : -arm_y1 - spacer_t, pivot_z]) rotate([-90, 0, 0]) spacer(); }
module tilt_motor() { translate([tilt_motor_xz[0], upright_y1, tilt_motor_xz[1]]) rotate([90, 0, 0]) nema17_body(); }
module tilt_pinion(t = tilt_angle) { translate([tilt_motor_xz[0], upright_y1 - motor_boss_h, tilt_motor_xz[1]]) rotate([90, 0, 0]) rotate([0, 0, tilt_pin_phase - t * tilt_ratio]) pinion_nema(); }
module stop_screw() { color("silver") translate([stop_x, stop_screw_y, 0]) zcyl(3.3, stop_contact_z, stop_boss_z1); }   // minor diameter: it self-taps below the insert
// nose bolts (M4 x 40 from the keel front) and the straight hex-key path in front of each head
module nose_bolts() color("silver") for (y = nose_bolt_y, z = nose_bolt_z) translate([0, y, z]) {
    xcyl(4, nose_bolt_tip_x, nose_bolt_seat_x); xcyl(m4_shc_d, nose_bolt_seat_x, nose_bolt_seat_x + m4_shc_h);
}
module nose_bolt_access() for (y = nose_bolt_y, z = nose_bolt_z) translate([0, y, z]) xcyl(m4_shc_d + 1, nose_bolt_seat_x + m4_shc_h, nose_bolt_seat_x + 60);
module pan_motor() { translate([pan_motor_xy[0], pan_motor_xy[1], -deck_t]) nema17_body(); }
module pan_pinion() { translate([pan_motor_xy[0], pan_motor_xy[1], -deck_t + motor_boss_h]) pinion_nema(); }

// ---- groups --------------------------------------------------------------------------------
module payload_printed(rr = ring_rot) { color("tan") cradle_body(); color("tan") lens_clamp(); color("orange") arm("left"); color("orange") arm("right"); color("tan") nose(); spacers(); color("gold") ring_gears(rr); color("gold") ff_pinions(rr); }
module payload_bodies()  { camera_body(); adapter_body(); lens_body(); switch_panel(); stubs(); ff_motors(); }
module fork_printed()    { color("steelblue") upright("left"); color("steelblue") upright("right"); color("gold") tilt_pinion(); }
module fork_bodies()     { tilt_motor(); stop_screw(); }
module base_printed()    { color("slategray") deck(); color("slategray") housing(); translate([0, 0, tube_z1]) color("slategray") retainer(); color("gold") pan_pinion(); if (show_tray) color("darkolivegreen") { controller_tray(); if (!show_tripod) tray_feet(); } if (show_tripod) color("olive") tripod_spider(); }
module base_bodies()     { pan_motor(); race_balls(race_r, ball_z); if (show_tray) tray_boards(); if (show_tripod) tripod_head(); }

if (show_base) base_xf() { base_printed(); if (show_bodies) base_bodies(); }
pan_xf() {
    base_xf() rotate([0, 0, 0]) color("lightsteelblue") platform();
    fork_printed(); if (show_bodies) fork_bodies();
    tilt_xf() { payload_printed(); if (show_bodies) payload_bodies(); }
}

// ---- named items for tests/clearance.scad: item(name, tilt, ring_rot) ----------------------------
module item(n, t = 0, rr = 0) {
    // moving with tilt
    if (n == "payload")      tilt_xf(t) { payload_printed(rr); payload_bodies(); }
    else if (n == "cradle")  tilt_xf(t) cradle_body();
    else if (n == "clamp")   tilt_xf(t) lens_clamp();
    else if (n == "arm_left")  tilt_xf(t) arm("left");
    else if (n == "arm_right") tilt_xf(t) arm("right");
    else if (n == "nose")    tilt_xf(t) nose();
    else if (n == "lens")    tilt_xf(t) lens_body();
    else if (n == "panel")   tilt_xf(t) switch_panel();
    else if (n == "camera")  tilt_xf(t) camera_body();
    else if (n == "adapter") tilt_xf(t) adapter_body();
    else if (n == "ff_motors")  tilt_xf(t) ff_motors();
    else if (n == "ff_pinions") tilt_xf(t) ff_pinions(rr);
    else if (n == "ring_gears") tilt_xf(t) ring_gears(rr);
    else if (n == "stubs")   tilt_xf(t) stubs();
    else if (n == "spacers") tilt_xf(t) spacers();
    else if (n == "nose_bolts")       tilt_xf(t) nose_bolts();
    else if (n == "nose_bolt_access") tilt_xf(t) nose_bolt_access();
    // fixed to the platform
    else if (n == "upright_left")  upright("left");
    else if (n == "upright_right") upright("right");
    else if (n == "tilt_motor")  tilt_motor();
    else if (n == "tilt_pinion") tilt_pinion(t);
    else if (n == "stop_screw")  stop_screw();
    else if (n == "platform")    base_xf() platform();
    // base
    else if (n == "deck")       base_xf() deck();
    else if (n == "housing")    base_xf() housing();
    else if (n == "retainer")   base_xf() translate([0, 0, tube_z1]) retainer();
    else if (n == "balls")      base_xf() race_balls(race_r, ball_z);
    else if (n == "pan_motor")  base_xf() pan_motor();
    else if (n == "pan_pinion") base_xf() pan_pinion();
    else if (n == "tray")       base_xf() { controller_tray(); if (!show_tripod) tray_feet(); }
    else if (n == "tripod")     base_xf() tripod_spider();
    else if (n == "tripod_head") base_xf() tripod_head();
    else if (n == "boards")     base_xf() tray_boards();
    else assert(false, str("unknown item ", n));
}
