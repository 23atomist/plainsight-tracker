import pytest

from tools.track_bench import following_error


def test_constant_lag_gives_constant_error():
    commanded = [(t / 10, t / 10 * 2.0) for t in range(0, 101)]
    observed = [(t / 10, t / 10 * 2.0 - 0.2) for t in range(10, 90)]
    r = following_error(commanded, observed)
    assert r["n"] == 80
    assert r["max"] == pytest.approx(0.2)
    assert r["rms"] == pytest.approx(0.2)
    assert r["p95"] == pytest.approx(0.2)


def test_interpolates_between_commanded_samples():
    commanded = [(0.0, 0.0), (1.0, 10.0)]
    observed = [(0.5, 5.0)]
    r = following_error(commanded, observed)
    assert r["n"] == 1
    assert r["max"] == pytest.approx(0.0)


def test_observed_outside_commanded_range_is_skipped():
    commanded = [(1.0, 0.0), (2.0, 1.0)]
    observed = [(0.0, 5.0), (1.5, 0.5), (3.0, 5.0)]
    assert following_error(commanded, observed)["n"] == 1


def test_p95_picks_the_tail():
    commanded = [(0.0, 0.0), (100.0, 0.0)]
    observed = [(float(i), 0.1) for i in range(1, 100)] + [(50.5, 1.0)]
    r = following_error(commanded, observed)
    assert r["max"] == pytest.approx(1.0)
    assert r["p95"] == pytest.approx(0.1)


@pytest.mark.parametrize(
    "commanded,observed",
    [([], [(0.0, 0.0)]), ([(0.0, 0.0)], [(0.0, 0.0)]), ([(0.0, 0.0), (1.0, 1.0)], [])],
)
def test_degenerate_inputs_return_zeros(commanded, observed):
    assert following_error(commanded, observed) == {"max": 0.0, "rms": 0.0, "p95": 0.0, "n": 0}
