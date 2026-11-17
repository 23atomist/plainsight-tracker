// tray_foot.scad — puck under each corner of the controller tray (4 needed): lifts the tray off the
// ground and recesses the M4 head. Printed as modelled, counterbore on the bed.
include <../lib/hardware.scad>
module tray_foot(v = "") difference() {
    cylinder(d = tray_pad_d, h = tray_pad_h, $fn = 48);
    rotate([180, 0, 0]) cbore(m4_d, m4_head_d + 0.4, m4_head_h + 0.5);   // head pocket from the bottom, bolt up through
}
tray_foot();
