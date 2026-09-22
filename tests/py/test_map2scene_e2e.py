# -*- coding: utf-8 -*-
"""
map2scene.py 的端到端测试: 画一张最小的标记图（一条十字路口 + 三栋楼 + 一块绿地），
连同 sidecar 一起跑命令行，检查输出的 scene.json 结构，以及 sidecar 里的逐栋层数有没有生效。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

TOOLS = Path(__file__).resolve().parents[2] / "tools"


def draw_map():
    """600×400 像素、0.5 m/px（300m × 200m）的标记图，颜色都是 map2scene 默认调色板"""
    img = np.full((400, 600, 3), 235, np.uint8)
    img[180:220, :] = (255, 0, 0)  # 东西向车行道（蓝，BGR）
    img[:, 280:320] = (255, 0, 0)  # 南北向车行道
    img[60:140, 60:200] = (0, 0, 255)  # 商铺（红）
    img[60:120, 380:540] = (128, 255, 0)  # 住宅（春绿 #00FF80）
    img[260:340, 380:460] = (255, 0, 255)  # 写字楼（品红）
    img[260:360, 60:220] = (0, 255, 0)  # 绿化（绿）
    return img


@pytest.fixture(scope="module")
def scene(tmp_path_factory):
    d = tmp_path_factory.mktemp("m2s")
    cv2.imencode(".png", draw_map())[1].tofile(str(d / "m.png"))
    side = {"buildings": [
        {"at": [460, 90], "floors": 27},  # 住宅楼中间
        {"at": [420, 300], "floors": 12},  # 写字楼
        {"at": [300, 50], "floors": 40},  # 路上: 附近没有楼，应被忽略
    ]}
    (d / "side.json").write_text(json.dumps(side), "utf-8")
    out = d / "s.json"
    pr = subprocess.run([sys.executable, str(TOOLS / "map2scene.py"), str(d / "m.png"), "-o", str(out), "--mpp", "0.5",
                         "--sidecar", str(d / "side.json")], capture_output=True,
                        env={**os.environ, "PYTHONIOENCODING": "utf-8"})  # Windows 控制台默认 GBK，统一成 UTF-8
    assert pr.returncode == 0, pr.stderr.decode("utf-8", "replace")
    return json.loads(out.read_text("utf-8")), pr.stderr.decode("utf-8", "replace")


def test_structure(scene):
    s, _ = scene
    assert s["version"] == 4 and s["units"] == "m"
    kinds = sorted(b["kind"] for b in s["buildings"])
    assert kinds == ["block", "residential", "shop"]
    assert s["roadGraph"]["edges"], "道路骨架没识别出来"
    assert any(n["degree"] >= 3 for n in s["roadGraph"]["nodes"].values()), "十字路口没识别出来"
    assert s["crosswalks"] and s["lanes"] and s["doors"] and s["portals"]
    assert any(a["kind"] == "green" for a in s["areas"])


def test_building_geometry_in_meters(scene):
    s, _ = scene
    shop = next(b for b in s["buildings"] if b["kind"] == "shop")
    xs = [p[0] for p in shop["polygon"]]
    ys = [p[1] for p in shop["polygon"]]
    # 140 × 80 像素 × 0.5 = 70m × 40m（圆角 / 抗锯齿允许 2m 误差）
    assert max(xs) - min(xs) == pytest.approx(70, abs=2)
    assert max(ys) - min(ys) == pytest.approx(40, abs=2)


def test_sidecar_floors(scene):
    s, log = scene
    by = {b["kind"]: b for b in s["buildings"]}
    assert by["residential"]["floors"] == 27
    assert by["block"]["floors"] == 12
    assert by["shop"]["floors"] == 2  # 没给的保持默认（红色 = 2 层商铺）
    assert "sidecar 层数: 2 栋楼（共 3 条记录）" in log


def test_slender_building_is_capped(tmp_path):
    img = np.full((200, 300, 3), 235, np.uint8)
    img[90:110, :] = (255, 0, 0)  # 一条路
    img[40:50, 40:200] = (128, 255, 0)  # 5m 宽、80m 长的窄条住宅
    cv2.imencode(".png", img)[1].tofile(str(tmp_path / "m.png"))
    (tmp_path / "side.json").write_text(json.dumps({"buildings": [{"at": [120, 45], "floors": 40}]}), "utf-8")
    pr = subprocess.run([sys.executable, str(TOOLS / "map2scene.py"), str(tmp_path / "m.png"), "-o", str(tmp_path / "s.json"), "--mpp", "0.5",
                         "--sidecar", str(tmp_path / "side.json")], capture_output=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    assert pr.returncode == 0, pr.stderr.decode("utf-8", "replace")
    b = json.loads((tmp_path / "s.json").read_text("utf-8"))["buildings"][0]
    assert b["floors"] <= 8 * 5.5 / 3  # 最窄边约 5m（抗锯齿 / 圆角有点误差）
    assert "细长比上限" in pr.stderr.decode("utf-8", "replace")


def test_sidecar_footprints_keep_touching_houses_apart(tmp_path):
    img = np.full((200, 300, 3), 235, np.uint8)
    img[90:110, :] = (255, 0, 0)  # 一条路（标记图里只有路，楼全在 sidecar 里）
    cv2.imencode(".png", img)[1].tofile(str(tmp_path / "m.png"))
    side = {"footprints": [
        {"poly": [[40, 30], [70, 30], [70, 60], [40, 60]], "kind": "residential", "floors": 3},
        {"poly": [[70, 30], [100, 30], [100, 60], [70, 60]], "kind": "residential", "floors": 4},  # 紧挨着
        {"poly": [[150, 130], [230, 130], [230, 180], [150, 180]], "kind": "shop", "floors": 2},
    ]}
    (tmp_path / "side.json").write_text(json.dumps(side), "utf-8")
    pr = subprocess.run([sys.executable, str(TOOLS / "map2scene.py"), str(tmp_path / "m.png"), "-o", str(tmp_path / "s.json"), "--mpp", "0.5",
                         "--sidecar", str(tmp_path / "side.json")], capture_output=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    assert pr.returncode == 0, pr.stderr.decode("utf-8", "replace")
    s = json.loads((tmp_path / "s.json").read_text("utf-8"))
    assert len(s["buildings"]) == 3  # 两栋挨着的没被并成一栋
    assert sorted(b["floors"] for b in s["buildings"]) == [2, 3, 4]  # 层数原样保留
    assert "sidecar 单栋轮廓: 3 栋" in pr.stderr.decode("utf-8", "replace")
