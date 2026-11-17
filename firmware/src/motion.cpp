#include "motion.h"

#include <Arduino.h>
#include <math.h>

#include "events.h"
#include "hardware/gpio.h"
#include "hardware/structs/sio.h"
#include "hardware/timer.h"
#include "settings.h"

namespace motion {

static constexpr uint32_t TICK_US = 20;  // core 1 step tick: 50 kHz
static constexpr float TICK_HZ = 1e6f / TICK_US;
static constexpr float MAX_STEP_RATE = 20000.0f;  // steps/s; must stay below TICK_HZ / 2
static constexpr float RATE_SCALE = 4294967296.0f / TICK_HZ;
static constexpr uint32_t PLAN_US = 1000;  // core 0 planner: 1 kHz
static constexpr float KP = 50.0f;         // 1/s, final approach gain near the target
static constexpr float DECEL_MARGIN = 0.8f;

// ---------------------------------------------------------------- core 1 --

// Shared between cores. Core 0 writes rate/invert/set_*, core 1 owns pos.
struct Channel {
  volatile int32_t rate;  // signed DDA increment per tick, 2^32 = one step per tick
  volatile int32_t pos;   // steps
  volatile int32_t set_pos;
  volatile bool set_req;
  volatile bool invert;
  volatile int32_t backlash;  // steps of gear slack
};
static Channel ch[NUM_AXES];

// Pin numbers copied to RAM so the tick never touches flash.
static uint8_t step_pin[NUM_AXES], dir_pin[NUM_AXES];
static uint32_t step_mask_all;

static void __not_in_flash_func(tick)() {
  static uint32_t acc[NUM_AXES];
  static bool dir_neg[NUM_AXES];
  static bool inv_applied[NUM_AXES];
  // Where the motor sits inside the gear slack: 0 = engaged on the negative
  // side, backlash = engaged on the positive side, -1 = not known yet (the
  // first move is assumed to be engaged already). Steps that cross the slack
  // move the motor but not the output, so they are not counted in pos.
  static int32_t gap[NUM_AXES] = {-1, -1, -1, -1};

  sio_hw->gpio_clr = step_mask_all;  // end last tick's pulses (20 us wide)
  uint32_t set = 0;
  for (int i = 0; i < NUM_AXES; i++) {
    Channel &c = ch[i];
    if (c.set_req) {
      c.pos = c.set_pos;
      acc[i] = 0;
      c.set_req = false;
    }
    int32_t r = c.rate;
    bool neg = r < 0;
    bool inv = c.invert;
    if ((r != 0 && neg != dir_neg[i]) || inv != inv_applied[i]) {
      // Change direction now, step no earlier than the next tick.
      if (r != 0) dir_neg[i] = neg;
      inv_applied[i] = inv;
      gpio_put(dir_pin[i], dir_neg[i] ^ inv);
      continue;
    }
    if (r == 0) continue;
    uint32_t mag = neg ? (uint32_t)(-r) : (uint32_t)r;
    uint32_t prev = acc[i];
    acc[i] += mag;
    if (acc[i] < prev) {  // accumulator wrapped: one step
      set |= 1u << step_pin[i];
      int32_t bl = c.backlash;
      int32_t &g = gap[i];
      if (g < 0 || g > bl) g = neg ? 0 : bl;
      if (neg && g > 0) g--;
      else if (!neg && g < bl) g++;
      else c.pos = c.pos + (neg ? -1 : 1);
    }
  }
  if (set) sio_hw->gpio_set = set;
}

void core1Run() {
  uint32_t next = time_us_32();
  for (;;) {
    next += TICK_US;
    // After a stall (flash write pauses this core) resync rather than burst.
    if ((int32_t)(time_us_32() - next) > (int32_t)(4 * TICK_US)) next = time_us_32();
    while ((int32_t)(time_us_32() - next) < 0) tight_loop_contents();
    tick();
  }
}

// ---------------------------------------------------------------- core 0 --

enum HomePhase : uint8_t { H_SEEK, H_BACKOFF, H_LATCH };

struct Axis {
  Mode mode = Mode::Idle;
  float v = 0;      // steps/s currently commanded to core 1
  float tgt = 0;    // steps (Position, also home backoff point)
  float tgt_v = 0;  // steps/s feed-forward while tracking
  uint32_t tgt_ms = 0;
  float jog_v = 0;  // steps/s (Velocity)
  bool homed = false;
  HomePhase home_phase = H_SEEK;
  float home_origin = 0;
  uint8_t stop_cnt = 0;  // endstop debounce
};
static Axis ax_[NUM_AXES];
static bool enabled_ = false;
static uint32_t last_plan_us;

static inline const AxisSettings &cfg(int i) { return g_settings.axis[i]; }
static inline float spu(int i) { return stepsPerUnit(cfg(i)); }
static inline float brake(float amax, float dist) {
  return dist > 0 ? sqrtf(2.0f * DECEL_MARGIN * amax * dist) : 0.0f;
}
static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

static void publish(int i) { ch[i].rate = (int32_t)(ax_[i].v * RATE_SCALE); }

void begin() {
  step_mask_all = 0;
  for (int i = 0; i < NUM_AXES; i++) {
    const AxisPins &p = g_axis_pins[i];
    step_pin[i] = p.step;
    dir_pin[i] = p.dir;
    step_mask_all |= 1u << p.step;
    pinMode(p.en, OUTPUT);
    digitalWrite(p.en, HIGH);  // disabled
    pinMode(p.step, OUTPUT);
    digitalWrite(p.step, LOW);
    pinMode(p.dir, OUTPUT);
    ch[i].invert = cfg(i).invert;
    digitalWrite(p.dir, ch[i].invert ? HIGH : LOW);
    pinMode(p.stop, INPUT_PULLUP);
  }
  last_plan_us = micros();
}

// Velocity that brings the axis onto the (possibly moving) target as fast as
// vmax/amax allow: feed-forward plus a sqrt deceleration profile, linear in
// the last few steps. The half-step deadband is continuous (error measured
// from its edge) so slow tracking doesn't dither back and forth a microstep.
static float approach(float e, float ff, float amax, float cap) {
  float ae = fabsf(e) - 0.5f;
  if (ae <= 0) return ff;
  float corr = fminf(brake(amax, ae), KP * ae);
  return clampf(ff + copysignf(corr, e), -cap, cap);
}

static float seek(int i, Axis &a, float k, float vmax, float amax, float p, uint32_t now_ms) {
  const AxisSettings &c = cfg(i);
  float target = a.tgt, ff = a.tgt_v;
  if (ff != 0) {
    uint32_t age = now_ms - a.tgt_ms;
    if (age > g_settings.track_timeout_ms) {
      // Host stopped sending updates: don't keep extrapolating, slow to a stop.
      a.mode = Mode::Velocity;
      a.jog_v = 0;
      a.tgt_v = 0;
      emitEvent("track_timeout %s", AXIS_NAMES[i]);
      return 0;
    }
    target += ff * (age * 1e-3f);
  }
  if (hasLimits(c)) {
    float lo = c.min_pos * k, hi = c.max_pos * k;
    if (target < lo) target = lo, ff = 0;
    if (target > hi) target = hi, ff = 0;
  }
  float e = target - p;
  if (!hasLimits(c) && c.period > 0) e = remainderf(e, c.period * k);  // continuous axis: shortest way
  return approach(e, ff, amax, vmax);
}

static float homeFail(int i, Axis &a, const char *why) {
  a.mode = Mode::Velocity;
  a.jog_v = 0;
  emitEvent("home_failed %s %s", AXIS_NAMES[i], why);
  return 0;
}

static float homeStep(int i, Axis &a, float k, float amax, float p, bool hit, bool &hard_stop) {
  const AxisSettings &c = cfg(i);
  float speed = c.home_speed * k;
  float dir = c.home_dir;
  switch (a.home_phase) {
    case H_SEEK: {
      if (hit) {
        hard_stop = true;
        a.home_phase = H_BACKOFF;
        a.tgt = p - dir * c.home_backoff * k;
        return 0;
      }
      float travel = hasLimits(c) ? 1.2f * (c.max_pos - c.min_pos) + c.home_backoff
                                  : 1.1f * c.units_per_rev;
      if (fabsf(p - a.home_origin) > travel * k) return homeFail(i, a, "endstop_not_found");
      return dir * speed;
    }
    case H_BACKOFF: {
      float e = a.tgt - p;
      if (fabsf(e) <= 1.0f && a.v == 0) {
        if (hit) return homeFail(i, a, "endstop_stuck");
        a.home_phase = H_LATCH;
        a.home_origin = p;
        return 0;
      }
      return approach(e, 0, amax, speed);
    }
    case H_LATCH: {
      if (hit) {
        hard_stop = true;
        ch[i].set_pos = lroundf(c.home_pos * k);
        ch[i].set_req = true;
        a.tgt = c.home_pos * k;
        a.mode = Mode::Idle;
        a.homed = true;
        emitEvent("homed %s", AXIS_NAMES[i]);
        return 0;
      }
      if (fabsf(p - a.home_origin) > (2.0f * c.home_backoff + 1.0f) * k)
        return homeFail(i, a, "endstop_lost");
      return dir * speed * 0.2f;
    }
  }
  return 0;
}

static bool readEndstop(int i) {
  return gpio_get(g_axis_pins[i].stop) != (cfg(i).endstop_invert != 0);
}

static void plan(int i, float dt, uint32_t now_ms) {
  Axis &a = ax_[i];
  const AxisSettings &c = cfg(i);
  float k = spu(i);
  float vmax = fminf(c.vmax * k, MAX_STEP_RATE);
  float amax = c.amax * k;
  ch[i].backlash = lroundf(c.backlash * k);

  bool hit = false;
  if (c.home_dir != 0) {
    a.stop_cnt = readEndstop(i) ? (a.stop_cnt < 3 ? a.stop_cnt + 1 : 3) : 0;
    hit = a.stop_cnt >= 2;
  }

  if (!enabled_ || ch[i].set_req) {
    a.v = 0;
    publish(i);
    return;
  }
  float p = (float)ch[i].pos;

  float v_des = 0;
  bool hard_stop = false;
  const bool homing = a.mode == Mode::Homing;  // homeStep may finish and go Idle below
  switch (a.mode) {
    case Mode::Idle: break;
    case Mode::Velocity:
      v_des = a.jog_v;
      if (v_des == 0 && a.v == 0) a.mode = Mode::Idle;
      break;
    case Mode::Position: v_des = seek(i, a, k, vmax, amax, p, now_ms); break;
    case Mode::Homing: v_des = homeStep(i, a, k, amax, p, hit, hard_stop); break;
  }

  if (!homing) {
    if (hasLimits(c)) {
      // Half-step margin so float rounding of the limit can't leave a creep.
      if (v_des > 0) v_des = fminf(v_des, brake(amax, c.max_pos * k - p - 0.5f));
      if (v_des < 0) v_des = fmaxf(v_des, -brake(amax, p - c.min_pos * k - 0.5f));
    }
    // An endstop doubles as a hard limit in its own direction.
    if (hit && (v_des * c.home_dir > 0 || a.v * c.home_dir > 0)) {
      hard_stop = true;
      v_des = 0;
      a.mode = Mode::Idle;
      // Tripping near its known place (backlash, sag) confirms the reference;
      // anywhere else the position was lost.
      if (fabsf(p - c.home_pos * k) > c.home_backoff * k) a.homed = false;
      emitEvent("endstop_hit %s", AXIS_NAMES[i]);
    }
  }

  v_des = clampf(v_des, -vmax, vmax);
  if (hard_stop) {
    a.v = 0;
  } else {
    float dv = amax * dt;
    a.v += clampf(v_des - a.v, -dv, dv);
  }
  a.v = clampf(a.v, -MAX_STEP_RATE, MAX_STEP_RATE);
  publish(i);
}

void update() {
  uint32_t now = micros();
  uint32_t elapsed = now - last_plan_us;
  if (elapsed < PLAN_US) return;
  last_plan_us = now;
  float dt = fminf(elapsed * 1e-6f, 0.02f);  // after a long stall, don't jump
  uint32_t now_ms = millis();
  for (int i = 0; i < NUM_AXES; i++) plan(i, dt, now_ms);
}

// -------------------------------------------------------------- commands --

void enable(bool on) {
  if (!on) {
    estop();
    for (auto &a : ax_) a.homed = false;  // an unpowered axis can be moved by hand
  }
  for (const AxisPins &p : g_axis_pins) digitalWrite(p.en, on ? LOW : HIGH);
  enabled_ = on;
}

bool enabled() { return enabled_; }

static const char *ready(int i) {
  if (ax_[i].mode == Mode::Homing) return "homing_in_progress";
  if (!enabled_) enable(true);
  return nullptr;
}

// For axes with a period (pan), pick the equivalent angle nearest the current
// target that is inside the soft limits, so 359 -> 1 doesn't spin the long way.
static float pickTarget(int i, float units) {
  const AxisSettings &c = cfg(i);
  float k = spu(i);
  if (c.period <= 0) return units * k;
  const Axis &a = ax_[i];
  float ref = (a.mode == Mode::Position ? a.tgt : (float)ch[i].pos) / k;
  float best = units + roundf((ref - units) / c.period) * c.period;
  if (hasLimits(c)) {
    float best_d = INFINITY, pick = best;
    for (int n = -2; n <= 2; n++) {
      float cand = best + n * c.period;
      if (cand >= c.min_pos && cand <= c.max_pos && fabsf(cand - ref) < best_d) {
        best_d = fabsf(cand - ref);
        pick = cand;
      }
    }
    best = pick;
  }
  return best * k;
}

const char *moveTo(int i, float pos) {
  if (const char *e = ready(i)) return e;
  Axis &a = ax_[i];
  a.tgt = pickTarget(i, pos);
  a.tgt_v = 0;
  a.mode = Mode::Position;
  return nullptr;
}

const char *moveBy(int i, float delta) {
  if (const char *e = ready(i)) return e;
  Axis &a = ax_[i];
  float base = a.mode == Mode::Position ? a.tgt : (float)ch[i].pos;
  a.tgt = base + delta * spu(i);
  a.tgt_v = 0;
  a.mode = Mode::Position;
  return nullptr;
}

const char *track(int i, float pos, float vel) {
  if (const char *e = ready(i)) return e;
  Axis &a = ax_[i];
  a.tgt = pickTarget(i, pos);
  a.tgt_v = vel * spu(i);
  a.tgt_ms = millis();
  a.mode = Mode::Position;
  return nullptr;
}

const char *jog(int i, float vel) {
  if (const char *e = ready(i)) return e;
  Axis &a = ax_[i];
  a.jog_v = clampf(vel * spu(i), -MAX_STEP_RATE, MAX_STEP_RATE);
  a.mode = Mode::Velocity;
  return nullptr;
}

void stop(int i) {
  Axis &a = ax_[i];
  if (a.mode == Mode::Homing) emitEvent("home_failed %s aborted", AXIS_NAMES[i]);
  a.mode = Mode::Velocity;
  a.jog_v = 0;
  a.tgt_v = 0;
}

void estop() {
  for (int i = 0; i < NUM_AXES; i++) {
    ax_[i].v = 0;
    ax_[i].tgt_v = 0;
    ax_[i].mode = Mode::Idle;
    publish(i);
  }
}

const char *home(int i) {
  if (cfg(i).home_dir == 0) return "no_endstop_configured";
  if (!enabled_) enable(true);
  Axis &a = ax_[i];
  a.mode = Mode::Homing;
  a.home_phase = H_SEEK;
  a.home_origin = (float)ch[i].pos;
  a.homed = false;
  return nullptr;
}

const char *setPosition(int i, float pos) {
  if (moving(i)) return "axis_moving";
  Axis &a = ax_[i];
  float k = spu(i);
  ch[i].set_pos = lroundf(pos * k);
  ch[i].set_req = true;
  a.tgt = pos * k;
  a.mode = Mode::Idle;
  a.homed = true;  // the host has declared a reference
  return nullptr;
}

void geometryChanged(int i, const AxisSettings &before) {
  Axis &a = ax_[i];
  float steps = ch[i].pos * ((float)cfg(i).microsteps / before.microsteps);
  ch[i].set_pos = lroundf(steps);
  ch[i].set_req = true;
  a.tgt = steps;
  a.mode = Mode::Idle;
  a.homed = false;
  ch[i].invert = cfg(i).invert;
}

// ---------------------------------------------------------------- status --

float position(int i) { return ch[i].pos / spu(i); }
float velocity(int i) { return ax_[i].v / spu(i); }
float target(int i) {
  const Axis &a = ax_[i];
  if (a.mode != Mode::Position) return position(i);
  float t = a.tgt;
  if (a.tgt_v != 0) t += a.tgt_v * ((millis() - a.tgt_ms) * 1e-3f);
  return t / spu(i);
}
Mode mode(int i) { return ax_[i].mode; }
bool tracking(int i) { return ax_[i].mode == Mode::Position && ax_[i].tgt_v != 0; }
bool homed(int i) { return ax_[i].homed; }
bool endstop(int i) { return readEndstop(i); }
bool moving(int i) { return ax_[i].v != 0 || ax_[i].mode == Mode::Homing; }
bool anyMoving() {
  for (int i = 0; i < NUM_AXES; i++)
    if (moving(i)) return true;
  return false;
}

}  // namespace motion
