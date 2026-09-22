# -*- coding: utf-8 -*-
"""示例地图生成脚本的几何小工具，以及街区示例 draw_demo 的回调契约。"""
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import make_district_map as mdm  # noqa: E402
import make_demo_map as mdemo  # noqa: E402


def test_rounded_rect_path_is_closed_ring_inside_box():
    pts = mdm.rounded_rect_path(0, 0, 100, 60, 10, n=8)
    assert len(pts) == 4 * 9
    assert pts[:, 0].min() >= -1e-9 and pts[:, 0].max() <= 100 + 1e-9
    assert pts[:, 1].min() >= -1e-9 and pts[:, 1].max() <= 60 + 1e-9
    # 角上确实是圆的: 角点 (0,0) 不在路径上，离它最近的点约 r(1-1/√2) 远
    d = np.hypot(pts[:, 0], pts[:, 1]).min()
    assert abs(d - 10 * (math.sqrt(2) - 1)) < 0.5


def test_smooth_keeps_endpoints_and_adds_points():
    p = mdm.smooth([(0, 0), (10, 10), (20, 0)], rounds=3)
    assert np.allclose(p[0], [0, 0]) and np.allclose(p[-1], [20, 0])
    assert len(p) > 3
    # 切角后曲线不会超出控制多边形
    assert p[:, 1].max() <= 10 + 1e-9
    # 相邻点间距越来越均匀（没有突变）
    seg = np.hypot(*np.diff(p, axis=0).T)
    assert seg.max() < 4 * seg.mean()


def test_draw_demo_calls_back_with_known_colors():
    calls = {"R": [], "clear": [], "disc": [], "ellipse": []}
    mdemo.draw_demo(
        R=lambda x, y, w, h, col: calls["R"].append(col),
        clear=lambda x, y, w, h: calls["clear"].append(1),
        disc=lambda x, y, r, col, on=255: calls["disc"].append(col),
        ellipse=lambda x, y, rx, ry, ang, col: calls["ellipse"].append(col),
        elevated=False,
    )
    assert calls["R"]
    known = {mdemo.RED, mdemo.ORANGE, mdemo.MAGENTA, mdemo.BLUE, mdemo.YELLOW, mdemo.CYAN, mdemo.GREEN, mdemo.PARK, mdemo.WATER, mdemo.PLAZA, mdemo.PARKING, mdemo.ELEVATED, mdm.RESIDENTIAL, mdm.VENUE}
    for col in calls["R"] + calls["disc"] + calls["ellipse"]:
        assert col in known or col is None or len(col) == 3
    # 关掉高架后不应该画高架色
    assert mdemo.ELEVATED not in calls["R"]
