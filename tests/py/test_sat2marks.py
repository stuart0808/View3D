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
    marks, side = S.save()
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


# ---------------------------------------------------------------------------
# 自动候选 / 校准 / 层数 / 倾斜校正（合成一栋「歪」的高楼）
# ---------------------------------------------------------------------------
import satgeo as sg  # noqa: E402

LEAN = (0.0, -0.5)  # 每米高度屋顶往上挪 0.5 像素
SUN = (-0.6, -0.9)  # 每米高度影子往左上伸
FOOT = (60, 70, 120, 90)  # 墙脚 x0, y0, x1, y1


def leaning_image(height=30.0):
    """160×120 的图: 一栋高 height 米的楼（剪影 = 墙脚沿倾斜方向扫过楼高）和它的影子"""
    fp = np.zeros((120, 160), bool)
    fp[FOOT[1]:FOOT[3], FOOT[0]:FOOT[2]] = True
    sil = sg._sweep(fp, LEAN, height, "or")
    shadow = sg._sweep(fp, SUN, height, "or") & ~sil
    img = np.full((120, 160, 3), 170, np.uint8)
    img[shadow] = 30
    img[sil] = 215
    return img, sil, fp


def test_candidates_accept_reject(tmp_path):
    S = make_session(tmp_path)
    a = np.zeros((S.h, S.w), bool); a[20:60, 20:80] = True
    b = np.zeros((S.h, S.w), bool); b[70:100, 100:140] = True
    S.cands = [dict(id=0, crop=sg.crop(a), score=0.9, area_m2=600, state="pending"),
               dict(id=1, crop=sg.crop(b), score=0.8, area_m2=300, state="pending")]
    assert [c["id"] for c in S.cand_list()] == [0, 1]
    assert S.cand_list()[0]["poly"]  # 轮廓点
    patch = S.cand_accept([0], 11)
    assert patch["bbox"] == [20, 20, 60, 40] and (S.labels[20:60, 20:80] == 11).all()
    S.cand_reject([1])
    assert S.cand_list() == []
    assert S.do_undo()["ok"] and not S.labels.any()  # 接受是一步撤销


def test_candidates_hidden_once_labelled(tmp_path):
    S = make_session(tmp_path)
    a = np.zeros((S.h, S.w), bool); a[20:60, 20:80] = True
    S.cands = [dict(id=0, crop=sg.crop(a), score=0.9, area_m2=600, state="pending")]
    S.paint(a, 3)  # 用户已经手工把这栋标了
    assert S.cand_list() == []


def test_building_list_and_floors(tmp_path):
    S = make_session(tmp_path)
    S.labels[20:60, 20:80] = 11
    S.labels[70:100, 100:140] = 3
    blds = S.building_list()
    assert sorted(b["cls"] for b in blds) == [3, 11]
    for b in blds:
        x0, y0, sub = b["crop"]
        assert sub[b["at"][1] - y0, b["at"][0] - x0]  # at 点在楼里
        assert b["floors"] is None
    S.floors = [{"x": 50, "y": 40, "floors": 20, "src": "auto"}]
    S.set_floors(30, 30, 26)  # 手填覆盖同一栋里的 auto 记录
    assert [f["floors"] for f in S.floors] == [26]
    got = {b["cls"]: b["floors"] for b in S.building_list()}
    assert got == {11: 26, 3: None}
    S.set_floors(30, 30, 0)  # 清掉
    assert S.floors == []


def test_lean_correction_and_sidecar(tmp_path):
    img, sil, fp = leaning_image(30)
    S = make_session(tmp_path, img)
    S.labels[sil] = 11
    # 没校准: 导出原样
    lab, _ = S.corrected_labels()
    assert (lab == S.labels).all()
    # 校准: 墙脚角 (60, 89) → 屋顶角 (60, 74)（30m × 0.5）→ 影子尖 (42, 62)，10 层 × 3m
    S.calib = {"base": [60, 89], "roof": [60, 74], "tip": [42, 62], "floors": 10}
    v = S.cal_vectors()["v"]
    assert v == pytest.approx(LEAN)
    S.floors = [{"x": 90, "y": 80, "floors": 10, "src": "manual"}]
    lab, blds = S.corrected_labels()
    got = lab == 11
    iou = (got & fp).sum() / (got | fp).sum()
    assert iou > 0.9  # 立面让出来了，剩下的就是墙脚
    assert (S.labels == 11).sum() == sil.sum()  # labels 本身没动
    marks, side = S.save()
    data = json.loads(side.read_text("utf-8"))
    assert data["buildings"][0]["floors"] == 10
    ax, ay = data["buildings"][0]["at"]
    assert fp[ay, ax]  # sidecar 的点落在墙脚里
    feet = S.footprint_polys()
    assert len(feet) == 1 and feet[0]["floors"] == 10


def test_lean_correction_uses_class_median_and_skips_unknown(tmp_path):
    img, sil, fp = leaning_image(30)
    S = make_session(tmp_path, img)
    S.labels[sil] = 11
    S.labels[5:15, 5:15] = 3  # 另一类、没有层数: 不校正
    S.calib = {"base": [60, 89], "roof": [60, 74], "tip": None, "floors": 10}
    lab, blds = S.corrected_labels()
    assert (lab == 11).sum() == sil.sum()  # 没有任何层数: 同类中位数也没有，不校正
    assert (lab[5:15, 5:15] == 3).all()


def test_heights_job_estimates_floors(tmp_path):
    img, sil, fp = leaning_image(30)
    S = make_session(tmp_path, img)
    S.labels[sil] = 11
    S.calib = {"base": [60, 89], "roof": [60, 74], "tip": [42, 62], "floors": 10}
    msg = S.run_heights(lambda *a: None)
    assert "1/1" in msg
    assert S.floors and S.floors[0]["src"] == "auto"
    assert S.floors[0]["floors"] == pytest.approx(10, abs=1)
    # 没有影子尖: 报错
    S.calib["tip"] = None
    with pytest.raises(ValueError):
        S.run_heights(lambda *a: None)


def test_job_runner_reports_progress_and_errors(tmp_path):
    import time as _t
    S = make_session(tmp_path)
    assert S.start_job("t", lambda prog: (prog(1, 2, "半"), "完成")[1]) == {"started": True}
    for _ in range(100):
        if not S.job["running"]:
            break
        _t.sleep(0.02)
    assert S.job["msg"] == "完成" and S.job["done"] == 1 and S.job["error"] is None
    S.start_job("坏", lambda prog: 1 / 0)
    for _ in range(100):
        if not S.job["running"]:
            break
        _t.sleep(0.02)
    assert "ZeroDivisionError" in S.job["error"]


def test_auto_buildings_without_sam(tmp_path):
    img = np.full((200, 300, 3), 60, np.uint8)  # 暗底（会被当阴影排除）
    img[20:60, 20:100] = 220  # 两个亮块
    img[100:150, 180:260] = 220
    S = make_session(tmp_path, img)
    msg = S.run_auto_buildings(lambda *a: None)
    assert "找到 2 个候选" in msg
    assert S.cands_file.exists()
    S2 = make_session(tmp_path, img)  # 缓存续用
    assert len(S2.cands) == 2


# ---------------------------------------------------------------------------
# HTTP 路由: 起一个真的本地服务，走一遍主要请求
# ---------------------------------------------------------------------------
def test_http_routes(tmp_path):
    import threading
    import urllib.request
    from http.server import ThreadingHTTPServer

    img, sil, fp = leaning_image(30)
    S = make_session(tmp_path, img)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), s2m.make_handler(S, None))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    def call(path, body=None):
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), method="GET" if body is None else "POST")
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())

    try:
        st = call("/state")
        assert st["width"] == 160 and st["calib"] is None and 11 in st["buildingIds"]
        assert call("/mpp_zoom", {"lat": 0, "zoom": 18})["mpp"] == pytest.approx(0.597, abs=1e-3)
        mask_pts = [[60, 60], [120, 60], [120, 90], [60, 90]]
        assert call("/polygon", {"cls": 11, "points": mask_pts})["patch"]
        r = call("/calib", {"base": [60, 89], "roof": [60, 74], "tip": [42, 62], "floors": 10})
        assert r["vectors"]["v"] == pytest.approx(list(LEAN))
        assert call("/floors", {"x": 90, "y": 80, "floors": 12})["floors"][0]["floors"] == 12
        assert call("/footprints")["feet"]
        assert call("/cands") == {"cands": []}
        assert call("/job")["running"] is False
        assert call("/export", {})["ok"]
        assert S.sidecar_file.exists()
    finally:
        srv.shutdown()


def test_median_floors_not_lent_to_fragments(tmp_path):
    img, sil, fp = leaning_image(30)
    S = make_session(tmp_path, img)
    S.labels[sil] = 11
    S.labels[5:9, 5:9] = 11  # 一块碎片（16 像素 < 20 不算楼）
    S.labels[100:106, 5:12] = 11  # 小碎片: 42 像素，远小于那栋楼
    S.calib = {"base": [60, 89], "roof": [60, 74], "tip": None, "floors": 10}
    S.floors = [{"x": 90, "y": 80, "floors": 10, "src": "manual"}]
    lab, blds = S.corrected_labels()
    frag = [b for b in blds if b["crop"][1] == 100][0]
    assert frag["floors"] is None and "foot" not in frag  # 没借中位数，也没被校正
    assert (lab[100:106, 5:12] == 11).all()
