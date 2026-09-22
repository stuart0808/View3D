# -*- coding: utf-8 -*-
"""
场景编辑器后端的测试:
    map2scene.match_drawn_road   骨架边 ↔ 画的路（几何重合、车道数、单行方向）
    drawscene.rasterize          矢量图 → 标记图（颜色、位置）+ sidecar（楼轮廓、道路属性）
    drawscene.validate           不合法的矢量图给中文提示
    drawscene.build              端到端: 画两条路 + 两栋楼 → scene.json（车道数、单行方向、层数、店门、底图、经纬度）
    sat_server.build_drawing     场景名校验、索引跳过 _drawing.json
"""
import base64  # 造一张 data URL 底图
import json  # 读生成的场景
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]  # 仓库根目录
sys.path.insert(0, str(ROOT / "tools"))  # map2scene / sat_server 在 tools/
sys.path.insert(0, str(ROOT / "editor" / "backend"))  # drawscene 在编辑器自己的目录里
import drawscene as ds  # noqa: E402
import map2scene as m2s  # noqa: E402


def drawing(**kw):
    """
    300 × 200 米的小画布: 一条东西向双向 2+2 的路，一条南北向单行 3 车道（向南），
    路口东北角一栋 3 层商铺（带一个店门），西北角一栋住宅（不给层数），西南角一块公园
    """
    d = {"version": 1, "widthM": 300, "heightM": 200,
         "roads": [{"points": [[-150, 0], [150, 0]], "lanes": 2},
                   {"points": [[0, -100], [0, 100]], "lanes": 3, "oneway": True}],
         "buildings": [{"polygon": [[20, 15], [60, 15], [60, 40], [20, 40]], "kind": "shop", "floors": 3},
                       {"polygon": [[-60, 15], [-20, 15], [-20, 50], [-60, 50]], "kind": "residential"}],
         "areas": [{"polygon": [[-60, -60], [-20, -60], [-20, -20], [-60, -20]], "kind": "park"}],
         "doors": [{"pos": [40, 15]}], "portals": []}
    d.update(kw)  # 按需覆盖
    return d


# ---------------------------------------------------------------------------
# match_drawn_road
# ---------------------------------------------------------------------------
def test_match_drawn_road_lanes_and_direction():
    """重合的边拿到车道数；单行时按边的点序判断方向；不重合的边不匹配"""
    roads = [{"points": np.array([[0.0, 50], [200, 50]]), "width_px": 20, "lanes": 3, "oneway": True},  # 向东的单行路
             {"points": np.array([[100.0, 0], [100, 200]]), "width_px": 20, "lanes": 2, "oneway": False}]  # 南北向双向路
    east = np.array([[x, 51.0] for x in range(10, 90)])  # 沿东西路、向东（和画的方向一致）
    assert m2s.match_drawn_road(east, roads, 3) == (3, 1)
    assert m2s.match_drawn_road(east[::-1], roads, 3) == (3, -1)  # 同一条边、点序反过来
    north = np.array([[101.0, y] for y in range(120, 190)])
    assert m2s.match_drawn_road(north, roads, 3) == (2, 0)  # 双向路: 只给车道数
    far = np.array([[x, 150.0] for x in range(10, 60)])
    assert m2s.match_drawn_road(far, roads, 3) == (0, 0)  # 哪条都不重合
    assert m2s.match_drawn_road(east, [], 3) == (0, 0)  # 没画路（其他来源的场景）
    assert m2s.match_drawn_road(east[:1], roads, 3) == (0, 0)  # 退化边


# ---------------------------------------------------------------------------
# rasterize / validate
# ---------------------------------------------------------------------------
def test_rasterize_colors_and_sidecar():
    """路、公园、店门按调色板颜色画到对的位置；楼不画进标记图，走 sidecar；道路属性进 sidecar"""
    img, side, mpp = ds.rasterize(drawing())
    H, W = img.shape[:2]
    assert mpp == 0.25 and (W, H) == (1200, 800)  # 300 × 200 米，0.25 米/像素

    def at(x, y):
        """场景米处的像素颜色（BGR 元组）"""
        return tuple(int(v) for v in img[int(y / mpp + H / 2), int(x / mpp + W / 2)])

    pal = ds.palette()
    assert at(-100, 0) == pal[("road", None)]  # 东西路
    assert at(0, 80) == pal[("road", None)]  # 南北路
    assert at(-40, -40) == pal[("area", "park")]  # 公园
    assert at(40, 15) == pal[("door", None)]  # 店门圆点
    assert at(40, 30) == (0, 0, 0)  # 楼不画: 黑色 = 未标记
    assert at(-100, 50) == (0, 0, 0)  # 空地
    assert [f["kind"] for f in side["footprints"]] == ["shop", "residential"]
    assert side["footprints"][0]["floors"] == 3 and side["footprints"][1]["floors"] is None  # 没给层数交给 map2scene 按类型定
    assert side["footprints"][0]["poly"][0] == [680.0, 460.0]  # (20, 15) 米 → 像素
    assert side["roads"][1] == {"points": [[600.0, 0.0], [600.0, 800.0]], "width_m": 10.5, "lanes": 3, "oneway": True}


def test_rasterize_elevated_on_top_and_big_canvas():
    """高架盖在地面路上画，而且不进 sidecar roads；大画布自动降分辨率"""
    d = drawing(roads=[{"points": [[-150, 0], [150, 0]], "lanes": 2}, {"points": [[-150, 0], [150, 0]], "lanes": 1, "elevated": True}])
    img, side, mpp = ds.rasterize(d)
    H, W = img.shape[:2]
    assert tuple(int(v) for v in img[H // 2, W // 4]) == ds.palette()[("elevated", None)]  # 重叠处是高架色
    assert len(side["roads"]) == 1  # 只有地面路
    _, _, mpp2 = ds.rasterize(drawing(widthM=2000, heightM=1000))
    assert mpp2 == 0.5  # 2000 米 / 4000 像素


@pytest.mark.parametrize("bad, msg", [
    ({"widthM": 5}, "画布宽高"),
    ({"roads": [], "buildings": []}, "至少画一条路或一栋楼"),
    ({"roads": [{"points": [[0, 0]]}]}, "道路"),
    ({"buildings": [{"polygon": [[0, 0], [1, 0], [1, 1]], "kind": "castle"}]}, "建筑类型"),
    ({"areas": [{"polygon": [[0, 0], [1, 0], [1, 1]], "kind": "lava"}]}, "区域类型"),
    ({"doors": [{"pos": [0, float("nan")]}]}, "点"),
])
def test_validate_rejects_bad_drawings(bad, msg):
    """每种不合法的输入都给出对应的中文提示"""
    with pytest.raises(ValueError, match=msg):
        ds.validate(drawing(**bad))


# ---------------------------------------------------------------------------
# build（端到端，跑 map2scene 子进程）
# ---------------------------------------------------------------------------
def test_build_end_to_end(tmp_path):
    """车道数、单行方向、层数、店门都按画的来；底图存成文件；经纬度原图尺寸保留；另存矢量图"""
    png = cv2.imencode(".png", np.full((20, 30, 3), 128, np.uint8))[1].tobytes()
    origin = {"geo": {"type": "webmerc", "lat": 31.2, "lon": 121.5, "zoom": 18}, "summary": {"width": 1000, "height": 600, "mpp": 0.3, "buildings": 99}}
    d = drawing(background={"dataUrl": "data:image/png;base64," + base64.b64encode(png).decode()}, origin=origin)
    summary = ds.build(d, tmp_path / "t.json")
    s = json.loads((tmp_path / "t.json").read_text("utf-8"))
    assert summary["buildings"] == 2
    edges = s["roadGraph"]["edges"]
    ns = [e for e in edges if abs(e["points"][0][0]) < 1 and abs(e["points"][-1][0]) < 1]  # 南北向的边
    ew = [e for e in edges if e not in ns]
    assert ns and all(e["laneCount"] == 3 for e in ns) and all(e["laneCount"] == 2 for e in ew)
    for e in ns:  # 单行方向: 沿 oneway 指的方向走，y 要增大（向南）
        p0, p1 = (e["points"][0], e["points"][-1]) if e["oneway"] == 1 else (e["points"][-1], e["points"][0])
        assert p1[1] > p0[1]
    assert all("oneway" not in e for e in ew) and not any(e.get("roundabout") for e in edges)
    assert all(l.get("laneCount") in (2, 3) for l in s["lanes"])  # 渲染用的车道线也带车道数
    assert sorted((b["kind"], b["floors"]) for b in s["buildings"])[1] == ("shop", 3)
    shop = next(b for b in s["buildings"] if b["kind"] == "shop")
    assert [dd["pos"] for dd in s["doors"] if dd["building"] == shop["id"]] == [[40.0, 15.0]]  # 手标的店门替换自动布门
    assert s["imagery"] == {"url": "t_bg.png", "widthM": 300, "heightM": 200} and (tmp_path / "t_bg.png").exists()
    assert s["origin"]["source"] == "drawing" and s["origin"]["summary"]["mpp"] == 0.3 and s["origin"]["summary"]["buildings"] == 2
    saved = json.loads((tmp_path / "t_drawing.json").read_text("utf-8"))
    assert saved["background"] == {"url": "t_bg.png"} and len(saved["roads"]) == 2  # dataUrl 换成了文件名


def test_build_rejects_missing_background(tmp_path):
    """底图只能引用同目录下存在的文件（防止拼路径读到别处）"""
    with pytest.raises(ValueError, match="底图"):
        ds.build(drawing(background={"url": "../secret.jpg"}), tmp_path / "t.json")


def test_server_build_drawing(tmp_path, monkeypatch):
    """导入服务: 场景名校验；生成后进索引，_drawing.json 不算场景"""
    import sat_server as sv  # 在测试里导入，monkeypatch 改模块全局
    monkeypatch.setattr(sv, "OUT", tmp_path)  # 输出到临时目录
    with pytest.raises(ValueError):
        sv.build_drawing("../x", drawing())  # 场景名不合法
    sid, summary = sv.build_drawing("drawn_1", drawing())
    assert sid == "imported/drawn_1" and summary["buildings"] == 2
    assert [x["id"] for x in sv.write_index()] == ["imported/drawn_1"]  # 只有场景本身
