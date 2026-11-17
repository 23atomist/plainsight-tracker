#pragma once
#include <stddef.h>
#include <stdint.h>
#include "pins.h"

// Per-axis configuration. Positions/speeds are in "units" of the output
// shaft: with units_per_rev = 360 (the default) that is degrees.
struct AxisSettings {
  float units_per_rev;  // output units per output revolution
  float gear;           // motor revolutions per output revolution
  float vmax;           // units/s
  float amax;           // units/s^2
  float min_pos;        // soft limits; ignored when max_pos <= min_pos
  float max_pos;
  float period;         // angle equivalence for target selection (360 for pan), 0 = none
  float run_current;    // A rms
  float hold_current;   // A rms
  float home_speed;     // units/s
  float home_backoff;   // units
  float home_pos;       // position assigned at the endstop, units
  uint16_t fullsteps;   // motor full steps per revolution
  uint16_t microsteps;  // 1..256, power of two
  int8_t home_dir;      // -1/+1 direction of the endstop, 0 = no endstop
  uint8_t endstop_invert;
  uint8_t invert;       // reverse motor direction
  uint8_t stealth;      // 1 = stealthChop (quiet), 0 = spreadCycle
  uint8_t sgthrs;       // StallGuard threshold for DIAG output, 0 = off
  uint8_t socket;       // driver socket 0..3 = X,Y,Z,E; applied at boot
  uint8_t _pad[2];
  float backlash;       // units of slack taken up on each reversal (v3)
};

struct Settings {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  AxisSettings axis[NUM_AXES];
  uint32_t track_timeout_ms;  // TRACK without a fresh update for this long -> stop
  uint32_t host_baud;         // Pi-header UART baud, applied at boot
  uint8_t enable_on_boot;
  uint8_t _pad[3];
  uint32_t crc;
};

constexpr size_t EEPROM_BYTES = 512;
static_assert(sizeof(Settings) <= EEPROM_BYTES, "Settings outgrew the EEPROM reservation");

extern Settings g_settings;

void settingsDefaults(Settings &s);
bool settingsLoad();  // false -> no valid copy in flash, defaults applied
void settingsSave();

// Pins of the socket each axis drives. Fixed at boot by settingsResolveSockets():
// the "socket" settings if they name four different sockets, else X,Y,Z,E.
extern AxisPins g_axis_pins[NUM_AXES];
extern uint8_t g_axis_socket[NUM_AXES];
bool settingsResolveSockets();

inline float stepsPerUnit(const AxisSettings &a) {
  return a.fullsteps * a.microsteps * a.gear / a.units_per_rev;
}
inline bool hasLimits(const AxisSettings &a) { return a.max_pos > a.min_pos; }

// Key table for the CFG command.
enum class KeyType : uint8_t { F32, U8, I8, U16, U32 };
enum KeyEffect : uint8_t { FX_NONE = 0, FX_DRIVER = 1, FX_GEOMETRY = 2 };

struct KeyDef {
  const char *name;
  KeyType type;
  uint16_t offset;
  uint8_t effects;
  float lo, hi;
};

extern const KeyDef AXIS_KEYS[];
extern const int NUM_AXIS_KEYS;
extern const KeyDef GLOBAL_KEYS[];
extern const int NUM_GLOBAL_KEYS;

const KeyDef *findKey(const KeyDef *table, int n, const char *name);
float keyGet(const KeyDef &k, const void *base);
void keySet(const KeyDef &k, void *base, float v);
