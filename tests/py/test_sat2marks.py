# -*- coding: utf-8 -*-
"""
sat2marks.py 不依赖 SAM 的部分: 漫水填充后端、掩膜整理、自动植被、会话的涂色 / 撤销 / 保存 / 续标、导出的标记图能被 map2scene 归类。
"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import sat2marks as s2m  # noqa: E402
import map2scene as m2s  # noqa: E402

cv2 = s2m.cv2


def sat_image():
    """一张 160x120 的假卫星图: 灰底、一块深色屋顶、一片绿色植被、一条浅灰道路"""
    img = np.full((120, 160, 3), (150, 150, 150), np.uint8)
    img[20:60, 20:80] = (60, 70, 80)  # 屋顶
    img[70:110, 20:140] = (40, 150, 40)  # 植被 (BGR)
    img[10:16, 0:160] = (190, 190, 190)  # 路
    return img


def make_session(tmp_path, img=None):
    path = tmp_path / "sat.png"
    s2m.imwrite_unicode(path, sat_image() if img is None else img)
    args = SimpleNamespace(mpp=0.5, width_m=None, out_dir=None, no_sam=True, model=None, device=None)
    return s2m.Session(path, args)


def test_hex_bgr():
    assert s2m.hex_bgr("#FF8000") == (0, 128, 255)


def test_flood_backend_positive_and_negative_points():
    be = s2m.FloodBackend(sat_image())
    m = be.segment([(40, 40, 1)], tol=12)
    assert m[40, 40] and not m[100, 100]
    assert 60 * 40 * 0.8 < m.sum() < 60 * 40 * 1.3
    # 负样本把同一块减掉
    assert not s2m.FloodBackend(sat_image()).segment([(40, 40, 1), (45, 45, 0)], tol=12).any()


def test_tidy_mask_keeps_component_with_positive_point_and_fills_building_holes():
    mask = np.zeros((100, 100), bool)
    mask[10:50, 10:50] = True
    mask[20:30, 20:30] = False  # 天窗
    mask[70:90, 70:90] = True  # 另一个没有点的块
    out = s2m.tidy_mask(mask, [(15, 15, 1)], is_building=True)
    assert out[25, 25]  # 洞被填实
    assert not out[80, 80]  # 无点的块被丢掉
    out2 = s2m.tidy_mask(mask, [(15, 15, 1)], is_building=False)
    assert not out2[25, 25]  # 非建筑保留洞


def test_auto_vegetation_finds_green_and_classifies_park_by_size():
    img = np.full((400, 400, 3), (150, 150, 150), np.uint8)
    img[20:60, 20:60] = (40, 150, 40)  # 40x40 px @0.5 = 400㎡ → 绿化带
    img[100:380, 100:380] = (40, 150, 40)  # 280x280 px = 19600㎡，宽 140m → 公园
    green, park = s2m.auto_vegetation(img, 0.5)
    assert green[40, 40] and not park[40, 40]
    assert park[240, 240] and not green[240, 240]
    assert not green[10, 10] and not park[10, 10]


def test_session_paint_protect_undo_and_patch(tmp_path):
    S = make_session(tmp_path)
    assert S.backend.name.startswith("漫水")
    bld = np.zeros((S.h, S.w), bool)
    bld[20:60, 20:80] = True
    p = S.paint(bld, 1)
    assert p["bbox"] == [20, 20, 60, 40]
    assert (S.labels[20:60, 20:80] == 1).all()
    # 道路盖上去时保护建筑
    road = np.zeros((S.h, S.w), bool)
    road[0:120, 40:50] = True
    S.paint(road, 4, protect_buildings=True)
    assert (S.labels[20:60, 40:50] == 1).all() and (S.labels[0:20, 40:50] == 4).all()
    # 不保护则覆盖
    S.paint(road, 4, protect_buildings=False)
    assert (S.labels[20:60, 40:50] == 4).all()
    # 撤销两步回到只有建筑
    assert S.do_undo()["ok"] and S.do_undo()["ok"]
    assert (S.labels[20:60, 20:80] == 1).all() and (S.labels[0:20, 40:50] == 0).all()
    assert S.do_undo()["ok"] and not S.labels.any()
    assert S.do_undo() == {"ok": False}


def test_session_dots_undo(tmp_path):
    S = make_session(tmp_path)
    S.dots.append({"kind": "door", "x": 5, "y": 5})
    S.undo.append(("dot",))
    assert S.do_undo()["dots"] == []


def test_session_save_and_resume(tmp_path):
    S = make_session(tmp_path)
    bld = np.zeros((S.h, S.w), bool)
    bld[20:60, 20:80] = True
    S.paint(bld, 1)
    S.dots.append({"kind": "portal", "x": 100.0, "y": 100.0})
    S.mpp = 0.42
    marks = S.save()
    assert marks.exists() and S.labels_file.exists() and S.meta_file.exists()
    meta = json.loads(S.meta_file.read_text("utf-8"))
    assert meta["mpp"] == 0.42 and meta["dots"][0]["kind"] == "portal"
    # 新会话自动续标
    S2 = make_session(tmp_path)
    assert (S2.labels == S.labels).all()
    assert S2.mpp == 0.42 and S2.dots == S.dots
    # 导出的标记图能被 map2scene 认出建筑和出入口
    rgba = m2s.imread_unicode(marks)
    cls = m2s.classify(rgba, m2s.DEFAULT_MARKERS, 100)
    kinds = {m["layer"] for i, m in enumerate(m2s.DEFAULT_MARKERS) if (cls == i).any()}
    assert {"building", "portal"} <= kinds
    assert m2s.DEFAULT_MARKERS[cls[40, 50]]["layer"] == "building"


def test_lut_matches_map2scene_palette():
    m2s_colors = {m["color"].upper() for m in m2s.DEFAULT_MARKERS}
    for c in s2m.CLASSES:
        assert c["color"].upper() in m2s_colors, c
    for c in s2m.DOT_COLORS.values():
        assert c.upper() in m2s_colors
