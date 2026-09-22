# -*- coding: utf-8 -*-
"""osm.py 的测试: 坐标系换算、地理参考、Overpass 结果解析（用手写的假数据，不联网）、路网自动对齐。"""
import math
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import osm  # noqa: E402


def test_gcj02_roundtrip_and_offset():
    lon, lat = 121.4737, 31.2304  # 上海人民广场附近
    g = osm.wgs84_to_gcj02(lon, lat)
    # 上海的火星偏移大约向东南几百米: 经度 +0.004~0.005，纬度 −0.002~−0.003
    assert 0.003 < g[0] - lon < 0.006 and -0.004 < g[1] - lat < -0.001
    back = osm.gcj02_to_wgs84(*g)
    assert back[0] == pytest.approx(lon, abs=1e-6) and back[1] == pytest.approx(lat, abs=1e-6)
    assert osm.wgs84_to_gcj02(2.35, 48.85) == (2.35, 48.85)  # 国外不加密


def test_georef_lonlat_roundtrip_and_mpp():
    d = {"type": "lonlat", "lon0": 121.0, "lat0": 31.0, "dlon": 3e-6, "dlat": 2.7e-6}
    gr = osm.GeoRef(d, 1000, 800)
    x, y = gr.to_px(121.0 + 500 * 3e-6, 31.0 - 400 * 2.7e-6)
    assert (x, y) == pytest.approx((500, 400))
    assert gr.to_lonlat(500, 400) == pytest.approx((121.0015, 31.0 - 0.00108))
    s, w, n, e = gr.bbox()
    assert w == pytest.approx(121.0) and n == pytest.approx(31.0) and e == pytest.approx(121.003) and s == pytest.approx(31.0 - 800 * 2.7e-6)


def test_georef_webmerc_center_and_scale():
    gr = osm.GeoRef({"type": "webmerc", "lat": 31.23, "lon": 121.47, "zoom": 18, "scale": 1}, 1280, 800)
    assert gr.to_px(121.47, 31.23) == pytest.approx((640, 400))  # 中心点落在图中心
    # 18 级、北纬 31.23° 的分辨率 = 156543 × cos(lat) / 2^18 ≈ 0.51 m/px
    assert gr.mpp() == pytest.approx(156543.03392 * math.cos(math.radians(31.23)) / 2 ** 18, rel=0.01)
    hi = osm.GeoRef({"type": "webmerc", "lat": 31.23, "lon": 121.47, "zoom": 18, "scale": 2}, 1280, 800)
    assert hi.mpp() == pytest.approx(gr.mpp() / 2, rel=0.01)  # 高分屏截图分辨率翻倍
    lon, lat = gr.to_lonlat(100, 700)
    assert gr.to_px(lon, lat) == pytest.approx((100, 700), abs=1e-6)


def test_georef_gcj_datum_shifts_pixels():
    base = {"type": "webmerc", "lat": 31.23, "lon": 121.47, "zoom": 18}
    w = osm.GeoRef(base, 1000, 1000)
    g = osm.GeoRef(dict(base, datum="gcj02"), 1000, 1000)
    xw, yw = w.to_px(121.47, 31.23)
    xg, yg = g.to_px(121.47, 31.23)
    # 高德图上同一个 WGS84 点要往东南挪几百米（0.5 m/px 下几百像素）
    assert xg - xw > 500 and yg - yw > 200
    assert g.to_px(*g.to_lonlat(300, 300)) == pytest.approx((300, 300), abs=0.5)
    with pytest.raises(ValueError):
        osm.GeoRef({"type": "utm"}, 10, 10)


def fake_osm():
    """手写的 Overpass 结果: 一条主干路（有 lanes）、一段长高架、一条小河、一个公园、一栋 12 层的楼、一个停车场"""
    def geo(pts):
        return [{"lon": x, "lat": y} for x, y in pts]
    lo, la = 121.0, 31.0
    return {"elements": [
        {"type": "way", "tags": {"highway": "primary", "lanes": "6"}, "geometry": geo([(lo, la - 0.001), (lo + 0.002, la - 0.001)])},
        {"type": "way", "tags": {"highway": "motorway", "bridge": "yes", "layer": "1"}, "geometry": geo([(lo, la - 0.0015), (lo + 0.003, la - 0.0015)])},
        {"type": "way", "tags": {"highway": "footway"}, "geometry": geo([(lo, la), (lo + 0.001, la)])},  # 人行道: 不算车行道
        {"type": "way", "tags": {"waterway": "canal"}, "geometry": geo([(lo, la - 0.0005), (lo + 0.001, la - 0.0005)])},
        {"type": "way", "tags": {"leisure": "park"}, "geometry": geo([(lo, la), (lo + 0.0005, la), (lo + 0.0005, la - 0.0003), (lo, la)])},
        {"type": "way", "tags": {"building": "apartments", "building:levels": "12"},
         "geometry": geo([(lo + 0.001, la), (lo + 0.0012, la), (lo + 0.0012, la - 0.0002), (lo + 0.001, la - 0.0002), (lo + 0.001, la)])},
        {"type": "way", "tags": {"amenity": "parking"}, "geometry": geo([(lo, la), (lo + 1e-4, la), (lo + 1e-4, la - 1e-4), (lo, la)])},
        {"type": "relation", "tags": {"natural": "water"}, "members": [
            {"role": "outer", "geometry": geo([(lo + 0.002, la), (lo + 0.0025, la), (lo + 0.0025, la - 0.0003), (lo + 0.002, la)])},
            {"role": "inner", "geometry": geo([(lo + 0.0021, la - 1e-4), (lo + 0.0022, la - 1e-4), (lo + 0.0022, la - 2e-4), (lo + 0.0021, la - 1e-4)])}]},
    ]}


def test_features_parsing():
    gr = osm.GeoRef({"type": "lonlat", "lon0": 121.0, "lat0": 31.0, "dlon": 3e-6, "dlat": 2.7e-6}, 1200, 800)
    f = osm.features(fake_osm(), gr)
    assert len(f["roads"]) == 2  # 人行道不算
    prim = next(r for r in f["roads"] if r["cls"] == "primary")
    assert prim["width_m"] == pytest.approx(6 * 3.5 + 1) and not prim["elevated"]
    mw = next(r for r in f["roads"] if r["cls"] == "motorway")
    assert mw["elevated"]  # 长桥（约 290m）+ 高等级 = 高架
    assert len(f["waterways"]) == 1 and f["waterways"][0]["width_m"] == 10
    assert len(f["park"]) == 1 and len(f["parking"]) == 1 and len(f["water"]) == 1  # relation 只取外环
    b = f["buildings"][0]
    assert b["kind"] == "residential" and b["floors"] == 12
    assert f["buildings"][0]["poly"][0] == pytest.approx((1000 / 3, 0))  # 经纬度 → 像素


def test_shift_moves_everything():
    gr = osm.GeoRef({"type": "lonlat", "lon0": 121.0, "lat0": 31.0, "dlon": 3e-6, "dlat": 2.7e-6}, 1200, 800)
    f = osm.features(fake_osm(), gr)
    g = osm.shift(f, 5, -3)
    assert g["roads"][0]["pts"][0] == pytest.approx(f["roads"][0]["pts"][0] + [5, -3])
    assert g["buildings"][0]["poly"][0] == pytest.approx(f["buildings"][0]["poly"][0] + [5, -3])
    assert g["park"][0][0] == pytest.approx(f["park"][0][0] + [5, -3])


def test_align_roads_recovers_offset():
    # 合成图: 绿色底上画两条灰色的路（十字）；OSM 路网故意偏 (−12, +8) 像素，对齐应该把它挪回去
    img = np.zeros((400, 400, 3), np.uint8)
    img[:] = (40, 140, 40)
    img[190:210, :] = 150
    img[:, 190:210] = 150
    feats = {"roads": [dict(pts=np.array([[0.0, 208.0], [400.0, 208.0]]), width_m=6, elevated=False),
                       dict(pts=np.array([[188.0, 0.0], [188.0, 400.0]]), width_m=6, elevated=False)]}
    dx, dy, gain = osm.align_roads(img, feats, 0.5, search_m=15)
    assert abs(dx - 12) <= 1 and abs(dy + 8) <= 1 and gain > 0.08  # 路面 20 像素宽，对到路中间 ±1 像素
    # 路太短: 不对齐
    short = {"roads": [dict(pts=np.array([[0.0, 0.0], [10.0, 0.0]]), width_m=6, elevated=False)]}
    assert osm.align_roads(img, short, 0.5) == (0, 0, 0.0)


def test_road_likelihood_prefers_gray():
    img = np.zeros((20, 40, 3), np.uint8)
    img[:, :20] = 150  # 灰色路面
    img[:, 20:] = (40, 160, 40)  # 植被
    like = osm.road_likelihood(img)
    assert like[10, 5] > 0.8 and like[10, 35] < 0.2
