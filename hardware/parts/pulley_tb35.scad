// pulley_tb35.scad — 20T GT2 pulley for the 35 mm PM geared stepper (TB35-4-10.5): 4 mm shaft with a flat
// (3 mm across the flat). Flat flange on the bed, which goes toward the motor; 45 deg flange on top.
// D bore through: push it on snug, flat to flat, with a drop of CA. Prints as modelled, no supports.
include <../lib/hardware.scad>
module pulley_tb35() difference() {
    belt_band(pm_pulley_N, pm_lip);
    translate([0, 0, -1]) linear_extrude(height = pm_pulley_w + 2) d_bore_2d();
}
module d_bore_2d() {
    r = (pm_shaft_d + pm_bore_fit) / 2;
    flat = pm_shaft_flat + pm_bore_fit / 2 - r;     // flat's distance from the centre
    intersection() { circle(r = r, $fn = 48); translate([-r, -r]) square([r + flat, 2 * r]); }
}
pulley_tb35();
