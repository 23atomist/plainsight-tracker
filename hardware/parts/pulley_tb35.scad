// pulley_tb35.scad — 20T GT2 pulley (6 mm belt) for the 35 mm PM geared stepper (TB35-4-10.5): 4 mm shaft with a
// flat (3 mm across the flat). Prints as modelled: flat flange on the bed, 45 deg flange up; the 45 deg flange's
// face goes toward the motor. D bore through: push it on flat to flat with two layers of paper between it and the
// boss round the shaft (so it can't rub), pull the paper, a drop of CA on the flat.
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
