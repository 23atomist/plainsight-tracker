"""Atomic JSON files under a data directory."""
from __future__ import annotations

import json
import logging
import os
from typing import Any

log = logging.getLogger(__name__)


class JsonStore:
    def __init__(self, dir: str) -> None:
        self._dir = dir

    def read(self, name: str) -> dict[str, Any] | None:
        path = os.path.join(self._dir, name)
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            log.warning("%s: not found", path)
        except (OSError, ValueError) as exc:
            log.warning("%s: unreadable: %s", path, exc)
        return None

    def write(self, name: str, obj: dict[str, Any]) -> None:
        os.makedirs(self._dir, exist_ok=True)
        path = os.path.join(self._dir, name)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f)
            f.flush()
            os.fsync(f.fileno())  # the data is on the card before the rename makes it current
        os.replace(tmp, path)
