// ============================================================================
// config.scad — every dimension of the-pan-v4 lives here.
//
// Axis frame (assembly): origin = optical axis at the camera case front face.
//   +X forward (lens), +Y camera-left (viewed from behind), +Z up.
// Base frame (turntable parts): pan axis = Z, deck floor top = 0.
//   axis = base + [pivot_x, 0, base_z_in_axis]
// Units mm. Lines marked MEASURE are assumptions to check on the bench.
// ============================================================================

// ---------- print / fit tolerances --------------------------------------------
fit_hole      = 0.3;    // added to clearance holes
fit_bearing   = 0.25;   // added to bearing pocket diameters (light press fit)
fit_slide     = 0.4;    // sliding clearances (retainer, lips)
gear_backlash = 0.15;   // tooth thinning at the pitch line
cd_extra      = 0.15;   // extra centre distance on gear pairs
$fa = 2; $fs = 0.5;

// ---------- camera module (IFWATER IF-USB16MP01-MFV) ------------------------------
cam_w        = 50;      // Y
cam_h        = 50;      // Z                                              MEASURE
cam_body_l   = 47;      // X, case only
cam_boss_l   = 5;       // thread boss in front of the case (inside the adapter)
cam_boss_d   = 30;      // preview only                                    MEASURE
cam_x0       = -cam_body_l;
cam_xc       = -cam_body_l / 2;
cam_mount_pitch    = 9;     // the two M3 holes on the underside are 9 mm apart (centre to centre)
cam_mount_axis     = "y";   // "y": holes side by side, slots run fore/aft; "x": holes in line, slots run across
cam_mount_x        = 0;     // shift of the hole pair from the case centre along X, if it is not centred   MEASURE
cam_mount_hole_d   = 3.4;
cam_mount_center_d = 0;     // 1/4-20 clearance slot between the pair; 0 = none (it would cut into 9 mm slots)
cam_mount_slot     = 8;     // slot length (adjustment travel)

// ---------- adapter and lens (Nikon AF-S 70-300 f/4.5-5.6G VR) ----------------------
adapter_l          = 30;    // camera front face -> lens flange
adapter_d          = 64;    // preview                                      MEASURE
lens_d             = 80;    // max diameter
lens_len           = 143.5; // flange -> front, retracted
lens_rear_barrel_d = 76;    // under the saddle                             MEASURE
lens_flange_x      = adapter_l;
lens_front_x       = adapter_l + lens_len;
focus_ring_x  = 75;  focus_ring_w = 12;  focus_ring_od = 74;   // MEASURE (names as given)
zoom_ring_x   = 100; zoom_ring_w  = 28;  zoom_ring_od  = 79;   // MEASURE
switch_panel_x0 = 35; switch_panel_x1 = 69;   // AF/VR switch panel, left side 8..10 o'clock  MEASURE
switch_panel_protrude = 4;

// ---------- hardware --------------------------------------------------------------
b608 = [8, 22, 7];                 // tilt trunnion bearings
stub_d = 8; stub_fit = -0.1;       // steel rod stubs, press fit in the arms
m3_d = 3.4; m3_head_d = 6.2; m3_head_h = 3.2; m3_cs_d = 6.5;
m4_d = 4.4; m4_head_d = 7.4; m4_head_h = 4.2;
m5_d = 5.4;
m3_insert_d = 4.0; m3_insert_h = 6;    // M3 x 5.7 heat-set (4.6 knurl)   MEASURE
m4_insert_d = 5.6; m4_insert_h = 7;    // M4 x 6 heat-set                 MEASURE
m5_insert_d = 6.4; m5_insert_h = 8;
insert_extra = 3;                      // extra depth under an insert for the screw tip
// NEMA 17
motor_w = 42.3; motor_l = 40; motor_bolt_pitch = 31; motor_bolt_d = 3.4;
motor_boss_d = 22.3; motor_boss_h = 2; motor_shaft_d = 5; motor_shaft_flat = 4.5; motor_shaft_l = 22;
// 28BYJ-48
ffm_body_d = 28.5; ffm_body_l = 19.5; ffm_shaft_off = 8; ffm_ear_pitch = 35; ffm_ear_hole = 4.2;
ffm_ear_w = 7; ffm_boss_d = 9.6; ffm_boss_h = 1.5; ffm_shaft_d = 5; ffm_shaft_flat = 3; ffm_shaft_l = 10;
ffm_flat_l = 6;                        // length of the flatted part of the shaft
// balls for the pan race
ball_d = 6;                            // 6 mm steel balls or airsoft BBs
ball_r = ball_d / 2;

// ---------- gearing ---------------------------------------------------------------
gm   = 1.25;                           // module: tilt sector, pan ring, NEMA pinion
gpa  = 20;
pin_N = 12;                            // NEMA pinion (same part for pan and tilt)
pin_pr = gm * pin_N / 2;               // 7.5
pin_face = 8;
pin_hub_d = 17; pin_hub_l = 9;
tilt_N = 120;                          // sector gear: full-circle tooth count
tilt_pr = gm * tilt_N / 2;             // 75
tilt_cd = tilt_pr + pin_pr + cd_extra; // 82.65
tilt_ratio = tilt_N / pin_N;           // 10
sector_span = 114;                     // deg of teeth (90 travel + margins)
sector_a0 = -190 + (110 - sector_span) / 2;   // start angle at tilt 0 (deg from +X toward +Z)
sector_a1 = sector_a0 + sector_span;          // -78 at 114 span
pan_N  = 76;                           // internal ring gear
pan_pr = gm * pan_N / 2;               // 47.5
pan_motor_r = pan_pr - pin_pr - cd_extra;     // pinion axis radius: 39.85
pan_ratio = pan_N / pin_N;             // 6.33
pan_gear_face = 9;
pan_skirt_r1 = pan_pr + 1.25 * gm + 4;  // skirt outer radius 53.06
// follow focus. ff_drive picks the motors and the transmission:
//   "belt": two 35 mm PM geared steppers (12 V, 60 ohm, 22.3:1, centred 5 mm D shaft, M4 ears 42.5 mm apart)
//           with printed 20T GT2 pulleys drive printed GT2 belt rings clamped on the lens through stock
//           2GT-350-6 belts. Motors sit above the lens, bodies forward; the bracket plates are slotted to tension the belts.
//   "gear": 28BYJ-48 (5 V, bipolar-modded) with printed 24T m1 pinions on m1 ring gears, motors beside the lens.
//   "nema": FOCUS ONLY (zoom stays manual): one NEMA 17 pancake stepper (~20-25 mm body) with a stock metal 20T GT2
//           pulley (5 mm bore, 6 mm belt) drives the same GT2 focus ring through the same 2GT-350-6 belt. The motor
//           face bolts to the front of a slotted plate (4 x M3), body forward, shaft back through the plate.
ff_drive = "nema";
ff_belt = ff_drive != "gear";           // GT2 belt transmission (TB35 or NEMA)
ff_pm   = ff_drive == "belt";           // TB35 35 mm PM geared steppers
ff_nema = ff_drive == "nema";           // NEMA 17 pancake, focus only
ff_zoom = !ff_nema;                     // a zoom motor is fitted
ff_m = 1; ff_pin_N = 24; ff_pin_pr = ff_m * ff_pin_N / 2;   // 12 (gear drive)
ff_pin_face = 8; ff_pin_hub_d = 14; ff_pin_hub_l = 8;
ff_ring_wall = 4; ff_ring_gap = 0.6;
// --- belt drive: GT2 (2GT), 2 mm pitch. The groove is an FDM approximation: tune ff_groove_w/_d on a test print.
belt_p = 2; belt_pld = 0.254;           // pitch; pitch radius minus tooth-tip radius
belt_w = 6; belt_land = 0.63;           // belt width; belt back above the tooth tips (preview)
belt_teeth_focus = 175;                 // closed loops 2GT-350-6 (350 mm, 175 T, 6 mm wide). Other lengths: the asserts say
belt_teeth_zoom  = 175;                 //   what fits (too short opens the zoom plate, too long hits an upright; ff_*_angle trades with it)
ff_groove_w = 1.3; ff_groove_d = 0.8;   // groove width at the tips, depth (rings and pulleys)    MEASURE (test print)
ff_belt_wall = 3.5;                     // ring wall under the groove roots
ff_flange_t = 1; ff_lip = 1.5;          // ring flanges: a flat one (print-bed side) and a 45 deg one; radial lip
ff_tooth_w = belt_w + 1;                // toothed band between the flanges
ff_belt_z = ff_flange_t + ff_tooth_w / 2;   // belt centre plane, from the ring's flat face
ff_ring_w = ff_belt ? ff_flange_t + ff_tooth_w + ff_lip : 10;
pm_body_d = 35; pm_body_l = 27; pm_ear_pitch = 42.5; pm_shaft_d = 5;
pm_ear_w = 9; pm_flange_t = 1;          // ear tab width and flange thickness (preview only)          MEASURE
// Motor (looking at the shaft, ears left-right): a 14 mm boss 1 mm tall round the shaft, a flat face otherwise.
// The wire box is on the SIDE of the can, right next to the right ear: from 2.5 mm above the ear line, 6 mm wide,
// standing 2-3 mm off the can, from the ear plane back along the can. It sits inside the bracket plate, which gets
// a notch for it (swept over the tension slot) with room for the wires to bend forward through the plate.
pm_shaft_flat = 4;                      // D shaft: flat to the opposite round side (measured; the flat is 4 mm wide too)
pm_shaft_l = 4;                         // shaft end, from the mounting face                            MEASURE
pm_boss_d = 14; pm_boss_h = 1;          // boss round the shaft base
pm_box_y0 = 2.5; pm_box_w = 6;          // wire box: from the ear line, width                          MEASURE
pm_box_h = 3; pm_box_l = 8;             // stands off the can; length back from the ear plane (preview)  MEASURE
pm_box_clr = 0.5; pm_wire_room = 1.5;   // notch clearance round the box; extra radial room for the wires
// printed GT2 pulley (parts/pulley_tb35.scad) replaces the motor's 1.5GT one: 45 deg flange toward the motor,
// just above the boss (set the gap with two layers of paper), toothed band, flat flange (print-bed side).
pm_pulley_N = 20;
pm_lip = 1.5;                           // pulley flange radial lip (the 45 deg flange is as tall)
pm_pulley_gap = pm_boss_h + 0.2;        // pulley's motor-side face, off the mounting face
pm_pulley_w = pm_lip + ff_tooth_w + ff_flange_t;   // 9.5 overall
pm_pulley_lip_d = 2 * (belt_pr(pm_pulley_N) - belt_pld + pm_lip);
pm_pulley_z = pm_pulley_gap + pm_lip + ff_tooth_w / 2;   // belt plane in front of the motor face
pm_bore_fit = 0.1;                      // D bore clearance (snug; a drop of CA on the flat)
pm_slot = 3;                            // belt tension travel each way (radial) around the nominal centre distance
pm_nut_af = 7;                          // M4 nut across flats, on the back of the plate next to the can
// NEMA 17 pancake (ff_drive "nema"): face on the plate's front face, 22 mm boss in a slot, 4 x M3 x 12 from behind
// through slots (+-pm_slot) into the motor. Stock 20T GT2 pulley, hub toward the motor, 1 mm off the plate.
ffn_l = 23;                             // body length (preview; pancakes are 20-25)                   MEASURE
ffn_shaft_l = 20;                       // shaft, from the face (incl. the boss)                        MEASURE
gt2m_hub_d = 13; gt2m_hub_l = 7;        // stock 20T GT2 pulley for 6 mm belt, 5 mm bore: hub with 2 grub screws
gt2m_flange_d = 16; gt2m_flange_t = 1; gt2m_band = 7;   // flanges and the toothed band between them     MEASURE
gt2m_l = gt2m_hub_l + 2 * gt2m_flange_t + gt2m_band;    // 16 overall
gt2m_belt_off = gt2m_hub_l + gt2m_flange_t + gt2m_band / 2;   // belt centre from the hub end: 11.5
gt2m_gap = 1;                           // hub end off the plate's rear face
function belt_pr(N) = N * belt_p / (2 * PI);
function belt_pr_min(od) = od / 2 + ff_ring_gap / 2 + ff_belt_wall + ff_groove_d + belt_pld;
function belt_ring_N(od) = 2 * ceil(belt_pr_min(od) * 2 * PI / belt_p / 2);
// open-belt pitch length for pitch radii R > r at centre distance C; belt_cd() inverts it by bisection
function belt_len(C, R, r) = let(phi = asin((R - r) / C))
    2 * C * cos(phi) + (PI + 2 * phi * PI / 180) * R + (PI - 2 * phi * PI / 180) * r;
function belt_cd(L, R, r, lo = undef, hi = undef, i = 0) =
    let(a = lo == undef ? R - r + 0.01 : lo, b = hi == undef ? L / 2 : hi, m = (a + b) / 2)
    i >= 60 ? m : belt_len(m, R, r) > L ? belt_cd(L, R, r, a, m, i + 1) : belt_cd(L, R, r, m, b, i + 1);
// --- ring (gear or belt pulley) on each lens ring
function ring_gear_N(od) = ff_belt ? belt_ring_N(od)
    : 2 * round((od / 2 + ff_ring_gap / 2 + ff_ring_wall + 1.25 * ff_m) / ff_m);   // even: two identical halves must phase-match
function ring_gear_pr(od) = ff_belt ? belt_pr(ring_gear_N(od)) : ff_m * ring_gear_N(od) / 2;
function ring_tip_r(od) = ff_belt ? ring_gear_pr(od) - belt_pld : ring_gear_pr(od) + ff_m;
function ring_out_r(od) = ring_tip_r(od) + (ff_belt ? ff_lip : 0);   // outermost radius of the toothed ring
focus_gear_N = ring_gear_N(focus_ring_od);  focus_gear_pr = ring_gear_pr(focus_ring_od);
zoom_gear_N  = ring_gear_N(zoom_ring_od);   zoom_gear_pr  = ring_gear_pr(zoom_ring_od);
pm_pulley_pr = belt_pr(pm_pulley_N);
focus_cd = ff_belt ? belt_cd(belt_teeth_focus * belt_p, focus_gear_pr, pm_pulley_pr) : focus_gear_pr + ff_pin_pr + cd_extra;
zoom_cd  = ff_belt ? belt_cd(belt_teeth_zoom * belt_p, zoom_gear_pr,  pm_pulley_pr) : zoom_gear_pr  + ff_pin_pr + cd_extra;
ff_ratio_focus = ff_belt ? focus_gear_N / pm_pulley_N : focus_gear_N / ff_pin_N;
ff_ratio_zoom  = ff_belt ? zoom_gear_N  / pm_pulley_N : zoom_gear_N  / ff_pin_N;
ff_lug_l = 6; ff_lug_t = 9;            // ring-gear clamp lugs: axial length, tangential width
focus_body_rin = ff_nema ? focus_cd - pm_slot - motor_w / 2 : ff_belt ? focus_cd - pm_slot - pm_body_d / 2 : focus_cd + ffm_shaft_off - ffm_body_d / 2;   // inner radius of the motor bodies, from the optical axis
zoom_body_rin  = ff_belt ? zoom_cd  - pm_slot - pm_body_d / 2 : zoom_cd  + ffm_shaft_off - ffm_body_d / 2;
focus_rid = focus_ring_od / 2 + ff_ring_gap / 2;
zoom_rid  = zoom_ring_od  / 2 + ff_ring_gap / 2;
focus_lug_rid = max(focus_rid, lens_rear_barrel_d / 2 + ff_ring_gap / 2);   // focus lugs sit over the rear barrel
zoom_lug_rid  = zoom_rid;
// gear: lugs sweep under the pinion hub and the other motor's body. belt: just past the flange, >= 7.5 mm deep
focus_lug_r1 = ff_belt ? max(ring_out_r(focus_ring_od) + 2, focus_lug_rid + 7.5) : min(focus_cd - ff_pin_hub_d / 2, zoom_body_rin) - 1.5;
zoom_lug_r1  = ff_belt ? max(ring_out_r(zoom_ring_od)  + 2, zoom_lug_rid  + 7.5) : min(zoom_cd  - ff_pin_hub_d / 2, focus_body_rin) - 1.5;
assert(focus_lug_r1 - focus_lug_rid >= 7, "focus ring-gear lugs too thin");
assert(zoom_lug_r1 - zoom_rid >= 7, "zoom ring-gear lugs too thin");
ff_focus_side = +1;                    // focus motor on +Y (left), zoom on -Y (right)
ff_zoom_side  = -1;
// motor axis angle in the YZ plane, from outward-horizontal toward +Z.
//   gear: focus low-left (body forward), zoom high-right (body rearward). belt: both high, bodies forward.
ff_focus_angle = ff_belt ? 70 : -30;
ff_zoom_angle  = ff_belt ? 70 : 30;
focus_pin_yz = [ff_focus_side * focus_cd * cos(ff_focus_angle), focus_cd * sin(ff_focus_angle)];
zoom_pin_yz  = [ff_zoom_side  * zoom_cd  * cos(ff_zoom_angle),  zoom_cd  * sin(ff_zoom_angle)];
focus_gear_x0 = focus_ring_x - ff_ring_w / 2;  focus_gear_x1 = focus_ring_x + ff_ring_w / 2;
zoom_gear_x0  = zoom_ring_x  - ff_ring_w / 2;  zoom_gear_x1  = zoom_ring_x  + ff_ring_w / 2;
focus_pin_x0 = focus_ring_x - ff_pin_face / 2; focus_pin_x1 = focus_pin_x0 + ff_pin_face;
zoom_pin_x0  = zoom_ring_x  - ff_pin_face / 2 + 1; zoom_pin_x1 = zoom_pin_x0 + ff_pin_face;   // shifted 1 fwd: plate clears the focus gear, pinion stops at the lug face
focus_belt_x = focus_gear_x1 - ff_belt_z;      // the focus ring's flat face points forward, the zoom ring's rearward
zoom_belt_x  = zoom_gear_x0 + ff_belt_z;
ffb_t = 8;                                        // bracket plate thickness (holds M4 inserts / nuts)
// gear: focus hub forward, body forward of the plate (87..95); zoom hub rearward, body behind the plate (81..89)
// belt: the back of the motor flange sits on the plate's rear face, the can goes through it forward
// nema: the pulley hub sits gt2m_gap behind the plate, the motor face on the plate's front face
focus_plate_x0 = ff_nema ? focus_belt_x + gt2m_belt_off + gt2m_gap
               : ff_belt ? focus_belt_x + pm_pulley_z + pm_flange_t : focus_pin_x1 + ff_pin_hub_l;
focus_plate_x1 = focus_plate_x0 + ffb_t;
zoom_plate_x0  = ff_belt ? zoom_belt_x + pm_pulley_z + pm_flange_t : zoom_pin_x0 - ff_pin_hub_l - ffb_t;
zoom_plate_x1  = zoom_plate_x0 + ffb_t;
ffm_body_y_off = ffm_shaft_off;                   // body centre further from the lens than the shaft
// Tooth phasing: a ring tooth faces the pinion and a pinion space faces the ring at the nominal angles.
// Local gear angle phi vs global YZ direction psi (from +Y toward +Z): parts placed with rotate([0,-90,0])
// have phi = 90 - psi; the zoom ring and zoom pinion use rotate([0,90,0]) and have phi = psi + 90.
function snap_tooth(a, N) = a - round(a / (360 / N)) * (360 / N);                                  // tooth at local a
function snap_space(a, N) = a - (round((a - 180 / N) / (360 / N)) * (360 / N) + 180 / N);          // space at local a
focus_psi = ff_focus_angle;  zoom_psi = 180 - ff_zoom_angle;
focus_ring_phase = snap_tooth(90 - focus_psi, ring_gear_N(focus_ring_od));
zoom_ring_phase  = snap_tooth(zoom_psi + 90, ring_gear_N(zoom_ring_od));
focus_pin_phase  = snap_space(90 - (focus_psi + 180), ff_pin_N);
zoom_pin_phase   = snap_space((zoom_psi + 180) + 90, ff_pin_N);
tilt_pin_phase = 360 / pin_N / 2;                 // 15 deg: the sector has a tooth straight down, the pinion shows a space

// ---------- cradle (tilting payload carrier) -----------------------------------------
pivot_x      = 51;
pivot_z      = 0;
saddle_r     = lens_rear_barrel_d / 2 + 0.5;       // 38.5
saddle_half_angle = 45;                            // contact arc, each side of bottom
saddle_x0    = 28;  saddle_x1 = 60;                // saddle block X extent (front face 1.5 mm behind the zoom motor body)
saddle_hw    = 52;                                 // block half width (Y)
block_z0     = -58;                                // block bottom
ledge_z      = -8;                                 // top of the clamp ledges
relief_hw    = 44;                                 // half width of the clearance cut above the contact arc (switch panel)
relief_z     = -saddle_r * cos(saddle_half_angle) - 1;   // -28.2: everything above this inside Y +/-relief_r is cut
clamp_screw_y = 48;
clamp_screw_x = pivot_x;
clamp_x0 = 40; clamp_x1 = 60;                      // cap X extent
clamp_t  = 6;                                      // band over the barrel
clamp_half_angle = 45;
imu_pad = [30, 36, 3];                             // on top of the cap, kept behind the focus gear lugs
imu_pad_xc = clamp_x1 - imu_pad[0] / 2;
imu_grid = 5; imu_hole_d = 2.4;                    // self-tap M2.5 grid for any breakout board
shelf_z1 = -cam_h / 2;                             // camera bottom
shelf_t  = 8;
shelf_x0 = cam_x0 - 5; shelf_x1 = -2;
spine_hw = 30; spine_z1 = -35;                     // spine top clears the adapter (r 32)
cw_hole_d = 8.4; cw_x = -44; cw_z = [-44, -54];    // counterweight bar holes (M8 bolts / 8 mm rod)
// trunnion arms
arm_t   = 10;
arm_y0  = saddle_hw;                               // 52: arm inner face = block side
arm_y1  = arm_y0 + arm_t;                          // 62
hub_r   = 12;                                      // around the stub
arm_bolt_x = [saddle_x0 + 7, saddle_x1 - 7];       // M4 into the block sides
arm_bolt_z = [-34, -52];
sector_web_r = 30;                                 // solid plate radius inside the sector
spacer_t = 2; spacer_d = 16;                       // trunnion washers (printed), one per side
// nose (keel + focus/zoom brackets)
keel_z1 = -52; keel_z0 = -62; keel_hw = 22;
keel_x0 = saddle_x1; keel_x1 = ff_zoom ? max(focus_plate_x1, zoom_plate_x1) : focus_plate_x1;
nose_flange_t = 6; nose_flange_z1 = -50;           // flange top stays under the swept focus-gear lugs
nose_bolt_y = [-18, -6, 6, 18]; nose_bolt_z = [-56];
// nose bolts run the whole keel length: head on the keel front face, shank through keel + flange into the block inserts
nose_bolt_l = ff_pm ? 60 : 40;                     // M4 socket head; 60 for the longer TB35 keel
nose_bolt_seat_x = keel_x1;                        // head seats on the keel front face (95 gear, ~115 belt)
nose_bolt_tip_x = nose_bolt_seat_x - nose_bolt_l;  // 55 gear: 5 mm into the 7 mm insert
m4_shc_d = 7; m4_shc_h = 4;                        // M4 socket-head cap (preview / access check)
ffb_lens_r = 42;                                   // bracket hole around the lens
zoom_ffb_lens_r = ff_pm ? max(ffb_lens_r, zoom_lug_r1 + 2) : ffb_lens_r;   // belt: the zoom plate is over the swept zoom lugs
ffb_pad_half_angle = 26;                           // bracket pad sector around the motor, deg
ffb_stem_z1 = -40;                                 // stem from the keel up to the lens arc
function ffb_pad_r(cd) = sqrt(pow(cd + ffm_shaft_off, 2) + pow(ffm_ear_pitch / 2, 2)) + 6;   // covers the ears + insert margin

// ---------- fork (uprights on the platform) --------------------------------------------
upright_gap = 2;                                    // arm outer face -> upright inner face (spacer lives here)
upright_t   = 10;
upright_y0  = arm_y1 + upright_gap;                 // 64
upright_y1  = upright_y0 + upright_t;               // 74
pivot_h     = 135;                                  // pivot above the platform top
plat_top_z  = -pivot_h;                             // axis frame
upright_top_r = 20;                                 // round top around the bearing
upright_hw_top = upright_top_r;                     // half width at the pivot
upright_hw_bot = 45;                                // half width at the foot
foot_t = 10; foot_y0 = arm_y0 + 2; foot_y1 = upright_y1;   // foot flange inboard only (prints outer face down)
foot_bolt_dx = 32; foot_bolt_y = [59, 69];          // M4 inserts in the platform
stub_l = 22;                                         // 8 mm steel stubs: arm (10) + spacer (2) + bearing (7) + 3
bearing_lip = 3;                                    // outer lip; the 608 goes in from the inner face
// tilt motor on the left upright's outer face, straight below the pivot
tilt_motor_angle = -90;                             // deg from +X toward +Z
tilt_motor_xz = [pivot_x + tilt_cd * cos(tilt_motor_angle), pivot_z + tilt_cd * sin(tilt_motor_angle)];
tilt_pin_y1 = upright_y1 - motor_boss_h - pin_hub_l;   // pinion gear face nearest the motor: 63
tilt_pin_y0 = tilt_pin_y1 - pin_face;                  // 55: inside the arm plane (52..62) by 7 mm
tilt_slot_l = 5;                                    // radial adjustment of the motor
window_d = 2 * (pin_pr + gm) + 5.5;                 // pinion passes through the upright: 23
// level stop: boss on the upright inner face above the sector's rear end, M4 screw tip is the stop face
switch_hole_d = 2.4; switch_pitch = 9.5;              // homing microswitch, 2 x M2.5 self-tap
stop_angle = 158;                                   // boss centre, deg from +X toward +Z (rear, just above the sector's rear edge)
stop_r  = 32;                                       // radius of the stop screw axis (near the hub, inside the upright outline)
stop_x  = pivot_x + stop_r * cos(stop_angle);       // 21.3
stop_boss_x = 14; stop_boss_z0 = 10; stop_boss_z1 = 24;   // boss X width, Z extent (axis frame)
stop_boss_y0 = arm_y0 + 1;                          // protrudes into the arm plane
stop_screw_y = (stop_boss_y0 + upright_y0) / 2;
ear_x0 = 0; ear_z0 = 8; ear_z1 = 24;                // rearward lobe of the upright outline carrying the boss and switch
switch_x = [2.5, 2.5 + switch_pitch]; switch_z = 18;
stop_contact_z = (pivot_x - stop_x) * tan(180 - (sector_a0 + 360));   // sector rear edge height at the screw: 6.3
// homing switch (optional, 2 x M2.5 self-tap, 9.5 mm apart) next to the stop

// ---------- turntable (base frame) ----------------------------------------------------------
deck_t   = 8;
deck_r   = 100;
race_r   = 70;                                      // ball pitch radius
groove_d = 3.0;                                     // 90 deg V, depth below the race face
ridge_r0 = 62; ridge_r1 = 80; ridge_h = 10;
ball_z   = ridge_h - groove_d + ball_r * sqrt(2);   // ball centre: 11.24
plat_z0  = ball_z + (ball_r * sqrt(2) - groove_d);  // platform underside: 12.49
plat_t   = 10;
plat_z1  = plat_z0 + plat_t;                        // platform top: 22.49
plat_r   = 92;
n_balls  = floor(2 * PI * race_r / (ball_d + 0.5)); // 67
skirt_z0 = plat_z0 - pan_gear_face;                 // gear skirt bottom: 3.49
lip_r0 = 81; lip_r1 = 85; lip_z0 = ridge_h - 2;     // dust lip hanging outside the ridge
shaft_relief = [pan_motor_r - 5, pan_motor_r + 5, 2.5];   // groove under the platform for the pan motor shaft tip
tube_r0 = 15; tube_r1 = 23;                         // centre cable tube (part of the deck)
plat_hole_r = tube_r1 + 1;
tube_z1  = plat_z1 + fit_slide;                     // tube top: retainer sits here
ret_r1   = 30; ret_t = 3; ret_n = 3;                // retainer ring
pin_z0 = -deck_t + motor_boss_h + pin_hub_l; pin_z1 = pin_z0 + pin_face;   // pan pinion 3..11 (hub top stays under the skirt)
deck_pin_hole_d = pin_hub_d + 7;                    // 24: pinion + hub pass through
pan_motor_angle = 180;                              // motor at -X side (under the camera when panned 0)
pan_motor_xy = [pan_motor_r * cos(pan_motor_angle), pan_motor_r * sin(pan_motor_angle)];
pan_slot_l = 4;
hous_h = 55; hous_wall = 4; hous_r = deck_r;
hous_bolt_r = 94; hous_n = 6;
hous_tab = [22, 12, 10];                            // tangential, radial, tall
cable_slot = [40, 25];                              // in the housing wall, at +X (rear when pan = 0)
feet_n = 4; foot_slot = 5.4;
base_z_in_axis = plat_top_z - plat_z1;              // deck floor top in the axis frame: -157.49

// ---------- controller tray (optional add-on under the housing) --------------------------------
// Flat plate bolted under the housing's four feet; carries the BTT SKR Pico V1.0 and an Orange Pi
// Zero 2W side by side on printed standoffs, inside the housing cavity, clear of the pan motor.
tray_z1   = -deck_t - hous_h;                       // tray top = housing bottom: -63
tray_t    = 3;                                      // plate
tray_w    = 110; tray_y0 = -66; tray_y1 = 92;       // plate extent (clipped to the housing circle)
tray_r    = 8;                                      // plate corner radius
tray_pad_d = 16; tray_pad_h = 8;                    // tray_foot pucks under the plate corners (separate prints)
tray_foot_r  = hous_r + 6;                          // housing foot slot centre radius: 106
tray_foot_xy = tray_foot_r * cos(45);               // feet at the 45 deg diagonals: 74.95
tray_arm_x   = tray_w / 2 - tray_r;                 // arms leave the plate corners toward the pads
tray_so_h = 6; tray_so_d = 6; tray_so_pilot = 2.2;  // printed standoffs, M2.5 self-tapping
tray_vent_w = 4;
tray_pcb_t = 1.6; tray_comp_h = 12;                 // preview envelope
tray_plug_l = 22; tray_plug_w = 12;                 // USB-C plug body (plug room checks and preview)
tray_rin = hous_r - hous_wall;                      // housing inner radius: 96
// Each board has a centre (base frame) and an angle; [u, v] below are the board's own long / short axes,
// rotated by that angle. Holes, vents, plug envelopes and the checks all follow the angle.
// BTT SKR Pico V1.0: 85 x 56, Pi hole pattern 58 x 49, holes 3.5 mm from the left/top/bottom edges (none at the
// USB-C / power end), M2.5. USB-C + power terminals at the +u end, stepper connectors along the -v long edge.
// Turned 45 deg clockwise so the USB-C end points inward (+X/-Y, into the cavity beside the pan motor) with
// the stepper connectors still facing the motor: a straight plug pointing at the wall did not fit (user, 2026-10-31).
skr_size = [85, 56]; skr_holes = [58, 49]; skr_hole_off = [-(skr_size[0] / 2 - 3.5 - skr_holes[0] / 2), 0];   // [-10, 0]
skr_xy    = [14, 40];                               // board centre (base frame)
skr_angle = -45;                                    // +u = USB-C direction, measured from +X
skr_usb_v = -skr_size[1] / 2 + 11.8;                // USB-C centre: 11.8 mm from the stepper-connector edge: -16.2
skr_plug  = [skr_size[0] / 2 + tray_plug_l / 2, skr_usb_v];              // plug envelope centre, board frame
skr_pwr   = [skr_size[0] / 2 + 3.5, skr_size[1] / 2 - 7];                // wire room at the power terminals (7 x 14)
skr_vent_ys = [-16, -8, 0, 8, 16]; skr_vent_l = 60;
// Orange Pi Zero 2W: 65 x 30, Pi Zero hole pattern 58 x 23, M2.5           MEASURE
// Long axis along X, USB-C / mini-HDMI edge toward -Y (outer wall), microSD on a short edge.
opi_size = [65, 30]; opi_holes = [58, 23]; opi_hole_off = [0, 0];
opi_xy    = [0, -45];
opi_angle = 0;
opi_plug  = [0, -opi_size[1] / 2 - tray_plug_l / 2];                     // plugs along the whole -v edge
opi_vent_ys = [-4, 4]; opi_vent_l = 44;
// checks: boards and plugs inside the housing wall, clear of the pan motor body, of each other, standoffs on the plate
function _rot(p, a) = [p[0] * cos(a) - p[1] * sin(a), p[0] * sin(a) + p[1] * cos(a)];
function _rect_pts(xy, sz, a = 0, off = [0, 0]) = [for (sx = [-1, 1], sy = [-1, 1]) xy + _rot([off[0] + sx * sz[0] / 2, off[1] + sy * sz[1] / 2], a)];
function _pts_r(pts) = max([for (p = pts) norm(p)]);
function _proj(pts, n) = [for (p = pts) p * n];
function _sep(A, B, n) = max(min(_proj(B, n)) - max(_proj(A, n)), min(_proj(A, n)) - max(_proj(B, n)));
// separating-axis gap between two convex quads (exact when an edge normal separates them, else a lower bound)
function _gap(A, B, a = 0, b = 0) = max([for (n = [[1, 0], [0, 1], _rot([1, 0], a), _rot([0, 1], a), _rot([1, 0], b), _rot([0, 1], b)]) _sep(A, B, n)]);
_skr = _rect_pts(skr_xy, skr_size, skr_angle);          _opi = _rect_pts(opi_xy, opi_size, opi_angle);
_skr_plug = _rect_pts(skr_xy, [tray_plug_l, tray_plug_w], skr_angle, skr_plug);
_skr_pwr  = _rect_pts(skr_xy, [7, 14], skr_angle, skr_pwr);
_opi_plug = _rect_pts(opi_xy, [opi_size[0], tray_plug_l], opi_angle, opi_plug);
_motor = _rect_pts(pan_motor_xy, [motor_w, motor_w]);
assert(_pts_r(_skr) <= tray_rin - 2, "SKR Pico corner hits the housing wall");
assert(_pts_r(_opi) <= tray_rin - 2, "Orange Pi corner hits the housing wall");
assert(_gap(_skr, _motor, skr_angle) >= 3, "SKR Pico under the pan motor body");
assert(_gap(_opi, _motor, opi_angle) >= 3, "Orange Pi under the pan motor body");
assert(_gap(_skr, _opi, skr_angle, opi_angle) >= 4, "boards overlap");
assert(_pts_r(_skr_plug) <= tray_rin - 5, "no room for the SKR Pico USB-C plug at the housing wall");
assert(_gap(_skr_plug, _opi, skr_angle, opi_angle) >= 3, "SKR Pico USB-C plug hits the Orange Pi");
assert(_gap(_skr_plug, _motor, skr_angle) >= 3, "SKR Pico USB-C plug hits the pan motor");
assert(_pts_r(_skr_pwr) <= tray_rin - 2, "no room for wires at the SKR Pico power terminals");
assert(_pts_r(_opi_plug) <= tray_rin - 2, "no room for the Orange Pi USB-C plugs");
assert(_gap(_opi_plug, _skr, opi_angle, skr_angle) >= 3, "Orange Pi plugs hit the SKR Pico");
// every standoff (and its wall) on the plate: inside the rectangle and the housing circle
function _on_plate(h) = abs(h[0]) + tray_so_d / 2 <= tray_w / 2 && h[1] - tray_so_d / 2 >= tray_y0 && h[1] + tray_so_d / 2 <= tray_y1 && norm(h) + tray_so_d / 2 <= hous_r;
assert([for (h = _rect_pts(skr_xy, skr_holes, skr_angle, skr_hole_off)) if (!_on_plate(h)) h] == [], "SKR Pico standoff off the tray plate");
assert([for (h = _rect_pts(opi_xy, opi_holes, opi_angle, opi_hole_off)) if (!_on_plate(h)) h] == [], "Orange Pi standoff off the tray plate");
assert(tray_pad_h - m4_head_h - 0.5 >= 3, "tray foot puck too thin above the bolt head");

// ---------- tripod spider (optional add-on: Celestron NexStar SE / Evolution tripod) -------------
// One flat plate that replaces the four tray_foot pucks: the housing feet (and the controller tray) bolt down
// onto four bosses, and the tripod's three captive 3/8-16 thumbscrews thread up into hex nuts dropped into
// pockets on the top face (the screws pull the nuts down onto the pocket floors, so nothing covers them).
// Head layout from the user (2026-11-03): thumbscrew centres 82 mm from the centre, 120 deg apart, between the
// legs; an unthreaded alignment pin stands in the middle (Celestron says it can be lowered with a screwdriver).
tripod_bolt_r   = 82;                               // thumbscrew centre radius                        MEASURED
tripod_bolt_a   = [30, 150, 270];                   // thumbscrew angles (one at -Y: all three clear of the tray plate)
tripod_screw_d  = 9.5 + 1;                          // 3/8" thumbscrew clearance
tripod_screw_up = 8;                                // thread standing above the head top              MEASURE (8 on the older 93593)
tripod_nut_af   = 14.3; tripod_nut_h = 8.3;         // 3/8-16 hex nut: 9/16" across flats, 21/64" thick (a jam nut also fits)
tripod_nut_fit  = 0.5;
tripod_nut_pocket_d = (tripod_nut_af + tripod_nut_fit) / cos(30);   // hex pocket across corners: 17.09
tripod_nut_boss_d = 24;
tripod_pin_d    = 16; tripod_pin_h = 10;            // alignment pin, preview + height check          MEASURE
tripod_t        = 5;                                // plate
tripod_floor    = 2.5;                              // under each nut pocket (measured up from the pad bottom)
// The head top is flat except for a shallow recess around each thumbscrew (the leg hinge casting): 46 mm wide
// tangentially, reaching 30 mm inward of the screw and out to the edge, 1-2 mm deep (user, 2026-11-03). A pad
// under each nut boss fills it, so the thumbscrews pull the plate onto three pads instead of bending it into
// the dips; set the depth to the deepest of the three (a pad a little too tall just lifts the ring off the flat).
tripod_recess_d = 2;                                // recess depth = pad height                     MEASURE (1-2)
tripod_recess_w = 46; tripod_recess_in = 30;        // recess width, and reach inward of the screw   preview only
tripod_pad_d    = 20;                               // pad under each nut boss, inside the recess
tripod_r0 = 25; tripod_r1 = 90;                     // plate annulus: the hole clears the pin, the rim reaches the nut bosses
tripod_with_tray = true;                            // false: the housing feet sit straight on the bosses (tray_t taller)
tripod_boss_h   = tray_pad_h + (tripod_with_tray ? 0 : tray_t);
tripod_z1       = tray_z1 - tray_t - tray_pad_h;    // plate top = puck bottom: -74 (same with or without the tray)
tripod_z0       = tripod_z1 - tripod_t;             // plate bottom = tripod head top: -79
tripod_pad_z0   = tripod_z0 - tripod_recess_d;      // pad bottom = recess floor: -81
tripod_nut_z0   = tripod_pad_z0 + tripod_floor;     // nut pocket floor: -78.5
tripod_nut_z1   = tripod_nut_z0 + tripod_nut_h + 0.5;   // nut boss top: -69.7
tripod_head_r   = 95; tripod_head_t = 15;           // preview head slab only
function tripod_bolt_xy(a) = tripod_bolt_r * [cos(a), sin(a)];
function _rect_dist(p, hw, y0, y1) = norm([max(abs(p[0]) - hw, 0), max(y0 - p[1], p[1] - y1, 0)]);   // point to a rectangle |x|<=hw, y0..y1
function _seg_dist(p, a, b) = let (ab = b - a, t = min(max((p - a) * ab / (ab * ab), 0), 1)) norm(p - (a + t * ab));
_tray_arms = [for (sx = [-1, 1], sy = [-1, 1]) [[sx * tray_arm_x, sy > 0 ? tray_y1 - tray_r : tray_y0 + tray_r], [sx * tray_foot_xy, sy * tray_foot_xy]]];
for (a = tripod_bolt_a) let (p = tripod_bolt_xy(a)) {
    assert(_rect_dist(p, tray_w / 2, tray_y0, tray_y1) >= tripod_nut_boss_d / 2 + 2, str("tripod nut boss under the tray plate at ", a, " deg"));
    assert(min([for (s = _tray_arms) _seg_dist(p, s[0], s[1])]) >= tripod_nut_boss_d / 2 + tray_pad_d / 2 + 2, str("tripod nut boss under a tray arm at ", a, " deg"));
    assert(min([for (sx = [-1, 1], sy = [-1, 1]) norm(p - [sx * tray_foot_xy, sy * tray_foot_xy])]) >= tripod_nut_boss_d / 2 + tray_pad_d / 2 + 2, str("tripod nut boss hits a foot boss at ", a, " deg"));
}
assert(tripod_nut_z1 <= tripod_z1 + tripod_boss_h - 1, "tripod nut boss reaches the tray / housing feet");
assert(tripod_screw_up - tripod_floor >= 4, "thumbscrew thread barely reaches the nut: thinner tripod_floor");
assert(tripod_pad_d / 2 + 2 <= min(tripod_recess_in, tripod_recess_w / 2), "tripod pad does not fit inside the head recess");
assert(tripod_pad_d >= tripod_nut_pocket_d + 2, "tripod pad narrower than the nut pocket: the pocket floor would be unsupported");
assert(tripod_pin_h <= tripod_t + tripod_boss_h - 1, "alignment pin would hit the tray: lower the pin");
assert(tripod_pin_d / 2 + 2 <= tripod_r0, "tripod plate hole too small for the alignment pin");
assert(tripod_t + tripod_boss_h - (m4_head_h + 0.5) >= 3, "tripod foot boss too thin above the bolt head");
assert(tripod_bolt_r - tripod_nut_boss_d / 2 <= tripod_r1 - 4, "nut boss barely joined to the tripod plate rim");
assert(2 * max(tripod_r1, tripod_bolt_r + tripod_nut_boss_d / 2, tray_foot_xy + tray_pad_d / 2) <= 200, "tripod spider does not fit a 200 mm bed");

// ---------- derived checks ----------------------------------------------------------------
sector_r1 = tilt_pr + gm;                           // tooth tip radius 76.25
assert(sector_a0 + 90 + 5 <= tilt_motor_angle, "sector rear end would leave the pinion before tilt 90");
assert(sector_a1 - 5 >= tilt_motor_angle, "sector front end does not reach the pinion at tilt 0");
assert(upright_y1 - motor_boss_h - motor_shaft_l <= tilt_pin_y0, "NEMA shaft too short to reach the tilt pinion");
assert(arm_y1 - tilt_pin_y0 >= pin_face - 2, "tilt pinion barely overlaps the sector");
assert(tilt_pin_y1 <= upright_y0, "tilt pinion would run inside the upright");
assert(pin_z1 <= -deck_t + motor_shaft_l, "NEMA shaft too short for the pan pinion");
assert(pin_z0 <= skirt_z0 - 0.4, "pan pinion hub would touch the gear skirt");
assert(pin_z1 - skirt_z0 >= pin_face - 1, "pan pinion barely meshes the skirt");
assert(tilt_motor_xz[1] - motor_w / 2 > plat_top_z + 3, "tilt motor would hit the platform: raise pivot_h");
assert(relief_hw - lens_rear_barrel_d / 2 >= switch_panel_protrude + 2, "saddle relief too tight for the switch panel");
assert(arm_y0 - lens_d / 2 >= 8, "arms too close to the lens");
assert(pan_skirt_r1 < ridge_r0 - 1, "gear skirt hits the race ridge");
assert(sqrt(pow(foot_bolt_dx, 2) + pow(foot_bolt_y[1], 2)) < plat_r - 5, "foot insert too close to the platform edge");
_rear_drop = sqrt(pow(shelf_x0 - 20 - pivot_x, 2) + pow(shelf_z1 - shelf_t, 2));   // incl. 20 mm connector
assert(_rear_drop + 5 < pivot_h, str("camera + cable would hit the platform at 90 deg; need pivot_h > ", _rear_drop + 5));
assert(ff_belt || focus_cd - ff_pin_pr - gm > lens_d / 2 + 1, "focus pinion rubs the lens");
assert(ff_belt || abs(focus_pin_yz[0]) + ff_pin_pr + ff_m + 1 < upright_y0, "focus pinion would hit the left upright: lower ff_focus_angle");
assert(ff_belt || abs(zoom_pin_yz[0]) + ff_pin_pr + ff_m + 1 < upright_y0, "zoom pinion would hit the right upright");
assert(ff_belt || zoom_plate_x0 - focus_gear_x1 >= 1, "zoom bracket plate hits the focus ring gear");
assert(ff_belt || zoom_plate_x0 - ffm_body_l - saddle_x1 >= 1, "zoom motor body hits the saddle block");
assert(ff_belt || zoom_pin_x1 <= zoom_gear_x1, "zoom pinion runs into the zoom gear lugs");
assert(ff_belt || ffb_pad_r(focus_cd) < upright_y0 + 10, "focus bracket pad reaches far into the upright plane");
assert(nose_flange_z1 < -focus_lug_r1 - 1, "nose flange would hit the swept focus-gear lugs");
assert(nose_bolt_tip_x <= saddle_x1 - 4 && nose_bolt_tip_x >= saddle_x1 - m4_insert_h + 0.5, "nose bolt length: needs >= 4 mm in the insert and must end inside it (only a pilot hole below)");
for (z = nose_bolt_z) assert(z - m4_shc_d / 2 >= keel_z0 && z + m4_shc_d / 2 <= keel_z1, "nose bolt head overhangs the keel front face");
assert(-deck_t + motor_shaft_l < plat_z0 + shaft_relief[2], "pan motor shaft tip hits the platform");
assert(ff_belt || zoom_cd - ff_pin_pr - gm > lens_d / 2 + 1, "zoom pinion rubs the lens");
// belt drive
_pm_y = function(cd, a) abs(cd * cos(a)) + pm_slot + max(pm_body_d / 2, pm_ear_pitch / 2 * sin(a) + 6);
assert(!ff_pm || focus_body_rin >= zoom_lug_r1 + 1, "focus motor can hits the swept zoom ring lugs: raise belt_teeth_focus/_zoom");
assert(!ff_pm || zoom_body_rin >= zoom_lug_r1 + 1, "zoom motor can hits the swept zoom ring lugs: raise belt_teeth_focus/_zoom");
assert(!ff_pm || focus_cd - pm_slot - pm_pulley_lip_d / 2 > ring_out_r(focus_ring_od) + 2, "focus pulley too close to its ring");
assert(!ff_pm || zoom_cd - pm_slot - pm_pulley_lip_d / 2 > ring_out_r(zoom_ring_od) + 2, "zoom pulley too close to its ring");
assert(!ff_pm || _pm_y(focus_cd, ff_focus_angle) < upright_y0 - 1, "focus motor/bracket reaches the left upright plane: raise ff_focus_angle");
assert(!ff_pm || _pm_y(zoom_cd, ff_zoom_angle) < upright_y0 - 1, "zoom motor/bracket reaches the right upright plane: raise ff_zoom_angle");
assert(!ff_belt || focus_plate_x0 - focus_gear_x1 >= 1, "focus plate hits its own ring");
assert(!ff_belt || nose_bolt_tip_x <= saddle_x1 - 4, "nose bolts too short for the belt keel");
// wall between each plate's can slot (motor slid fully inward) and its lens hole
ff_plate_web = 2.5;
assert(!ff_pm || focus_cd - pm_slot - (pm_body_d + 1) / 2 - ffb_lens_r >= ff_plate_web, "focus plate: can slot breaks into the lens hole: longer belt_teeth_focus");
assert(!ff_pm || zoom_cd - pm_slot - (pm_body_d + 1) / 2 - zoom_ffb_lens_r >= ff_plate_web, "zoom plate: can slot breaks into the lens hole: longer belt_teeth_zoom");
assert(!ff_pm || pm_shaft_l - pm_pulley_gap >= 2.5, "pulley: under 2.5 mm of shaft in the hub");
// NEMA pancake (focus only): square body with its sides along the radius / tangent
_nema_y = abs(focus_cd * cos(ff_focus_angle)) + pm_slot * cos(ff_focus_angle) + motor_w / 2 * (cos(ff_focus_angle) + sin(ff_focus_angle));
assert(!ff_nema || _nema_y < upright_y0 - 1, "NEMA focus motor reaches the left upright plane: raise ff_focus_angle");
assert(!ff_nema || focus_cd - pm_slot - gt2m_flange_d / 2 > ring_out_r(focus_ring_od) + 2, "NEMA focus pulley too close to its ring");
assert(!ff_nema || focus_cd - pm_slot - (motor_boss_d + 1) / 2 - ffb_lens_r >= ff_plate_web, "NEMA focus plate: boss slot breaks into the lens hole");
assert(!ff_nema || ffn_shaft_l >= ffb_t + gt2m_gap + gt2m_hub_l, "NEMA shaft does not reach through the pulley hub: thinner plate or longer shaft");
echo(str("tilt ", tilt_ratio, ":1  pan ", pan_ratio, ":1  balls ", n_balls, "  ff ", ff_drive, "  focus ring N ", focus_gear_N, " zoom ring N ", zoom_gear_N,
    "  ratio ", ff_ratio_focus, " / ", ff_ratio_zoom, "  cd ", focus_cd, " / ", zoom_cd));
assert(stop_boss_z0 > stop_contact_z + 2, "stop boss would sit on the sector edge");
