#pragma once
#include <stdint.h>

// BIGTREETECH SKR Pico v1.0 pin map (from the board's stock Klipper config,
// docs/SKR Pico klipper.cfg).
//
// Axis order used everywhere in the firmware and protocol:
//   0 = pan, 1 = tilt, 2 = zoom, 3 = focus
// Each axis drives one of the four driver sockets, chosen by its "socket"
// setting (default: pan X, tilt Y, zoom Z, focus E). See g_axis_pins.
constexpr int NUM_AXES = 4;

struct AxisPins {
  uint8_t step;
  uint8_t dir;
  uint8_t en;        // active LOW
  uint8_t stop;      // endstop connector of the same name
  uint8_t tmc_addr;  // TMC2209 UART address set by the board's MS1/MS2 straps
};

constexpr AxisPins SOCKET_PINS[NUM_AXES] = {
    {11, 10, 12, 4, 0},   // XM
    {6, 5, 7, 3, 2},      // YM
    {19, 28, 2, 25, 1},   // ZM (two connectors in parallel)
    {14, 13, 15, 16, 3},  // EM (E-stop is the filament runout connector)
};
constexpr const char *SOCKET_NAMES[NUM_AXES] = {"X", "Y", "Z", "E"};

constexpr const char *AXIS_NAMES[NUM_AXES] = {"pan", "tilt", "zoom", "focus"};

// All four TMC2209s share one single-wire UART (TX and RX joined on the board).
constexpr uint8_t PIN_TMC_TX = 8;  // UART1 -> Serial2
constexpr uint8_t PIN_TMC_RX = 9;
constexpr uint32_t TMC_BAUD = 115200;
constexpr float TMC_RSENSE = 0.110f;  // ohms, SKR Pico sense resistors

// UART0 on the 3-pin Raspberry Pi header (the port Klipper used as ttyAMA0).
constexpr uint8_t PIN_HOST_TX = 0;
constexpr uint8_t PIN_HOST_RX = 1;

constexpr uint8_t PIN_NEOPIXEL = 24;

// Heater and fan MOSFETs we do not use; held LOW so nothing switches on.
constexpr uint8_t PINS_HOLD_LOW[] = {21, 23, 17, 18, 20};  // bed, hotend, fan0, fan1, fan2
