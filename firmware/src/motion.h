#pragma once
#include <stdint.h>
#include "pins.h"
#include "settings.h"

// Motion control. Core 1 runs a fixed 50 kHz step generator and does nothing
// else; core 0 runs a 1 kHz planner that turns position / velocity / tracking
// targets into a step rate per axis, honouring vmax, amax and soft limits.
//
// All public functions are core-0 only. Positions and speeds are in axis
// units (see AxisSettings). Commands return nullptr on success or a short
// error string.
namespace motion {

enum class Mode : uint8_t { Idle, Position, Velocity, Homing };

void begin();     // core 0, before core 1 starts stepping
void core1Run();  // core 1 entry point, never returns
void update();    // core 0 loop(), self-paced to the planner rate

void enable(bool on);
bool enabled();

const char *moveTo(int ax, float pos);
const char *moveBy(int ax, float delta);
const char *track(int ax, float pos, float vel);  // pos is "now", vel in units/s
const char *jog(int ax, float vel);
void stop(int ax);  // decelerate to a stop
void estop();       // stop every axis immediately, no deceleration
const char *home(int ax);
const char *setPosition(int ax, float pos);

// Call after changing geometry keys (gear, microsteps, ...) with the axis
// settings that were in force before the change. Keeps the physical position
// (only a microsteps change rescales the step count), so the reported
// position shows the same place in the new units. Clears the homed flag.
void geometryChanged(int ax, const AxisSettings &before);

float position(int ax);
float velocity(int ax);
float target(int ax);
Mode mode(int ax);
bool tracking(int ax);
bool homed(int ax);
bool endstop(int ax);
bool moving(int ax);
bool anyMoving();

}  // namespace motion
