#pragma once
#include <Arduino.h>

// Line-oriented text protocol on one serial port. See docs/PROTOCOL.md.
class Console {
 public:
  explicit Console(Stream &io) : io_(io) {}
  void poll();                    // read input, run complete lines, send stream status
  void event(const char *text);   // "*E <text>", dropped if the port can't take it now

 private:
  void exec(char *line);
  void printStatus(const char *prefix);

  Stream &io_;
  char buf_[192];
  size_t len_ = 0;
  bool overflow_ = false;
  uint32_t stream_ms_ = 0;
  uint32_t last_stream_ = 0;
};
