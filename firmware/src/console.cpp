#include "console.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "drivers.h"
#include "motion.h"
#include "pico/bootrom.h"
#include "settings.h"
#include "version.h"

static constexpr int MAX_ARGS = 16;

static bool is(const char *a, const char *b) { return strcasecmp(a, b) == 0; }

// arduino-pico's printf family has no %f support, so format floats by hand.
// trim drops trailing zeros (for config values).
static int fmtFloat(char *out, size_t n, float v, int decimals, bool trim = false) {
  static const uint32_t POW10[] = {1, 10, 100, 1000, 10000, 100000, 1000000};
  if (!isfinite(v)) return snprintf(out, n, "nan");
  uint32_t scale = POW10[decimals];
  bool neg = v < 0;
  uint64_t fixed = (uint64_t)llround(fabs((double)v) * scale);
  uint32_t frac = (uint32_t)(fixed % scale);
  unsigned long whole = (unsigned long)(fixed / scale);  // settings are bounded to 1e7
  if (trim)
    while (decimals > 0 && frac % 10 == 0) frac /= 10, decimals--;
  if (decimals == 0) return snprintf(out, n, "%s%lu", neg && whole ? "-" : "", whole);
  return snprintf(out, n, "%s%lu.%0*lu", neg && fixed ? "-" : "", whole, decimals, (unsigned long)frac);
}

static int parseAxis(const char *s) {
  static const char *const alias[NUM_AXES][3] = {
      {"pan", "p", "x"}, {"tilt", "t", "y"}, {"zoom", "z", "z"}, {"focus", "f", "e"}};
  for (int i = 0; i < NUM_AXES; i++)
    for (const char *a : alias[i])
      if (is(s, a)) return i;
  return -1;
}

static bool parseFloat(const char *s, float &out) {
  char *end;
  out = strtof(s, &end);
  return end != s && *end == '\0' && isfinite(out);
}

// "<axis> <v1> [<v2>] <axis> <v1> [<v2>] ..." -> validated groups.
struct Group {
  int ax;
  float v[2];
};

static const char *parseGroups(int argc, char **argv, int nvals, Group *out, int &count) {
  count = 0;
  if (argc < 1 + nvals || argc % (1 + nvals) != 0) return "bad_arguments";
  for (int i = 0; i < argc; i += 1 + nvals) {
    Group &g = out[count++];
    g.ax = parseAxis(argv[i]);
    if (g.ax < 0) return "unknown_axis";
    for (int j = 0; j < nvals; j++)
      if (!parseFloat(argv[i + 1 + j], g.v[j])) return "bad_number";
  }
  return nullptr;
}

// Axis list for STOP/HOME; empty or "all" selects every axis.
static const char *parseAxisMask(int argc, char **argv, unsigned &mask) {
  mask = 0;
  if (argc == 0) mask = (1u << NUM_AXES) - 1;
  for (int i = 0; i < argc; i++) {
    if (is(argv[i], "all")) {
      mask = (1u << NUM_AXES) - 1;
      continue;
    }
    int ax = parseAxis(argv[i]);
    if (ax < 0) return "unknown_axis";
    mask |= 1u << ax;
  }
  return nullptr;
}

static void printKey(Print &out, const char *scope, const KeyDef &k, const void *base) {
  char val[24];
  fmtFloat(val, sizeof val, keyGet(k, base), 6, true);
  out.printf("C %s %s %s\r\n", scope, k.name, val);
}

static const char *setAxisKey(int ax, const KeyDef &k, float v) {
  if (v < k.lo || v > k.hi) return "out_of_range";
  if (k.offset == offsetof(AxisSettings, microsteps)) {
    int m = (int)lroundf(v);
    if (m < 1 || (m & (m - 1))) return "microsteps_must_be_power_of_2";
  }
  if ((k.effects & FX_GEOMETRY) && motion::moving(ax)) return "axis_moving";
  AxisSettings &a = g_settings.axis[ax];
  const AxisSettings before = a;
  keySet(k, &a, v);
  if (k.effects & FX_GEOMETRY) motion::geometryChanged(ax, before);
  if (k.effects & FX_DRIVER) drivers::reconfigure(ax);
  return nullptr;
}

static const char *cmdConfig(Print &out, int argc, char **argv) {
  if (argc == 0) {
    for (int ax = 0; ax < NUM_AXES; ax++)
      for (int k = 0; k < NUM_AXIS_KEYS; k++) printKey(out, AXIS_NAMES[ax], AXIS_KEYS[k], &g_settings.axis[ax]);
    for (int k = 0; k < NUM_GLOBAL_KEYS; k++) printKey(out, "global", GLOBAL_KEYS[k], &g_settings);
    return nullptr;
  }
  bool global = is(argv[0], "global");
  int ax = global ? -1 : parseAxis(argv[0]);
  if (!global && ax < 0) return "unknown_axis";
  const KeyDef *table = global ? GLOBAL_KEYS : AXIS_KEYS;
  int n = global ? NUM_GLOBAL_KEYS : NUM_AXIS_KEYS;
  void *base = global ? (void *)&g_settings : (void *)&g_settings.axis[ax];
  const char *scope = global ? "global" : AXIS_NAMES[ax];

  if (argc == 1) {
    for (int k = 0; k < n; k++) printKey(out, scope, table[k], base);
    return nullptr;
  }
  const KeyDef *k = findKey(table, n, argv[1]);
  if (!k) return "unknown_key";
  if (argc == 2) {
    printKey(out, scope, *k, base);
    return nullptr;
  }
  if (argc != 3) return "bad_arguments";
  float v;
  if (!parseFloat(argv[2], v)) return "bad_number";
  if (global) {
    if (v < k->lo || v > k->hi) return "out_of_range";
    keySet(*k, base, v);
    return nullptr;
  }
  const char *err = setAxisKey(ax, *k, v);
  if (!err && k->offset == offsetof(AxisSettings, socket))
    out.print("# socket takes effect after SAVE and REBOOT; the four axes must use different sockets\r\n");
  return err;
}

// Reload every axis from g_settings after LOAD/DEFAULTS replaced it.
static void applyAllSettings(const Settings &before) {
  for (int ax = 0; ax < NUM_AXES; ax++) {
    motion::geometryChanged(ax, before.axis[ax]);
    drivers::reconfigure(ax);
  }
}

static const char *const HELP[] = {
    "# axes: pan|p|x tilt|t|y zoom|z focus|f|e   units: degrees unless reconfigured",
    "# MOVE <ax> <pos> [...]          absolute move           (alias M)",
    "# MOVER <ax> <delta> [...]       relative move           (alias MR)",
    "# TRACK <ax> <pos> <vel> [...]   follow a moving target  (alias T)",
    "# JOG <ax> <vel> [...]           constant velocity       (alias J)",
    "# STOP [ax...|all]               decelerate to a stop    (alias S)",
    "# ESTOP                          stop instantly          (alias X)",
    "# HOME [ax...|all]               endstop homing",
    "# SETPOS <ax> <pos>              declare current position",
    "# ENABLE [0|1]                   motor drivers on/off",
    "# STATUS                         one status line         (alias ?)",
    "# STREAM <ms>                    periodic *S status, 0 = off",
    "# CFG [ax|global [key [value]]]  view / change settings",
    "# SAVE | LOAD | DEFAULTS         settings in flash",
    "# DRV [ax]                       TMC2209 diagnostics",
    "# VER | HELP | REBOOT | BOOTSEL",
};

void Console::printStatus(const char *prefix) {
  char pos[64], vel[64], tgt[64], modes[NUM_AXES + 1], hm[NUM_AXES + 1], es[NUM_AXES + 1], drv[NUM_AXES + 1];
  int pp = 0, pv = 0, pt = 0;
  for (int i = 0; i < NUM_AXES; i++) {
    if (i) pos[pp++] = vel[pv++] = tgt[pt++] = ',';
    pp += fmtFloat(pos + pp, sizeof pos - pp, motion::position(i), 4);
    pv += fmtFloat(vel + pv, sizeof vel - pv, motion::velocity(i), 4);
    pt += fmtFloat(tgt + pt, sizeof tgt - pt, motion::target(i), 4);
    static const char MODE_CH[] = {'I', 'P', 'V', 'H'};
    modes[i] = motion::tracking(i) ? 'T' : MODE_CH[(int)motion::mode(i)];
    hm[i] = motion::homed(i) ? '1' : '0';
    es[i] = motion::endstop(i) ? '1' : '0';
    drv[i] = drivers::online(i) ? '1' : '0';
  }
  modes[NUM_AXES] = hm[NUM_AXES] = es[NUM_AXES] = drv[NUM_AXES] = '\0';
  io_.printf("%spos=%s vel=%s tgt=%s mode=%s homed=%s es=%s en=%d drv=%s\r\n", prefix, pos, vel, tgt, modes, hm,
             es, motion::enabled(), drv);
}

void Console::exec(char *line) {
  char *argv[MAX_ARGS];
  int argc = 0;
  char *save;
  for (char *t = strtok_r(line, " \t,", &save); t && argc < MAX_ARGS; t = strtok_r(nullptr, " \t,", &save))
    argv[argc++] = t;
  if (argc == 0) return;
  const char *cmd = argv[0];
  int nargs = argc - 1;
  char **args = argv + 1;
  const char *err = nullptr;
  Group g[NUM_AXES * 2];
  int ng = 0;
  unsigned mask = 0;

  if (is(cmd, "MOVE") || is(cmd, "M")) {
    if (!(err = parseGroups(nargs, args, 1, g, ng)))
      for (int i = 0; i < ng && !err; i++) err = motion::moveTo(g[i].ax, g[i].v[0]);
  } else if (is(cmd, "MOVER") || is(cmd, "MR")) {
    if (!(err = parseGroups(nargs, args, 1, g, ng)))
      for (int i = 0; i < ng && !err; i++) err = motion::moveBy(g[i].ax, g[i].v[0]);
  } else if (is(cmd, "TRACK") || is(cmd, "T")) {
    if (!(err = parseGroups(nargs, args, 2, g, ng)))
      for (int i = 0; i < ng && !err; i++) err = motion::track(g[i].ax, g[i].v[0], g[i].v[1]);
  } else if (is(cmd, "JOG") || is(cmd, "J")) {
    if (!(err = parseGroups(nargs, args, 1, g, ng)))
      for (int i = 0; i < ng && !err; i++) err = motion::jog(g[i].ax, g[i].v[0]);
  } else if (is(cmd, "STOP") || is(cmd, "S")) {
    if (!(err = parseAxisMask(nargs, args, mask)))
      for (int i = 0; i < NUM_AXES; i++)
        if (mask & (1u << i)) motion::stop(i);
  } else if (is(cmd, "ESTOP") || is(cmd, "X")) {
    motion::estop();
  } else if (is(cmd, "HOME")) {
    if (!(err = parseAxisMask(nargs, args, mask))) {
      bool any = false;
      for (int i = 0; i < NUM_AXES && !err; i++) {
        if (!(mask & (1u << i))) continue;
        // HOME with no axes homes whichever axes have an endstop.
        if (nargs == 0 && g_settings.axis[i].home_dir == 0) continue;
        err = motion::home(i);
        any = true;
      }
      if (!err && !any) err = "no_endstop_configured";
    }
  } else if (is(cmd, "SETPOS")) {
    if (!(err = parseGroups(nargs, args, 1, g, ng)))
      for (int i = 0; i < ng && !err; i++) err = motion::setPosition(g[i].ax, g[i].v[0]);
  } else if (is(cmd, "ENABLE") || is(cmd, "EN")) {
    if (nargs > 1 || (nargs == 1 && !is(args[0], "0") && !is(args[0], "1")))
      err = "bad_arguments";
    else
      motion::enable(nargs == 0 || is(args[0], "1"));
  } else if (is(cmd, "STATUS") || is(cmd, "?")) {
    printStatus("S ");
  } else if (is(cmd, "STREAM")) {
    float ms;
    if (nargs != 1 || !parseFloat(args[0], ms) || ms < 0)
      err = "bad_arguments";
    else
      stream_ms_ = ms == 0 ? 0 : (uint32_t)fmaxf(ms, 20);
  } else if (is(cmd, "CFG")) {
    err = cmdConfig(io_, nargs, args);
  } else if (is(cmd, "SAVE") || is(cmd, "LOAD") || is(cmd, "DEFAULTS")) {
    // Flash writes pause core 1, so only touch flash with everything stopped.
    if (motion::anyMoving()) {
      err = "stop_all_axes_first";
    } else if (is(cmd, "SAVE")) {
      settingsSave();
    } else {
      Settings before = g_settings;
      if (is(cmd, "LOAD")) {
        if (!settingsLoad()) err = "no_saved_settings_using_defaults";
      } else {
        settingsDefaults(g_settings);
      }
      applyAllSettings(before);
    }
  } else if (is(cmd, "DRV") && nargs >= 1 && is(args[0], "RAW")) {
    float baud = 115200;
    if (nargs > 2 || (nargs == 2 && (!parseFloat(args[1], baud) || baud < 9600 || baud > 500000)))
      err = "bad_arguments";
    else
      drivers::rawProbe(io_, (uint32_t)baud);
  } else if (is(cmd, "DRV")) {
    if (!(err = parseAxisMask(nargs, args, mask)))
      for (int i = 0; i < NUM_AXES; i++)
        if (mask & (1u << i)) drivers::report(io_, i);
  } else if (is(cmd, "VER")) {
    io_.printf("V %s %s\r\n", FW_NAME, FW_VERSION);
  } else if (is(cmd, "HELP")) {
    for (const char *h : HELP) io_.printf("%s\r\n", h);
  } else if (is(cmd, "REBOOT") || is(cmd, "BOOTSEL")) {
    motion::enable(false);
    io_.print("ok\r\n");
    io_.flush();
    delay(100);
    if (is(cmd, "BOOTSEL")) reset_usb_boot(0, 0);  // shows up as the RPI-RP2 drive
    rp2040.reboot();
  } else {
    err = "unknown_command";
  }

  if (err)
    io_.printf("err %s\r\n", err);
  else
    io_.print("ok\r\n");
}

void Console::poll() {
  while (io_.available()) {
    int c = io_.read();
    if (c == '\n' || c == '\r') {
      buf_[len_] = '\0';
      if (overflow_)
        io_.print("err line_too_long\r\n");
      else if (len_)
        exec(buf_);
      len_ = 0;
      overflow_ = false;
    } else if (len_ < sizeof buf_ - 1) {
      buf_[len_++] = (char)c;
    } else {
      overflow_ = true;
    }
  }
  if (stream_ms_ && millis() - last_stream_ >= stream_ms_) {
    last_stream_ = millis();
    if (io_.availableForWrite() >= 200) printStatus("*S ");
  }
}

void Console::event(const char *text) {
  if (io_.availableForWrite() >= (int)strlen(text) + 6) io_.printf("*E %s\r\n", text);
}
