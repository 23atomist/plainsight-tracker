# the-pan-v4 — fork-on-a-turntable pan/tilt/focus/zoom head for ADS-B aircraft tracking

3D-printable head for an IFWATER IF-USB16MP01-MFV 16 MP USB camera carrying a Nikon AF-S 70-300 mm
f/4.5-5.6G VR (800 g) through a 30 mm adapter. Pan on a printed 140 mm ball race, tilt 0..90 deg on
short steel trunnions in a low fork, focus by belt from a NEMA 17 pancake stepper (zoom manual; two-motor
TB35 belt and 28BYJ-48 gear sets are the alternatives), hard level stop at 0 deg
for calibration, IMU pad on top of the lens clamp.

Design reasoning: `docs/design.md`.
Everything dimensional is in `config.scad`. Rendered parts are in `build/stl/` (committed); `scripts/build.sh` also writes previews to `build/png/`.

## Why this one does not wobble

v2 carried the whole head on an 8 mm rod through two 608 bearings; the rod and the bearing play were
multiplied by a 100 mm lever. v4 has no column:

- **Pan:** 67 x 6 mm steel balls in 90 deg V grooves at 140 mm diameter between the deck and the
  platform. Tipping is resisted at a 70 mm radius. A retainer ring on the hollow centre tube
  (30 mm cable bore) catches lift-off.
- **Tilt:** the payload hangs between two A-frame uprights on 8 mm steel stubs in 608 bearings,
  at the optical-axis height. The fork is loaded in-plane, 10 mm thick, 90 mm wide at the foot.
- **Drives:** the tilt sector gear is printed into the cradle's left arm (no wheel on a shaft to
  slip); the pan ring gear is printed into the platform. Both pinions are the same 12T part.

## Numbers

| | Pan | Tilt | Focus / zoom |
|---|---|---|---|
| Ratio | 76:12 = 6.33 | 120:12 = 10 | NEMA (focus only): 132:20 = 6.6 on a 1.8 deg motor, 0.017 deg of ring per 1/16 microstep; TB35 belt: 132:20 / 140:20 (6.6 / 7.0) on a 22.3:1 geared motor; gear: 86:24 / 90:24 on a 64:1 28BYJ-48 |
| Per 1/16 microstep | 0.018 deg | 0.011 deg | well under 0.01 deg of ring either way |
| Travel | +/-180 (cable limited) | 0..90 deg (stop at 0, software limit at 90) | ring throw |
| Holding, 0.4 N m motor | 2.5 N m | 4 N m (payload is ~0.35 N m nose-heavy) | |

Optical axis is 220 mm above the housing feet. The deck, housing and platform are 200 / 200 / 184 mm
in diameter: you need a bed of at least 200 x 200 mm for those three.

## Focus / zoom drive: NEMA pancake, TB35 belt or gear

`ff_drive` in `config.scad` picks one for the assembly; `scripts/build.sh` writes every set of drive
parts, and the file suffix names the motor they are for: **`_nema17`** = NEMA 17 pancake, focus only,
**`_tb35`** = TB35 belt drive, **`_28byj`** = gear drive. Print one set (see the table below).

- **`"nema"` (default), parts `*_nema17`. Focus only; zoom stays manual.** One NEMA 17 pancake stepper
  (42.3 mm square, ~20-25 mm long, 1.8 deg, 5 mm D shaft >= 20 mm) with a stock metal **20T GT2 pulley for
  6 mm belt, 5 mm bore** (two grub screws) drives the same 132T focus ring with the same 2GT-350-6 belt.
  The motor sits above the lens at 70 deg, body forward: its face bolts to the front of a single slotted
  plate with 4 x M3 x 12 + washers from behind, the 22 mm boss in a slot, so the whole motor slides
  +-3 mm along the radius to tension the belt. The pulley goes on hub first, 1 mm off the plate; the grub
  screws are reachable from outside in the gap between the plate and the pulley flange. The focus ring is
  `ring_focus_nema17` (the same part as `ring_focus_tb35`). Motor current: pancakes are usually rated
  ~0.6-1.0 A; start with `run_current` 0.4 A RMS, more only if it skips.
- **`"belt"`, parts `*_tb35`.** Two 35 mm PM geared steppers (12 V, 60 ohm coils, 22.3:1, 5 mm D shaft centred
  on the can, M4 ears 42.5 mm apart). Their stock 1.5GT pulleys come off; each gets a printed 20T GT2
  pulley (`pulley_tb35`, D bore, a drop of CA on the flat). The shaft is short (4 mm past the face, with a
  14 mm boss 1 mm tall round it), so the pulley sits just above the boss and holds ~2.8 mm of shaft. The wire
  box is on the side of the can right next to one ear (2.5..8.5 mm above the ear line, 2-3 mm proud of the can),
  inside the bracket plate: each plate has a notch for it that joins the can slot, with room for the wires to
  bend forward through the plate. The lens rings get printed GT2 pulley rings
  (132T focus, 140T zoom) and each motor drives its ring with a stock closed GT2 belt, **2GT-350-6**
  (350 mm, 175 teeth, 6 mm wide). Both motors sit above the lens at 70 deg, cans forward, on slotted
  plates: slide a motor outward to tension its belt. Another stock length works if the asserts still
  pass (`belt_teeth_focus` / `belt_teeth_zoom`, traded against `ff_focus_angle` / `ff_zoom_angle`): too
  short and the zoom can slot breaks into its plate's lens hole, too long and a motor reaches an upright.
  The grooves on the rings and pulleys are an FDM approximation of the GT2 profile: print one pulley and
  one ring half first and check the belt seats in both; adjust `ff_groove_w` / `ff_groove_d` if not.
  Motor current: these coils are rated 0.2 A, so `run_current` ~0.14 A RMS on the TMC2209.
- **`"gear"`, parts `*_28byj`.** 28BYJ-48 (5 V version, converted to bipolar: cut the centre-tap trace under the blue
  cover, red wire unused) with printed 24T m1 pinions on m1 ring gears; motors beside the lens.

## Before printing: measure these

| Parameter | Default | What to check |
|---|---|---|
| `cam_h`, `cam_mount_x` | 50, 0 | camera case height; whether the 9 mm hole pair is centred under the case (shift it along X with `cam_mount_x`) |
| `lens_rear_barrel_d` | 76 | barrel diameter 5..30 mm in front of the flange (the saddle sits at X 28..60) |
| `focus_ring_x/w/od`, `zoom_ring_x/w/od` | 75/12/74, 100/28/79 | ring centres from the camera case front, widths, diameters. The names are as you gave them; on this lens the wide ring nearest the mount is normally the zoom ring, so swap the widths/ODs if that is what you measure |
| `switch_panel_x0/x1/protrude` | 35, 69, 4 | AF/VR switch panel extent (left side, 8..10 o'clock); saddle and clamp avoid it |
| `adapter_d` | 64 | adapter OD (spine top is at Z -35, clears r 32) |
| `m3_insert_*`, `m4_insert_*` | 4.0 x 6, 5.6 x 7 | your heat-set insert hole sizes |
| `ball_d` | 6 | ball diameter (6 mm steel or airsoft BBs) |
| `ffn_shaft_l`, `ffn_l`, `gt2m_*` | 20, 23, see config | NEMA pancake: shaft length from the face (must reach through the 8 mm plate, the 1 mm gap and the 7 mm pulley hub: >= 16) and body length; the stock pulley's hub and flange sizes |
| `pm_shaft_l`, `pm_boss_d/_h`, `pm_box_*`, `pm_flange_t` | 4, 14/1, see config, 1 | belt drive motor: shaft length and the boss round it (the pulley sits 0.2 mm above it); the wire box on the can side next to the +X ear (`pm_box_y0`/`_w` along the ear line's normal, `pm_box_h` proud of the can: sets the plate notch); ear flange thickness |

Then `scripts/build.sh` and `scripts/check_clearances.sh` (177 pair checks, fails on any overlap > 1 mm^3; they cover the `ff_drive` set in config.scad; `FF_DRIVE=belt scripts/check_clearances.sh` checks another).

## Files

```
config.scad                 all dimensions, derived values, asserts
lib/gears.scad              involute spur, internal and sector gears
lib/hardware.scad           inserts, 608 pocket, NEMA 17 / 28BYJ-48 / 35 mm PM patterns, GT2 belt band + belt loop, race groove, helpers
parts/*.scad                one printable part per file, each rendered in its print orientation
assembly.scad               whole head: -D tilt_angle=.. -D pan_angle=.. -D show_base=false
tests/clearance.scad        intersection of two named items (see item() in assembly.scad)
scripts/build.sh            renders all parts to build/stl + previews + assembly views
scripts/check_clearances.sh interference sweep over tilt -3..93 deg and ring-gear rotation
scripts/render.sh           render one part
```

## Printed parts (12 STLs + one focus/zoom drive set + 3 optional)

| Part | Qty | Prints | Notes |
|---|---|---|---|
| deck | 1 | as exported, underside down | race ridge + V groove, centre tube, pan motor slots, 6 x M4 counterbores |
| housing | 1 | as exported | 200 mm tube under the deck, 6 tabs with M4 inserts, 4 feet, cable slot |
| platform | 1 | top face down (exported so) | V groove, 76T internal gear skirt, dust lip, 8 x M4 inserts for the uprights |
| retainer | 1 | flat | ring on the tube, 3 x M3 countersunk |
| pinion_nema | 2 | hub down | 12T m1.25, D-bore, M3 insert for a set screw (pan and tilt) |
| upright_left | 1 | outer face down | 608 pocket (from the inside), pinion window, 4 slotted NEMA holes, level-stop ear + boss, switch holes |
| upright_right | 1 | outer face down | 608 pocket only |
| cradle_body | 1 | bottom down | camera shelf with rails and two M3 slots 9 mm apart (one access channel below), saddle block, inserts for clamp / arms / nose, counterweight holes |
| lens_clamp | 1 | IMU pad down | cap over the top of the barrel, two M3 x 16 through the legs, 5 mm grid of M2.5 holes for the IMU |
| arm_left | 1 | inner face down | 120T sector gear + hub, 4 x M4 to the block, M4 set screw for the stub |
| arm_right | 1 | inner face down | plain arm, same bolts |
| spacer | 2 | flat | 2 mm washer between arm and upright |
| controller_tray | 1 (optional) | flat, standoffs up | add-on plate under the housing: BTT SKR Pico V1.0 (turned 45 deg, USB-C pointing into the cavity) + Orange Pi Zero 2W on printed standoffs, vent slots, bolts to the four housing feet. 166 x 175 x 3 mm plate, no supports |
| tray_foot | 4 (optional) | flat | 16 x 8 mm puck under each tray corner, M4 head pocket on the bed side |
| tripod_spider | 1 (optional) | flat, bosses up | puts the head on a Celestron NexStar SE / Evolution tripod: 180 x 184 x 5 mm ring with four foot bosses (replaces the tray_foot pucks) and three hex pockets for 3/8-16 nuts on an 82 mm radius, the tripod's captive thumbscrews thread up into them; a 2 mm pad under each nut pocket fills the shallow recess around the thumbscrew. No supports |

### Focus / zoom drive parts: print the set for your motors

| Part | Qty | Prints | Notes |
|---|---|---|---|
| **NEMA 17 pancake set, focus only** (`ff_drive = "nema"`) | | | one NEMA 17 pancake + stock 20T GT2 pulley + one GT2 2GT-350-6 belt |
| nose_nema17 | 1 | keel down | keel + one motor plate (left, high), boss and M3 holes slotted for belt tension, 4 x M4 x 40 through the keel into the block |
| ring_focus_nema17 | 2 | lugs up | identical halves; 132T GT2 pulley ring with flanges (same part as ring_focus_tb35) |
| **TB35 belt set** (`ff_drive = "belt"`) | | | 35 mm PM geared steppers TB35-4-10.5 + GT2 2GT-350-6 belts |
| nose_tb35 | 1 | keel down | keel + focus (left) and zoom (right) motor plates, both high, slotted for belt tension, 4 x M4 x 60 through the keel into the block |
| ring_focus_tb35 | 2 | lugs up | identical halves; 132T GT2 pulley ring with flanges; each half has one insert lug and one through lug |
| ring_zoom_tb35 | 2 | lugs up | 140T GT2, same scheme |
| pulley_tb35 | 2 | flat flange down | 20T GT2, 6 mm belt, D bore for the 5 mm shaft, 4 mm across the flat; the 45 deg flange goes toward the motor. 0.12 mm layers, slow outer wall |
| **28BYJ-48 gear set** (`ff_drive = "gear"`) | | | 28BYJ-48 (5 V, bipolar mod) + printed spur gears |
| nose_28byj | 1 | keel down | keel + 28BYJ-48 brackets beside the lens, 4 x M4 x 40 through the keel into the block |
| ring_focus_28byj | 2 | lugs up | identical halves; 86T m1 ring gear, same lug scheme |
| ring_zoom_28byj | 2 | lugs up | 90T m1 ring gear, same scheme |
| pinion_28byj | 2 | hub down | 24T m1, double-D bore, M3 grub (self-tap) |

Print settings: PETG (or PLA+) 4 walls, 30 % gyroid for the big parts; gears and the race parts
(deck, platform) 5+ walls and 0.12-0.16 mm layers so the V grooves and teeth are smooth. Grease the
grooves. Nothing needs supports: the only bridges are the 608 lips (3 mm over a 9.5 mm hole) and the
counterweight holes.

## Hardware

| Item | Qty |
|---|---|
| NEMA 17, body <= 40 mm, 5 mm D shaft >= 22 mm | 2 (pan, tilt) |
| Focus motor, NEMA set: NEMA 17 pancake (42.3 mm square, 20-25 mm long), 5 mm D shaft >= 20 mm | 1 |
| Stock GT2 pulley, 20 teeth, 5 mm bore, for 6 mm belt (NEMA set) | 1 |
| M3 x 12 + washer (NEMA set) | 4, motor face to the plate, from behind through the slots |
| Focus/zoom motors, belt: 35 mm PM geared stepper TB35-4-10.5, 12 V 60 ohm, 22.3:1 (stock pulley removed) | 2 |
| GT2 closed-loop belt 2GT-350-6 (350 mm, 175T, 6 mm wide) | 1 (NEMA) / 2 (TB35) |
| (gear instead: 28BYJ-48, 5 V, converted to bipolar; no ULN2003, the TMC2209s drive them) | 2 |
| 608ZZ bearing | 2 |
| 8 mm steel rod, 2 x 22 mm, ends deburred | 2 stubs |
| 6 mm steel balls (or airsoft BBs) | 67 + spares |
| M3 heat-set inserts | 11: clamp 2, retainer/tube 3, ring-gear lugs 4, pinion set screws 2 |
| M4 heat-set inserts | 29 (+4 for the gear drive's motor ears): platform feet 8, housing tabs 6, arm bolts 8, nose 4, stub set screws 2, level stop 1 |
| M3 x 12 | 4, pan motor through the deck |
| M3 x 14 | 4, tilt motor through the upright (heads in the counterbores on the inner face) |
| M3 x 16 | 6: lens clamp 2, ring-gear clamps 4 |
| M3 x 10 countersunk | 3, retainer |
| M3 x 5 set/grub screws | 2: NEMA pinions (+2 for the gear drive's 28BYJ pinions, self-tapped) |
| M4 x 16 | 16: uprights to platform 8, arms to block 8 |
| M4 x 60 socket head (NEMA and gear: M4 x 40) | 4, nose to block (through the whole keel, heads on its front face) |
| M4 x 10 | 6, deck to housing |
| M4 x 14 + washer + nut | 4, belt motor ears through the plate slots, washer and nut on the can side (gear: M4 x 8 into inserts) |
| M4 x 20 | 1, level stop |
| M4 x 6 set screws | 2, stubs |
| M8 bolts + nuts (optional counterweight) | 2 stacks |
| 1-2 mm foam / rubber tape | saddle and clamp |
| Lever microswitch (optional homing) | 1, 2 x M2.5 |
| **Controller tray (optional):** M4 x 25 + M4 nut | 4, up through the tray_foot pucks, the tray and the housing foot slots |
| M2.5 x 6 self-tapping (or M2.5 x 8 with the board's own standoffs removed) | 8, boards onto the printed standoffs |
| **Tripod spider (optional):** 3/8-16 hex nut (9/16" AF; a jam nut also fits) | 3, dropped into the pockets; the tripod's own thumbscrews do the clamping |

## Assembly order

1. Set all inserts (M3 and M4 lists above) with a soldering iron, flush with the faces.
2. **Base.** Fit a 12T pinion on the pan NEMA (hub toward the motor, set screw on the flat).
   Hold the motor under the deck with 4 x M3 x 12 through the slots, loosely. Bolt the housing under
   the deck (6 x M4 x 10 from the top). Push the motor outward until the pinion meshes the
   platform's gear with just no play (test with the platform on), tighten.
3. Grease the deck groove, drop in 67 balls, lower the platform (notch toward the lens side), screw
   the retainer onto the tube (3 x M3 countersunk). The platform should spin freely with no rock.
4. **Fork.** Press a 608 into each upright from the inner face. Pinion on the tilt NEMA; bolt the
   motor to the outside of the left upright with 4 x M3 x 14 from the inner face through the slots,
   loose. Bolt both uprights to the platform (8 x M4 x 16): left upright on the +Y side (camera-left
   as seen from behind).
5. **Cradle.** Camera on the shelf between the rails, two M3 screws up through the access channel from
   below into its 9 mm-pitch holes; slide it fore/aft in the slots to balance before tightening. Bolt the arms to the block sides (8 x M4 x 16; the sector arm goes on the +Y side).
   Tape the saddle, seat the lens, fit the clamp cap (2 x M3 x 16 down through the legs). Clamp the
   ring halves on the rings (each joint: one insert lug + one through lug, M3 x 16). Belt drive: slip
   each belt over the front of the lens onto its ring **before** the nose goes on, then bolt the nose
   to the block front (4 x M4 x 60 in from the front face of the keel, straight through keel and
   flange into the block inserts; a long hex key or a 3 mm hex bit reaches the heads under the lens),
   press a printed pulley onto each motor shaft (45 deg flange first, flat to flat, two layers of paper between it and the boss so it can't rub, then pull the paper and put a drop of CA on the flat), push each can forward through its plate from behind with the wire box in the plate's notch (it only fits one way: box away from the lens; bend the wires forward through the notch), loop the belt over the pulley, and pull the
   motor outward in its slots until the belt is snug (it should twist about 90 deg mid-span, no more),
   then tighten the ear screws. NEMA (focus only): belt over the front of the lens onto the focus ring, nose
   on with 4 x M4 x 40, pulley on the shaft hub first (hub toward the motor) but leave the grub screws loose;
   hold the motor face against the front of the plate (boss in its slot, wires pointing away from the lens),
   4 x M3 x 12 + washers from behind, loose; push the pulley back until its hub is 1 mm off the plate and the
   belt lines up with the ring, grub screws on the flat; pull the motor outward until the belt is snug and
   tighten the M3s. Gear drive: motors on the brackets (M4 x 8), pinions on their shafts
   (hub toward the plate), nose with 4 x M4 x 40.
6. Lower the cradle between the uprights with a spacer on each side. Push each 8 mm stub in **from
   the outside** through the bearing lip hole, bearing and spacer into the arm bore until it is 1 mm
   below the upright's outer face; tighten the arm's M4 set screw.
7. Slide the tilt motor in its slots until the pinion meshes the sector with light backlash, tighten.
8. **Level.** Let the nose drop onto the stop screw. Put a level (or read the IMU) on the pad and
   turn the M4 x 20 stop screw until the optical axis is level; one turn is ~1.3 deg. Home the tilt
   against this stop (stall detection or the optional microswitch), home pan with an index of
   your choice.
9. Cables (USB, the two focus/zoom motor leads, IMU) go down the 30 mm tube into the housing and out the slot.
   Leave a loop for +/-180 deg of pan. Balance the tilt with M8 nut stacks on the rear bars if
   the motor warms up holding the nose.
10. **Controller tray (optional).** Screw the SKR Pico onto the four standoffs of the diagonal
    slotted field (M2.5 self-tap): the board sits at 45 deg with its USB-C / power-terminal end
    pointing into the middle of the housing (toward +X/-Y, beside the pan motor, so the plug and its
    cable have the whole cavity instead of running into the wall) and the stepper connectors facing
    the pan motor; the Orange Pi Zero 2W onto the two-slot field with its USB-C / HDMI edge facing
    outward (-Y, away from the SKR). Plug in the camera USB, the SKR
    USB-C and the stepper leads while the tray is still off, then offer the tray up under the
    housing with its corner holes under the four feet, a tray_foot puck under each corner (head
    pocket down), and run an M4 x 25 up through puck, tray and foot slot, nut on top of the foot. The
    pucks are the feet; nothing else touches the ground, so the vent slots breathe. The boards sit either side of the pan motor, >= 3 mm clear of its body in
    plan (they share height with the bottom of the motor, so keep them out from under it if you
    move them in `config.scad`). To get at the microSD
    card, undo the four M4s; if you want to bolt the head to a surface, leave the pucks off and run the four
    M4s the other way (from the top, through foot and tray) into it.
11. **Tripod spider (optional).** Drop a 3/8-16 nut into each of the three hex pockets. Use the
    spider instead of the four tray_foot pucks: offer it up under the tray with its four bosses under the
    tray corners (the ring's single nut boss toward -Y, the camera's right when panned 0) and run the
    same four M4 x 25 up through spider, tray and foot slot, nut on top of the foot (M4 x 20 is enough here).
    Without the tray set `tripod_with_tray = false` before printing: the bosses grow 3 mm so the housing
    feet land on them directly. Set the head on the tripod with the alignment pin in the centre hole and the
    three thumbscrews under the nut bosses, then tighten the thumbscrews from below; the nuts cannot turn in
    their pockets and are pulled down onto the pocket floors. The three pads under the nut pockets sit in the
    shallow recesses around the thumbscrews (`tripod_recess_d`, set it to the deepest one); the ring itself
    rests on the flat centre of the head. The pin must stand no more than 12 mm above the head top (lower it
    with a screwdriver if it does) and the thumbscrew threads at least 6.5 mm above the recess floor, all
    `MEASURE` in `config.scad`.

## IMU

The pad on top of the lens clamp is ~150 mm from the tilt NEMA and ~230 mm from the pan NEMA, both
of which move relative to the sensor, so their stray field changes little. The focus and zoom motors
ride with the IMU, so their field is a constant hard-iron offset that calibration removes. Mount the
breakout with M2.5 self-tappers in the 5 mm grid; the pad is parallel to the optical axis.

## Known limits

- Pan is not continuous (no slip ring).
- No weather sealing; the housing only covers the pan drive. With the controller tray fitted the
  housing is closed except for the cable slot and the tray's vent slots; the TMC2209s on the SKR
  Pico are fine at the currents these motors need, but check the board temperature on a hot day.
- The Orange Pi Zero 2W hole pattern (58 x 23, Pi Zero footprint) is assumed, not measured.
- Tripod spider: the 82 mm bolt radius is measured; the alignment pin size / height and how far the
  thumbscrew threads stand above the head are forum values. The recess around each thumbscrew is taken
  as 2 mm deep (user estimate 1-2 mm); the rest of the head top is flat.
- The printed race needs grease and a few hundred turns to bed in; expect it to loosen slightly.
- There is no mechanical stop at 90 deg; the sector keeps the pinion engaged to 93 deg, so limit in
  firmware.
- Ring diameters, the camera height and the switch-panel extent are assumptions until measured.

## License

CERN-OHL-P v2, see [LICENSE](LICENSE). Copyright (c) 2026 Thomas Gallaway.
