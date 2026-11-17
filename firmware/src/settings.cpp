#include "settings.h"

#include <EEPROM.h>
#include <math.h>
#include <string.h>
#include <strings.h>

Settings g_settings;

static constexpr uint32_t MAGIC = 0x315A5450;  // "PTZ1"
static constexpr uint16_t VERSION = 3;

// Version 2 layout: AxisSettings without the trailing backlash. Kept so a
// saved v2 configuration is migrated instead of replaced by defaults.
static constexpr size_t AXIS_V2_BYTES = offsetof(AxisSettings, backlash);
struct SettingsV2 {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  uint8_t axis[NUM_AXES][AXIS_V2_BYTES];
  uint32_t track_timeout_ms;
  uint32_t host_baud;
  uint8_t enable_on_boot;
  uint8_t _pad[3];
  uint32_t crc;
};

static uint32_t fnv1a(const void *data, size_t n) {
  const uint8_t *p = static_cast<const uint8_t *>(data);
  uint32_t h = 2166136261u;
  while (n--) h = (h ^ *p++) * 16777619u;
  return h;
}

static AxisSettings axisDefaults(float vmax, float amax, float lo, float hi, float period,
                                 float irun, float ihold) {
  AxisSettings a{};
  a.units_per_rev = 360.0f;
  a.gear = 1.0f;
  a.fullsteps = 200;
  a.microsteps = 16;
  a.vmax = vmax;
  a.amax = amax;
  a.min_pos = lo;
  a.max_pos = hi;
  a.period = period;
  a.run_current = irun;
  a.hold_current = ihold;
  a.home_speed = 10.0f;
  a.home_backoff = 3.0f;
  a.home_pos = 0.0f;
  a.home_dir = 0;
  a.stealth = 1;
  return a;
}

void settingsDefaults(Settings &s) {
  memset(&s, 0, sizeof s);
  s.magic = MAGIC;
  s.version = VERSION;
  s.size = sizeof s;
  // Gentle until the real mechanics are configured: gear ratios of 1 (so
  // units are motor degrees), slow soft ramps, modest currents, and small
  // currents for small lens motors.
  s.axis[0] = axisDefaults(10, 20, -180, 180, 360, 0.6f, 0.3f);  // pan
  s.axis[1] = axisDefaults(10, 20, -10, 90, 0, 0.6f, 0.3f);      // tilt
  s.axis[2] = axisDefaults(30, 60, 0, 0, 0, 0.3f, 0.15f);        // zoom
  s.axis[3] = axisDefaults(30, 60, 0, 0, 0, 0.3f, 0.15f);        // focus
  for (int i = 0; i < NUM_AXES; i++) s.axis[i].socket = i;
  s.track_timeout_ms = 3000;
  s.host_baud = 115200;
  s.enable_on_boot = 0;
}

bool settingsLoad() {
  Settings tmp;
  EEPROM.get(0, tmp);
  if (tmp.magic == MAGIC && tmp.version == VERSION && tmp.size == sizeof tmp &&
      tmp.crc == fnv1a(&tmp, offsetof(Settings, crc))) {
    g_settings = tmp;
    return true;
  }
  SettingsV2 v2;
  EEPROM.get(0, v2);
  if (v2.magic == MAGIC && v2.version == 2 && v2.size == sizeof v2 &&
      v2.crc == fnv1a(&v2, offsetof(SettingsV2, crc))) {
    settingsDefaults(g_settings);
    for (int i = 0; i < NUM_AXES; i++) memcpy(&g_settings.axis[i], v2.axis[i], AXIS_V2_BYTES);
    g_settings.track_timeout_ms = v2.track_timeout_ms;
    g_settings.host_baud = v2.host_baud;
    g_settings.enable_on_boot = v2.enable_on_boot;
    return true;  // in RAM as v3; written on the next SAVE
  }
  settingsDefaults(g_settings);
  return false;
}

void settingsSave() {
  g_settings.crc = fnv1a(&g_settings, offsetof(Settings, crc));
  EEPROM.put(0, g_settings);
  EEPROM.commit();  // pauses core 1 while flash is erased: only call when stopped
}

AxisPins g_axis_pins[NUM_AXES];
uint8_t g_axis_socket[NUM_AXES];

bool settingsResolveSockets() {
  unsigned used = 0;
  for (const AxisSettings &a : g_settings.axis) used |= 1u << (a.socket & 3);
  bool valid = used == (1u << NUM_AXES) - 1;
  for (int i = 0; i < NUM_AXES; i++) {
    g_axis_socket[i] = valid ? g_settings.axis[i].socket : i;
    g_axis_pins[i] = SOCKET_PINS[g_axis_socket[i]];
  }
  return valid;
}

#define AK(key, field, type, fx, lo, hi) \
  {key, KeyType::type, (uint16_t)offsetof(AxisSettings, field), fx, lo, hi}

const KeyDef AXIS_KEYS[] = {
    AK("units_per_rev", units_per_rev, F32, FX_GEOMETRY, 0.001f, 1e6f),
    AK("gear", gear, F32, FX_GEOMETRY, 0.001f, 1e4f),
    AK("fullsteps", fullsteps, U16, FX_GEOMETRY, 1, 1000),
    AK("microsteps", microsteps, U16, FX_GEOMETRY | FX_DRIVER, 1, 256),
    AK("invert", invert, U8, FX_GEOMETRY, 0, 1),
    AK("vmax", vmax, F32, FX_NONE, 0.001f, 1e6f),
    AK("amax", amax, F32, FX_NONE, 0.001f, 1e7f),
    AK("min", min_pos, F32, FX_NONE, -1e6f, 1e6f),
    AK("max", max_pos, F32, FX_NONE, -1e6f, 1e6f),
    AK("period", period, F32, FX_NONE, 0, 1e6f),
    AK("run_current", run_current, F32, FX_DRIVER, 0.05f, 2.0f),
    AK("hold_current", hold_current, F32, FX_DRIVER, 0, 2.0f),
    AK("stealth", stealth, U8, FX_DRIVER, 0, 1),
    AK("sgthrs", sgthrs, U8, FX_DRIVER, 0, 255),
    AK("socket", socket, U8, FX_NONE, 0, 3),
    AK("home_dir", home_dir, I8, FX_NONE, -1, 1),
    AK("endstop_invert", endstop_invert, U8, FX_NONE, 0, 1),
    AK("home_speed", home_speed, F32, FX_NONE, 0.001f, 1e6f),
    AK("home_backoff", home_backoff, F32, FX_NONE, 0, 1e6f),
    AK("home_pos", home_pos, F32, FX_NONE, -1e6f, 1e6f),
    AK("backlash", backlash, F32, FX_NONE, 0, 1e4f),
};
const int NUM_AXIS_KEYS = sizeof AXIS_KEYS / sizeof AXIS_KEYS[0];

#define GK(key, field, type, lo, hi) \
  {key, KeyType::type, (uint16_t)offsetof(Settings, field), FX_NONE, lo, hi}

const KeyDef GLOBAL_KEYS[] = {
    GK("track_timeout_ms", track_timeout_ms, U32, 50, 600000),
    GK("host_baud", host_baud, U32, 1200, 1000000),
    GK("enable_on_boot", enable_on_boot, U8, 0, 1),
};
const int NUM_GLOBAL_KEYS = sizeof GLOBAL_KEYS / sizeof GLOBAL_KEYS[0];

const KeyDef *findKey(const KeyDef *table, int n, const char *name) {
  for (int i = 0; i < n; i++)
    if (strcasecmp(table[i].name, name) == 0) return &table[i];
  return nullptr;
}

float keyGet(const KeyDef &k, const void *base) {
  const uint8_t *p = static_cast<const uint8_t *>(base) + k.offset;
  switch (k.type) {
    case KeyType::F32: return *reinterpret_cast<const float *>(p);
    case KeyType::U8: return *p;
    case KeyType::I8: return *reinterpret_cast<const int8_t *>(p);
    case KeyType::U16: return *reinterpret_cast<const uint16_t *>(p);
    case KeyType::U32: return *reinterpret_cast<const uint32_t *>(p);
  }
  return 0;
}

void keySet(const KeyDef &k, void *base, float v) {
  uint8_t *p = static_cast<uint8_t *>(base) + k.offset;
  switch (k.type) {
    case KeyType::F32: *reinterpret_cast<float *>(p) = v; break;
    case KeyType::U8: *p = (uint8_t)lroundf(v); break;
    case KeyType::I8: *reinterpret_cast<int8_t *>(p) = (int8_t)lroundf(v); break;
    case KeyType::U16: *reinterpret_cast<uint16_t *>(p) = (uint16_t)lroundf(v); break;
    case KeyType::U32: *reinterpret_cast<uint32_t *>(p) = (uint32_t)lroundf(v); break;
  }
}
