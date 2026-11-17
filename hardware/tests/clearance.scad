// tests/clearance.scad — intersection of two named items (see assembly.scad item()).
// -D a="payload" -D b="upright_left" -D tilt=45 -D ring_rot=0
use <../assembly.scad>
a = "payload"; b = "upright_left"; tilt = 0; ring_rot = 0;
intersection() { item(a, tilt, ring_rot); item(b, tilt, ring_rot); }
