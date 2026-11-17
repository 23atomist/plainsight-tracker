#pragma once

// Asynchronous event, sent to every host port as "*E <text>".
void emitEvent(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
