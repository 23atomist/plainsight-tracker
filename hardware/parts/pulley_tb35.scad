// pulley_tb35.scad — 20T GT2 pulley (6 mm belt) for the 35 mm PM geared stepper (TB35-4-10.5): 4 mm shaft with a
// flat (3 mm across the flat). The thin hub goes toward the motor: it turns inside the wire box on the motor face
// and lifts the flanges above it. Prints as modelled: flat flange on the bed, hub up, no supports.
// D bore through: push it on until the hub meets the boss round the shaft, flat to flat, a drop of CA on the flat.
include <../lib/hardware.scad>
module pulley_tb35() difference() {
    union() {
        belt_band(pm_pulley_N, pm_lip);                                  // flat flange (bed), band, 45 deg flange
        h0 = ff_flange_t + ff_tooth_w + pm_lip;
        translate([0, 0, h0 - eps]) cylinder(d = pm_hub_d, h = pm_pulley_body_z - pm_pulley_gap + eps, $fn = 48);
    }
    translate([0, 0, -1]) linear_extrude(height = pm_pulley_w + 2) d_bore_2d();
}
module d_bore_2d() {
    r = (pm_shaft_d + pm_bore_fit) / 2;
    flat = pm_shaft_flat + pm_bore_fit / 2 - r;     // flat's distance from the centre
    intersection() { circle(r = r, $fn = 48); translate([-r, -r]) square([r + flat, 2 * r]); }
}
pulley_tb35();
