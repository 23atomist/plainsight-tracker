# the-pan-v4 — fork-on-a-turntable pan/tilt/focus/zoom head

Date: 2026-10-19. Design handed to Claude in full ("it's all yours"); every choice below is
Claude's call unless marked *given*.

## Intent

Track ADS-B aircraft with an IFWATER 16 MP USB camera carrying a Nikon AF-S 70-300 G VR
(800 g) through a 30 mm adapter (*given*). Pan, tilt 0..90 deg (level to zenith, *given*),
motorised focus and zoom (*given*), a 9-DOF IMU kept away from motors (*given*), hard level
stop for calibration (*given*). Output: OpenSCAD -> STL, M3/M4/M5 heat-set inserts (*given*).

## Why v2 wobbled, and what changes

v2 carried ~1.5 kg on an 8 mm rod through two 608 bearings 40 mm apart, with the yoke another
100 mm above. The rod/bearing stack is a slender column; every bit of bearing play and rod
flex is multiplied by that lever. v4 removes the column entirely:

1. **Pan on a large printed ball race.** 68 x 6 mm steel balls run in 90 deg V grooves at
   140 mm pitch diameter between the fixed deck and the rotating platform. Tipping moment is
   resisted at a 70 mm radius instead of at an 8 mm shaft. A hollow centre tube (30 mm bore)
   carries cables; a retainer ring on the tube catches lift-off.
2. **Tilt on short trunnions in a low, wide fork.** The lens cradle has stub axles (8 mm
   steel) at the optical-axis height, running in 608 bearings pressed into two A-frame
   uprights bolted to the platform. The payload sits *between* the uprights, so the fork is
   loaded in-plane, not as a cantilever.
3. **Tilt drive printed into the cradle.** The left trunnion arm is a 120-tooth, module 1.25
   sector gear (114 deg of arc). A 12-tooth pinion on a NEMA 17 reaches it through a window in
   the upright: 10:1, 0.011 deg per 1/16 microstep, no separate wheel to slip on a shaft.
4. **Pan drive by internal ring gear.** The platform skirt is a 76-tooth internal gear driven
   by the same 12-tooth pinion on a NEMA 17 hanging under the deck: 6.3:1, 0.018 deg per
   1/16 microstep. Motor screw slots set the backlash.
5. **Level stop.** An M4 screw in a boss on the left upright stops the sector arm at exactly
   0 deg; turning it trims level by ~0.6 deg per turn. Power off = the nose drops onto the stop.

## Payload layout (axis frame: origin at camera front face / optical axis, +X lens, +Y camera-left, +Z up)

- Camera case X -47..0 on a shelf; the 30 mm adapter; lens flange at X 30; rear barrel D76
  X 30..69; focus ring (D74 x 12) centred X 75; zoom ring (D79 x 28) centred X 100 (*given*,
  ring names as given; v2 flagged these as unmeasured).
- Saddle block X 28..61 contacts the rear barrel on the bottom +/-45 deg only; above that the
  block steps out to r 45 so the AF/VR switch panel on the left (8..10 o'clock) is never
  touched (*given*: "not round before the focus ring").
- Clamp cap over the top +/-45 deg, two M3 into inserts in the block ledges (Y +/-47), IMU pad
  on top of the cap (~150 mm from the tilt NEMA, ~230 mm from the pan NEMA; the two small
  focus/zoom steppers ride with the IMU so their field is a constant hard-iron offset).
- Tilt pivot X 51, Z 0. Estimated payload CG X ~75, so the nose is ~0.35 N m heavy; two
  D8.4 cross holes at the rear take M8 bolt stacks as counterweight. Motor holds 4 N m anyway.
- Trunnion arms bolt to the block sides (Y +/-52), plates Y 52..62. Uprights Y 64..74.
- Focus and zoom: clamp-on half ring gears (module 1) driven by 24T pinions on 28BYJ-48
  steppers at 3 and 9 o'clock, bodies forward, on brackets that rise from a keel under the
  lens bolted to the saddle block's front face.

## Turntable (base frame: pan axis = Z, deck floor top = 0)

Deck D200 x 8 with race ridge (R 62..80, 10 tall, groove at R 70), centre tube R 15..23,
pinion hole at r 40, 4 slotted NEMA 17 holes. Platform D184 x 10, groove underneath, gear
skirt R 46..53 x 9, dust lip R 81..85. Housing D200 x 55 under the deck for the motor and
driver, cable slot at the rear. Pan axis directly under the tilt pivot.

## Non-goals

Continuous pan (cables limit to +/-180), weather sealing, electronics, firmware.

## Left to the builder (you)

Bench-measure: ring diameters/widths/positions, camera height and hole pattern, barrel
diameter under the saddle. All are in `config.scad`; run `scripts/check_clearances.sh` after
any change.
