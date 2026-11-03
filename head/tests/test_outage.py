import logging

from plainsight_head.outage import OutageLog
from tests.fakes import FakeClock

log = logging.getLogger("plainsight_head.test_outage")


def _lines(caplog, level):
    return [r.getMessage() for r in caplog.records if r.levelno == level and r.name == log.name]


def test_one_warning_down_one_summary_a_minute_one_info_back(caplog):
    caplog.set_level(logging.DEBUG, logger=log.name)
    clk = FakeClock()
    out = OutageLog(log, "thing", time_fn=clk.now)
    out.recovered()  # nothing was down: silent
    for _ in range(59):
        out.failure("gone")
        clk.advance(1.0)
    assert out.down and _lines(caplog, logging.WARNING) == ["thing down: gone"]
    out.failure("still gone")  # t = 59 s: not yet a minute since the first line
    clk.advance(1.0)
    out.failure("still gone")  # t = 60 s
    warnings = _lines(caplog, logging.WARNING)
    assert len(warnings) == 2 and warnings[1] == "thing still down after 60 s (61 failures; last: still gone)"
    out.recovered()
    assert not out.down and _lines(caplog, logging.INFO) == ["thing back after 60 s (61 failures)"]
    out.failure("again")
    assert _lines(caplog, logging.WARNING)[-1] == "thing down: again"
