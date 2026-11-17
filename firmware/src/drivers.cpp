#include "drivers.h"

#include <Arduino.h>
#include <math.h>

#include "events.h"
#include "pins.h"
#include "settings.h"

namespace drivers {

// Register addresses (TMC2209 datasheet rev 1.09, section 5).
enum : uint8_t {
  REG_GCONF = 0x00,
  REG_GSTAT = 0x01,
  REG_IFCNT = 0x02,
  REG_IOIN = 0x06,
  REG_IHOLD_IRUN = 0x10,
  REG_TPOWERDOWN = 0x11,
  REG_TPWMTHRS = 0x13,
  REG_TCOOLTHRS = 0x14,
  REG_SGTHRS = 0x40,
  REG_SG_RESULT = 0x41,
  REG_MSCNT = 0x6A,
  REG_CHOPCONF = 0x6C,
  REG_DRV_STATUS = 0x6F,
};

static constexpr uint32_t GCONF_EN_SPREADCYCLE = 1u << 2;
static constexpr uint32_t GCONF_PDN_DISABLE = 1u << 6;  // PDN_UART pin is UART, not standstill power-down
static constexpr uint32_t GCONF_MSTEP_REG_SELECT = 1u << 7;  // microsteps from MRES, not MS1/MS2 (those set the address)
static constexpr uint32_t GCONF_MULTISTEP_FILT = 1u << 8;
// toff=3 hstrt=5 hend=0 tbl=2 intpol=1, the same base Klipper uses.
static constexpr uint32_t CHOPCONF_BASE = 0x10010053;
static constexpr uint32_t CHOPCONF_VSENSE = 1u << 17;

static SerialUART &bus = Serial2;

static uint8_t crc8(const uint8_t *d, size_t n) {
  uint8_t crc = 0;
  for (size_t i = 0; i < n; i++) {
    uint8_t b = d[i];
    for (int j = 0; j < 8; j++) {
      crc = ((crc >> 7) ^ (b & 1)) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
      b >>= 1;
    }
  }
  return crc;
}

// The drivers ignore a datagram that starts too soon after the previous one,
// so keep the bus idle for a moment between transactions.
static constexpr uint32_t BUS_IDLE_US = 1000;
static uint32_t bus_idle_since;

static void waitBusIdle() {
  while (micros() - bus_idle_since < BUS_IDLE_US) tight_loop_contents();
}

static void writeReg(uint8_t addr, uint8_t reg, uint32_t val) {
  waitBusIdle();
  uint8_t d[8] = {0x05, addr, (uint8_t)(reg | 0x80), (uint8_t)(val >> 24),
                  (uint8_t)(val >> 16), (uint8_t)(val >> 8), (uint8_t)val, 0};
  d[7] = crc8(d, 7);
  bus.write(d, sizeof d);
  bus.flush();
  bus_idle_since = micros();
}

static bool readReg(uint8_t addr, uint8_t reg, uint32_t &val) {
  waitBusIdle();
  while (bus.available()) bus.read();
  uint8_t req[4] = {0x05, addr, reg, 0};
  req[3] = crc8(req, 3);
  bus.write(req, sizeof req);
  bus.flush();
  // TX and RX share one wire, so the 4-byte request echoes back ahead of the
  // 8-byte reply. Scan for the reply rather than assuming the echo is there.
  uint8_t buf[12];
  size_t n = 0;
  bool ok = false;
  uint32_t t0 = micros();
  while (!ok && micros() - t0 < 3000 && n < sizeof buf) {
    if (!bus.available()) continue;
    buf[n++] = bus.read();
    if (n < 8) continue;
    const uint8_t *r = buf + n - 8;
    if (r[0] == 0x05 && r[1] == 0xFF && r[2] == reg && crc8(r, 7) == r[7]) {
      val = (uint32_t)r[3] << 24 | (uint32_t)r[4] << 16 | (uint32_t)r[5] << 8 | r[6];
      ok = true;
    }
  }
  bus_idle_since = micros();
  return ok;
}

static uint8_t csFor(float amps, float vfs) {
  float cs = 32.0f * 1.41421356f * amps * (TMC_RSENSE + 0.02f) / vfs - 1.0f;
  return (uint8_t)constrain(lroundf(cs), 0L, 31L);
}

// Pick vsense for the best current resolution, then the run/hold scalers.
static void currents(const AxisSettings &c, uint8_t &run, uint8_t &hold, bool &vsense) {
  vsense = csFor(c.run_current, 0.325f) < 16;
  float vfs = vsense ? 0.180f : 0.325f;
  run = csFor(c.run_current, vfs);
  hold = csFor(c.hold_current, vfs);
}

static uint32_t mres(uint16_t microsteps) {
  uint32_t m = 8;  // 1 microstep (fullstep) = 8, 256 = 0
  while (microsteps > 1 && m > 0) microsteps >>= 1, m--;
  return m;
}

struct State {
  bool online = false;
  bool dirty = true;  // configuration needs (re)sending
  uint32_t drv_status = 0;
  bool fault = false;
};
static State st[NUM_AXES];
static uint32_t last_poll_ms;
static int poll_axis;

static bool configure(int i) {
  const AxisSettings &c = g_settings.axis[i];
  uint8_t addr = g_axis_pins[i].tmc_addr;
  uint32_t cnt0, cnt1;
  if (!readReg(addr, REG_IFCNT, cnt0)) return false;

  uint8_t run, hold;
  bool vsense;
  currents(c, run, hold, vsense);
  uint32_t gconf = GCONF_PDN_DISABLE | GCONF_MSTEP_REG_SELECT | GCONF_MULTISTEP_FILT |
                   (c.stealth ? 0 : GCONF_EN_SPREADCYCLE);
  uint32_t chop = CHOPCONF_BASE | (vsense ? CHOPCONF_VSENSE : 0) | mres(c.microsteps) << 24;

  const uint32_t regs[][2] = {
      {REG_GCONF, gconf},
      {REG_GSTAT, 0x7},  // clear reset / drv_err / uv_cp
      {REG_CHOPCONF, chop},
      {REG_IHOLD_IRUN, (uint32_t)hold | (uint32_t)run << 8 | 8u << 16},
      {REG_TPOWERDOWN, 20},
      {REG_TPWMTHRS, 0},  // never switch away from the selected chopper
      {REG_TCOOLTHRS, c.sgthrs ? 0xFFFFFu : 0u},
      {REG_SGTHRS, c.sgthrs},
  };
  for (const auto &r : regs) writeReg(addr, (uint8_t)r[0], r[1]);

  // IFCNT counts accepted writes: proof every datagram arrived intact.
  if (!readReg(addr, REG_IFCNT, cnt1)) return false;
  return ((cnt1 - cnt0) & 0xFF) == sizeof regs / sizeof regs[0];
}

static void check(int i) {
  State &s = st[i];
  uint8_t addr = g_axis_pins[i].tmc_addr;
  uint32_t gstat;
  if (!readReg(addr, REG_GSTAT, gstat)) {
    if (s.online) emitEvent("driver_offline %s", AXIS_NAMES[i]);
    s.online = false;
    s.dirty = true;
    return;
  }
  if (s.dirty || !s.online || (gstat & 1)) {
    bool ok = configure(i);
    if (ok && !s.online) emitEvent("driver_online %s", AXIS_NAMES[i]);
    if (!ok) emitEvent("driver_config_failed %s", AXIS_NAMES[i]);
    s.online = ok;
    s.dirty = !ok;
  }
  uint32_t ds;
  if (readReg(addr, REG_DRV_STATUS, ds)) {
    s.drv_status = ds;
    // ot (bit1), s2ga/s2gb (2,3), s2vsa/s2vsb (4,5). Open-load bits are
    // unreliable at standstill and deliberately ignored.
    bool fault = (ds & 0x3E) != 0;
    if (fault && !s.fault) emitEvent("driver_fault %s drv_status=0x%08lx", AXIS_NAMES[i], (unsigned long)ds);
    s.fault = fault;
  }
}

void begin() {
  bus.setTX(PIN_TMC_TX);
  bus.setRX(PIN_TMC_RX);
  bus.begin(TMC_BAUD);
  for (int i = 0; i < NUM_AXES; i++) check(i);
  last_poll_ms = millis();
}

void update() {
  uint32_t now = millis();
  if (now - last_poll_ms < 250) return;
  last_poll_ms = now;
  check(poll_axis);
  poll_axis = (poll_axis + 1) % NUM_AXES;
}

void reconfigure(int i) {
  st[i].dirty = true;
  check(i);
}

bool online(int i) { return st[i].online && !st[i].fault; }

void rawProbe(Print &out, uint32_t baud) {
  if (baud != TMC_BAUD) bus.begin(baud);
  for (int addr = 0; addr < 4; addr++) {
    while (bus.available()) bus.read();
    uint8_t req[4] = {0x05, (uint8_t)addr, REG_IOIN, 0};
    req[3] = crc8(req, 3);
    bus.write(req, sizeof req);
    bus.flush();
    uint8_t buf[16];
    uint32_t at[16];
    size_t n = 0;
    uint32_t t0 = micros();
    while (micros() - t0 < 20000 && n < sizeof buf)
      if (bus.available()) at[n] = micros() - t0, buf[n++] = bus.read();
    out.printf("D raw baud=%lu addr=%d got=%u:", (unsigned long)baud, addr, (unsigned)n);
    for (size_t i = 0; i < n; i++) out.printf(" %02x@%lu", buf[i], (unsigned long)at[i]);
    out.print(n == 0 ? "  (no echo: UART/pin problem)\r\n"
                     : n == 4 ? "  (echo only: driver silent)\r\n" : "\r\n");
  }
  if (baud != TMC_BAUD) bus.begin(TMC_BAUD);
}

void report(Print &out, int i) {
  uint8_t addr = g_axis_pins[i].tmc_addr;
  uint32_t ioin, gconf, chop, ds, ifcnt, mscnt;
  if (!readReg(addr, REG_IOIN, ioin) || !readReg(addr, REG_GCONF, gconf) ||
      !readReg(addr, REG_CHOPCONF, chop) || !readReg(addr, REG_DRV_STATUS, ds) ||
      !readReg(addr, REG_IFCNT, ifcnt) || !readReg(addr, REG_MSCNT, mscnt)) {
    out.printf("D %s socket=%s online=0 (no UART reply: motor power off or driver missing)\r\n", AXIS_NAMES[i],
               SOCKET_NAMES[g_axis_socket[i]]);
    return;
  }
  uint8_t run, hold;
  bool vsense;
  currents(g_settings.axis[i], run, hold, vsense);
  out.printf(
      "D %s socket=%s online=1 version=0x%02lx addr=%u ifcnt=%lu enn_pin=%d mscnt=%lu stealth=%d mres=%lu vsense=%d "
      "irun=%u ihold=%u cs_actual=%lu stst=%d ot=%d otpw=%d s2g=%d%d s2vs=%d%d ola=%d olb=%d\r\n",
      AXIS_NAMES[i], SOCKET_NAMES[g_axis_socket[i]], (unsigned long)(ioin >> 24), addr, (unsigned long)(ifcnt & 0xFF), (int)(ioin & 1), (unsigned long)(mscnt & 0x3FF),
      !(gconf & GCONF_EN_SPREADCYCLE), (unsigned long)((chop >> 24) & 0xF),
      (int)((chop >> 17) & 1), run, hold, (unsigned long)((ds >> 16) & 0x1F), (int)(ds >> 31),
      (int)((ds >> 1) & 1), (int)(ds & 1), (int)((ds >> 2) & 1), (int)((ds >> 3) & 1),
      (int)((ds >> 4) & 1), (int)((ds >> 5) & 1), (int)((ds >> 6) & 1), (int)((ds >> 7) & 1));
}

}  // namespace drivers
