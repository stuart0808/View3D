# -*- coding: utf-8 -*-
"""
map2scene.py 纯函数部分的测试: 颜色归类、掩膜 → 轮廓、主方向、直角化、骨架图、毛刺剪除 / 路口合并、折线工具、几何输出。
运行: <venv>/python -m pytest tests/py   （需要 opencv / shapely / scikit-image，见 tools/requirements.txt）
"""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import map2scene as m2s  # noqa: E402
from shapely.geometry import Polygon, MultiPolygon  # noqa: E402

MARKERS = [{"color": "#FF0000", "layer": "building", "kind": "shop"}, {"color": "#0000FF", "layer": "road"}, {"color": "#00FF00", "layer": "area", "kind": "green"}]


def bgr(hex_):
    r, g, b = m2s.hex_to_rgb(hex_)
    return (b, g, r)


def blank(w=200, h=120):
    return np.full((h, w, 3), 255, np.uint8)


# ---------------------------------------------------------------------------
# 颜色归类
# ---------------------------------------------------------------------------
def test_hex_to_rgb():
    assert m2s.hex_to_rgb("#FF8000") == (255, 128, 0)
    assert m2s.hex_to_rgb("0000ff") == (0, 0, 255)


def test_classify_picks_nearest_marker_and_ignores_grey():
    img = blank()
    img[10:30, 10:50] = bgr("#FF0000")  # 红 = 建筑
    img[50:70, 10:50] = (250, 30, 20)  # 接近蓝的颜色 → 道路
    img[90:110, 10:50] = (120, 120, 120)  # 灰 → 未标记
    cls = m2s.classify(img, MARKERS, tol=100)
    assert cls[20, 30] == 0
    assert cls[60, 30] == 1
    assert cls[100, 30] == -1
    assert cls[5, 5] == -1  # 白底


def test_classify_alpha_transparent_is_unmarked():
    img = np.dstack([blank(), np.full((120, 200), 255, np.uint8)])
    img[10:30, 10:50, :3] = bgr("#FF0000")
    img[10:30, 10:50, 3] = 0
    assert (m2s.classify(img, MARKERS, tol=100)[10:30, 10:50] == -1).all()


# ---------------------------------------------------------------------------
# 掩膜 → 轮廓
# ---------------------------------------------------------------------------
def test_mask_to_rings_outer_and_holes():
    mask = np.zeros((120, 200), np.uint8)
    mask[10:110, 10:190] = 255
    mask[40:80, 60:140] = 0  # 内院
    mask[0:2, 0:2] = 255  # 小噪点，面积 4 < 50
    rings = m2s.mask_to_rings(mask, 50)
    assert len(rings) == 1
    shell, holes = rings[0]
    assert len(holes) == 1
    assert 170 * 90 * 0.95 < abs(m2s.cv2.contourArea(shell)) < 180 * 100


def test_clean_mask_removes_specks_and_fills_gaps():
    mask = np.zeros((60, 60), np.uint8)
    mask[10:50, 10:50] = 255
    mask[30, 10:50] = 0  # 一条 1px 细缝
    mask[2, 2] = 255  # 孤立点
    out = m2s.clean_mask(mask)
    assert out[2, 2] == 0
    assert out[30, 30] == 255


def test_simplify_ring_reduces_points_and_rejects_degenerate():
    cnt = np.array([[[0, 0]], [[50, 0]], [[100, 0]], [[100, 50]], [[100, 100]], [[0, 100]]], np.int32)
    s = m2s.simplify_ring(cnt, 1.0)
    assert len(s) == 4
    assert m2s.simplify_ring(np.array([[[0, 0]], [[1, 0]]], np.int32), 1.0) is None


# ---------------------------------------------------------------------------
# 主方向 / 直角化
# ---------------------------------------------------------------------------
def rect(w, h, ang=0.0, cx=0.0, cy=0.0):
    pts = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], float)
    c, s = math.cos(ang), math.sin(ang)
    return pts @ np.array([[c, s], [-s, c]]) + [cx, cy]


def test_dominant_angle_of_rotated_rect():
    for ang in (0.0, 0.3, -0.4):
        assert abs(m2s.dominant_angle([rect(40, 20, ang)]) - ang) < 1e-6


def test_ang_diff90():
    assert m2s.ang_diff90(0.1, 0.1 + math.pi / 2) < 1e-9
    assert abs(m2s.ang_diff90(0.0, 0.3) - 0.3) < 1e-9


def test_orthogonalize_snaps_jagged_polygon():
    # 一个矩形，一条边上有个 0.5m 的台阶（噪声）和一条稍微斜的边
    pts = np.array([[0, 0], [20, 0.4], [20, 10], [12, 10], [12, 10.5], [8, 10.5], [8, 10], [0, 10]], float)
    out = m2s.orthogonalize(pts, 0.0)
    assert out is not None
    poly = Polygon(out)
    assert poly.is_valid
    assert len(out) == 4  # 台阶被抹平，只剩四个角
    assert abs(poly.area - 200) < 12


def test_orthogonalize_keeps_diagonal_edge():
    pts = np.array([[0, 0], [20, 0], [20, 10], [10, 20], [0, 20]], float)  # 一个切角
    out = m2s.orthogonalize(pts, 0.0)
    assert out is not None and len(out) == 5


def test_ortho_building_rejects_big_change_and_repairs_invalid():
    shell = rect(30, 20)
    poly = m2s.ortho_building(shell, [], 0.0, True)
    assert isinstance(poly, Polygon) and abs(poly.area - 600) < 1
    # 关闭直角化: 原样返回
    poly2 = m2s.ortho_building(shell, [], 0.0, False)
    assert abs(poly2.area - 600) < 1e-6
    # 自交的蝴蝶结轮廓也能修成一个 Polygon
    bow = np.array([[0, 0], [10, 10], [10, 0], [0, 10]], float)
    assert isinstance(m2s.ortho_building(bow, [], 0.0, False), Polygon)


# ---------------------------------------------------------------------------
# 骨架图
# ---------------------------------------------------------------------------
def cross_mask(w=200, h=200, rw=14):
    mask = np.zeros((h, w), np.uint8)
    mask[h // 2 - rw // 2:h // 2 + rw // 2, :] = 255
    mask[:, w // 2 - rw // 2:w // 2 + rw // 2] = 255
    return mask


def test_skeleton_graph_of_cross_has_one_junction_and_four_arms():
    sk = m2s.skeletonize_mask(cross_mask())
    assert sk is not None
    nodes, edges = m2s.skeleton_graph(sk)
    dt = m2s.cv2.distanceTransform(cross_mask(), m2s.cv2.DIST_L2, 5)
    edges, deg, width_of = m2s.prune_and_merge(nodes, edges, dt)
    junctions = [n for n, d in deg.items() if d >= 3]
    assert len(junctions) == 1
    assert deg[junctions[0]] == 4
    assert len(edges) == 4
    jx, jy = nodes[junctions[0]]
    assert abs(jx - 100) < 3 and abs(jy - 100) < 3
    for _, _, pts in edges:
        assert 12 <= width_of(pts) <= 16  # 路宽估计 ≈ 14px


def test_prune_removes_short_spur():
    mask = cross_mask()
    mask[100 - 7:100 + 7, 100:112] = 255  # 路口旁一个 12px 的短毛刺（短于 1.2 倍路宽）
    mask[:, 100 + 7:] = mask[:, 100 + 7:]  # 保持右臂
    sk = m2s.skeletonize_mask(mask)
    nodes, edges = m2s.skeleton_graph(sk)
    dt = m2s.cv2.distanceTransform(mask, m2s.cv2.DIST_L2, 5)
    edges, deg, _ = m2s.prune_and_merge(nodes, edges, dt)
    assert all(m2s.poly_len(e[2]) > 20 for e in edges)


def test_loop_without_nodes_becomes_self_edge():
    mask = np.zeros((200, 200), np.uint8)
    m2s.cv2.circle(mask, (100, 100), 60, 255, 14)
    sk = m2s.skeletonize_mask(mask)
    nodes, edges = m2s.skeleton_graph(sk)
    loops = [e for e in edges if e[0] == e[1]]
    assert len(loops) == 1
    assert abs(m2s.poly_len(loops[0][2]) - 2 * math.pi * 60) < 30


# ---------------------------------------------------------------------------
# 折线工具 / 输出
# ---------------------------------------------------------------------------
def test_point_at_and_cut_polyline():
    pts = np.array([[0, 0], [10, 0], [10, 10]], float)
    p, t = m2s.point_at(pts, 5)
    assert np.allclose(p, [5, 0]) and np.allclose(t, [1, 0])
    p, t = m2s.point_at(pts, 15)
    assert np.allclose(p, [10, 5]) and np.allclose(t, [0, 1])
    p, _ = m2s.point_at(pts, 99)  # 超出 → 终点
    assert np.allclose(p, [10, 10])
    cut = m2s.cut_polyline(pts, 5, 15)
    assert np.allclose(cut, [[5, 0], [10, 0], [10, 5]])
    assert abs(m2s.poly_len(cut) - 10) < 1e-9
    assert m2s.poly_len(pts[:1]) == 0.0


def test_geom_to_json_splits_multipolygon_and_drops_tiny():
    a = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)], [[(2, 2), (4, 2), (4, 4), (2, 4)]])
    tiny = Polygon([(50, 50), (50.5, 50), (50.5, 0.5 + 50), (50, 50.5)])
    out = m2s.geom_to_json(MultiPolygon([a, tiny]))
    assert len(out) == 1
    assert len(out[0]["polygon"]) == 4 and len(out[0]["holes"]) == 1
    assert m2s.geom_to_json(Polygon()) == []
