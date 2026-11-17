#pragma once
#include <Print.h>

// TMC2209 configuration over the board's shared single-wire UART.
//
// The drivers only answer while motor power (VM) is present, and forget their
// registers when it drops, so update() polls each one and re-sends the
// configuration whenever a driver appears or reports a reset.
namespace drivers {

void begin();
void update();             // core 0 loop(); blocks ~3 ms every 250 ms
void reconfigure(int ax);  // after a driver-related setting changed
bool online(int ax);
void report(Print &out, int ax);  // DRV command
void rawProbe(Print &out, uint32_t baud);  // DRV RAW: bus-level wiring check

}  // namespace drivers
