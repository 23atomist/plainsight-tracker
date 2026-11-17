// plainsight PTZ controller: pan / tilt / zoom / focus on a BTT SKR Pico v1.0.
//
// Core 0: host ports (USB CDC + Pi-header UART), planner, TMC2209 upkeep, LED.
// Core 1: 50 kHz step generator, nothing else.

#include <Adafruit_NeoPixel.h>
#include <Arduino.h>
#include <EEPROM.h>
#include <stdarg.h>

#include "console.h"
#include "drivers.h"
#include "events.h"
#include "motion.h"
#include "pins.h"
#include "settings.h"

static Console usb_console(Serial);
static Console uart_console(Serial1);
static Adafruit_NeoPixel pixel(1, PIN_NEOPIXEL, NEO_GRB + NEO_KHZ800);
static volatile bool core0_ready = false;

void emitEvent(const char *fmt, ...) {
  char text[128];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(text, sizeof text, fmt, ap);
  va_end(ap);
  usb_console.event(text);
  uart_console.event(text);
}

// Dim status colour: amber = drivers disabled, green = enabled and idle,
// blue = moving, blinking red = a driver is offline or faulted while enabled.
static void updateLed() {
  static uint32_t last_ms, last_color = 1;
  uint32_t now = millis();
  if (now - last_ms < 100) return;
  last_ms = now;
  bool drivers_ok = true;
  for (int i = 0; i < NUM_AXES; i++) drivers_ok &= drivers::online(i);
  uint32_t color;
  if (!motion::enabled())
    color = pixel.Color(12, 6, 0);
  else if (!drivers_ok)
    color = (now / 250) & 1 ? pixel.Color(24, 0, 0) : 0;
  else if (motion::anyMoving())
    color = pixel.Color(0, 0, 24);
  else
    color = pixel.Color(0, 12, 0);
  if (color != last_color) {
    pixel.setPixelColor(0, color);
    pixel.show();
    last_color = color;
  }
}

void setup() {
  for (uint8_t p : PINS_HOLD_LOW) {
    pinMode(p, OUTPUT);
    digitalWrite(p, LOW);
  }
  EEPROM.begin(EEPROM_BYTES);
  settingsLoad();
  settingsResolveSockets();
  motion::begin();
  core0_ready = true;

  Serial.begin(115200);  // USB CDC; baud is ignored. Never wait for the host here.
  Serial1.setTX(PIN_HOST_TX);
  Serial1.setRX(PIN_HOST_RX);
  Serial1.begin(g_settings.host_baud);
  gpio_pull_up(PIN_HOST_RX);  // quiet line when nothing is plugged into the Pi header

  drivers::begin();
  pixel.begin();
  if (g_settings.enable_on_boot) motion::enable(true);
}

void loop() {
  motion::update();
  usb_console.poll();
  uart_console.poll();
  drivers::update();
  updateLed();
}

void setup1() {
  while (!core0_ready) tight_loop_contents();
}

void loop1() { motion::core1Run(); }
