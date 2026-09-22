# -*- coding: utf-8 -*-
"""
全自动流水线相关模块的测试（都不联网、不需要训练好的权重）:
    autoscene   默认层数、正方形像素、标注拼接（OSM 建筑优先、路上的建筑像素抠掉）、整条流水线（颜色兜底）
    roofnet     网络结构能前向、增广输出尺寸、概率图 → 单栋拆分
    sat_server  参数校验、建 job、场景索引
    eval        评测指标
    fetch       16 位拉伸、GeoTIFF 文件头解析
"""
import io
import json
import struct
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import autoscene  # noqa: E402
import eval_buildings as eb  # noqa: E402
import fetch_samples as fs  # noqa: E402
import roofnet  # noqa: E402
import satgeo as sg  # noqa: E402

CID = autoscene.CID


# ---------------------------------------------------------------------------
# autoscene
# ---------------------------------------------------------------------------
def test_default_floors():
    assert autoscene.default_floors(120, "residential") == 3  # 独栋民房
    assert autoscene.default_floors(600, "residential") == 6  # 多层住宅
    assert autoscene.default_floors(3000, "residential") == 2  # 厂房 / 仓库
    assert autoscene.default_floors(100, "shop") == 2


def test_square_pixels():
    img = np.zeros((100, 200, 3), np.uint8)
    geo = {"type": "lonlat", "lon0": 121.0, "lat0": 60.0, "dlon": 1e-5, "dlat": 1e-5}  # 北纬 60°: 东西向像素只有一半长
    out, g = autoscene.square_pixels(img, geo)
    assert out.shape[1] == 100 and g["dlon"] == pytest.approx(2e-5)
    assert autoscene.square_pixels(img, None)[0] is img
    eq = dict(geo, lat0=0.0)  # 赤道: 本来就是正方形
    assert autoscene.square_pixels(img, eq)[0] is img


def test_build_labels_osm_priority_and_roads():
    img = np.full((200, 200, 3), 150, np.uint8)
    feats = {k: [] for k in ("roads", "water", "green", "park", "parking", "plaza", "buildings", "waterways")}
    feats["roads"].append(dict(pts=np.array([[0.0, 100.0], [200.0, 100.0]]), cls="residential", width_m=6, oneway=False, elevated=False))
    feats["buildings"].append(dict(poly=np.array([[20.0, 20], [60, 20], [60, 60], [20, 60]]), kind="auto", floors=9))
    feats["waterways"].append(dict(pts=np.array([[180.0, 0.0], [180.0, 200.0]]), width_m=4))
    crops = [
        sg.crop(_rect(22, 22, 58, 58)),  # 和 OSM 那栋重叠: 丢掉
        sg.crop(_rect(120, 90, 140, 125)),  # 压在路上的部分要抠掉（剩约 130㎡ → 3 层）
    ]
    lab, blds = autoscene.build_labels(img, 0.5, crops, feats)
    assert (lab[30:50, 30:50] == CID["residential"]).all()  # OSM 建筑
    assert lab[100, 10] == CID["road"] and lab[100, 140] == CID["road"]  # 路上的建筑像素被路占着
    assert lab[115, 130] == CID["residential"]
    assert lab[50, 180] == CID["water"]
    assert sorted(b["floors"] for b in blds) == [3, 9]  # OSM 的层数 9；图像识别的 3（小房子）


def _rect(x0, y0, x1, y1, shape=(200, 200)):
    m = np.zeros(shape, bool)
    m[y0:y1, x0:x1] = True
    return m


def test_run_pipeline_color_fallback(tmp_path):
    img = np.full((300, 400, 3), (60, 130, 60), np.uint8)  # 绿地底
    img[40:100, 40:140] = (180, 180, 190)  # 两栋浅色屋顶
    img[160:240, 220:340] = (170, 175, 185)
    src = tmp_path / "t.png"
    cv2.imencode(".png", img)[1].tofile(str(src))
    stages = []
    res = autoscene.run(src, tmp_path / "out" / "t.json", mpp=0.5, method="color", progress=lambda s, p: stages.append(s))
    assert res["method"] == "color" and res["buildings"] >= 2 and not res["geo"]
    scene = json.loads((tmp_path / "out" / "t.json").read_text("utf-8"))
    assert scene["imagery"] == {"url": "t.jpg", "widthM": 200.0, "heightM": 150.0}
    assert (tmp_path / "out" / "t.jpg").exists() and (tmp_path / "out" / "t_preview.jpg").exists()
    assert stages[0] == "读图" and stages[-1] == "完成"
    with pytest.raises(ValueError):
        autoscene.run(src, tmp_path / "x.json", mpp=None)  # 不给比例尺


# ---------------------------------------------------------------------------
# roofnet（不需要权重的部分）
# ---------------------------------------------------------------------------
def test_model_forward_shape():
    torch = pytest.importorskip("torch")
    m = roofnet.build_model(pretrained=False).eval()
    with torch.no_grad():
        y = m(torch.zeros(1, 3, 96, 128))
    assert tuple(y.shape) == (1, 2, 96, 128)


def test_augment_shapes_and_labels():
    import random
    img = np.random.default_rng(0).integers(0, 255, (300, 280, 3), np.uint8)
    mask = np.zeros((300, 280), np.uint8)
    mask[50:150, 50:150] = 1
    mask[50, 50:150] = 2
    a, m = roofnet.augment(img, mask, random.Random(1), 128)
    assert a.shape == (128, 128, 3) and m.shape == (128, 128)
    assert set(np.unique(m)) <= {0, 1, 2}


def test_instances_splits_touching_buildings():
    pb = np.zeros((100, 160), np.float32)
    pe = np.zeros_like(pb)
    pb[20:60, 20:140] = 0.9  # 一整条连着的屋顶
    pe[20:60, 78:82] = 0.9  # 中间一条边界 → 两栋
    pe[20, 20:140] = pe[59, 20:140] = 0.9
    got = roofnet.instances(pb, pe, 0.5, min_m2=5)
    assert len(got) == 2
    xs = sorted(c[0] for c in got)
    assert xs[0] == 20 and 76 <= xs[1] <= 82
    assert roofnet.instances(np.zeros((10, 10), np.float32), np.zeros((10, 10), np.float32), 0.5) == []


# ---------------------------------------------------------------------------
# sat_server
# ---------------------------------------------------------------------------
def test_server_make_job_and_index(tmp_path, monkeypatch):
    import sat_server as sv
    monkeypatch.setattr(sv, "OUT", tmp_path)
    q = {"name": ["ok_1"], "mpp": ["0.3"]}
    jid = sv.make_job(q, b"img", ".jpg")
    j = sv.jobs[jid]
    assert j["mpp"] == 0.3 and j["geo"] is None and j["state"] == "queued" and Path(j["image"]).read_bytes() == b"img"
    web = sv.jobs[sv.make_job({"name": ["w"], "lat": ["31"], "lon": ["121"], "zoom": ["18"], "datum": ["gcj02"]}, b"x", ".png")]
    assert web["geo"] == {"type": "webmerc", "lat": 31.0, "lon": 121.0, "zoom": 18.0, "scale": 1, "datum": "gcj02"}
    with pytest.raises(ValueError):
        sv.make_job({"name": ["../evil"], "mpp": ["1"]}, b"x", ".jpg")  # 场景名会变成文件名，不许带路径
    with pytest.raises(ValueError):
        sv.make_job({"name": ["nompp"]}, b"x", ".jpg")  # 没有比例尺
    sv.make_job({"name": ["tif"]}, b"x", ".tif")  # GeoTIFF 可以不给
    (tmp_path / "a.json").write_text(json.dumps({"origin": {"source": "a.jpg", "summary": {"buildings": 3}}}), "utf-8")
    (tmp_path / "a_sidecar.json").write_text("{}", "utf-8")
    idx = sv.write_index()
    assert [d["id"] for d in idx] == ["imported/a"] and idx[0]["summary"]["buildings"] == 3
    while not sv.work.empty():  # 别让测试留下待处理的 job
        sv.work.get()


# ---------------------------------------------------------------------------
# 评测 / 下载
# ---------------------------------------------------------------------------
def test_eval_score():
    inst = np.zeros((50, 100), np.int32)
    inst[10:30, 10:30] = 1
    inst[10:30, 60:90] = 2
    pred = [sg.crop(_rect(10, 10, 30, 32, (50, 100))), sg.crop(_rect(40, 40, 45, 45, (50, 100)))]  # 一个命中、一个误报
    r = eb.score(pred, inst)
    assert (r["tp"], r["fp"], r["fn"]) == (1, 1, 1)
    assert r["P"] == 0.5 and r["R"] == 0.5 and r["cover_R"] == 0.5
    assert r["hits"] == [True, False]


def test_stretch_16bit():
    a = np.zeros((10, 10, 3), np.uint16)
    a[..., :] = np.linspace(300, 700, 100).reshape(10, 10, 1).astype(np.uint16)
    out = fs.stretch(a)
    assert out.dtype == np.uint8 and out.min() == 0 and out.max() == 255


def test_tile_origin_parses_geotiff_header(monkeypatch):
    tifffile = pytest.importorskip("tifffile")
    buf = io.BytesIO()
    tifffile.imwrite(buf, np.zeros((8, 8, 3), np.uint16), extratags=[
        (33550, 12, 3, (2.7e-6, 2.7e-6, 0.0), False), (33922, 12, 6, (0.0, 0.0, 0.0, 121.5, 31.25, 0.0), False)])
    data = buf.getvalue()
    monkeypatch.setattr(fs, "http", lambda url, rng=None, **k: data[rng[0]:rng[1] + 1] if rng else data)
    assert fs.tile_origin("x") == pytest.approx((121.5, 31.25, 2.7e-6, 2.7e-6))


def test_clean_roads_keeps_long_strips_only():
    prob = np.zeros((200, 300), np.float32)
    prob[95:105, :] = 0.9  # 一条 300 像素长的路
    prob[95:105, 140:143] = 0.1  # 被一辆车遮断 3 像素
    prob[20:30, 20:40] = 0.9  # 院子里的一小块水泥地
    m = autoscene.clean_roads(prob, 0.5)
    assert m[100, :].all()  # 缺口被连上
    assert not m[25, 30]  # 小块丢掉


def test_build_labels_uses_image_roads_only_without_osm():
    img = np.full((200, 200, 3), 150, np.uint8)
    roads = np.zeros((200, 200), bool)
    roads[95:105, :] = True
    crop = sg.crop(_rect(120, 80, 150, 125))
    lab, _ = autoscene.build_labels(img, 0.5, [crop], None, roads)
    assert lab[100, 10] == CID["road"] and lab[100, 130] == CID["road"]  # 路面盖掉楼的像素
    assert lab[90, 130] == CID["residential"]
    feats = {k: [] for k in ("roads", "water", "green", "park", "parking", "plaza", "buildings", "waterways")}
    feats["roads"] = [dict(pts=np.array([[0.0, 30.0 + 40 * i], [200.0, 30.0 + 40 * i]]), cls="residential", width_m=4, oneway=False, elevated=False) for i in range(3)]
    lab2, _ = autoscene.build_labels(img, 0.5, [], feats, roads)
    assert lab2[100, 10] != CID["road"]  # OSM 有路网时不用图像识别的路


def test_three_channel_training_inherits_two_channel_weights(tmp_path, monkeypatch):
    torch = pytest.importorskip("torch")
    bdir, rdir = tmp_path / "b", tmp_path / "r"
    bdir.mkdir(); rdir.mkdir()
    rng = np.random.default_rng(0)
    for i in range(2):  # 两张建筑瓦片、两张道路瓦片（随机图 + 简单掩膜）
        im = rng.integers(0, 255, (96, 96, 3), np.uint8)
        m = np.zeros((96, 96), np.uint8); m[20:60, 20:60] = 1; m[20, 20:60] = 2
        cv2.imencode(".jpg", im)[1].tofile(str(bdir / f"b{i}.jpg")); cv2.imencode(".png", m)[1].tofile(str(bdir / f"b{i}_mask.png"))
        r = np.zeros((96, 96), np.uint8); r[40:50, :] = 1
        cv2.imencode(".jpg", im)[1].tofile(str(rdir / f"r{i}.jpg")); cv2.imencode(".png", r)[1].tofile(str(rdir / f"r{i}_road.png"))
    monkeypatch.setattr(roofnet, "TRAIN_DIR", bdir)
    monkeypatch.setattr(roofnet, "ROAD_DIR", rdir)
    w2 = tmp_path / "w2.pt"
    monkeypatch.setattr(roofnet, "WEIGHTS", w2)
    m2 = roofnet.build_model(pretrained=False, n_out=2)
    roofnet.save(m2)  # 第一版（2 通道）权重
    w3 = tmp_path / "w3.pt"
    monkeypatch.setattr(roofnet, "WEIGHTS", w3)
    roofnet.train(iters=2, batch=2, size=64, roads=True, init=str(w2), log_every=1)
    ck = torch.load(w3, weights_only=False)
    assert ck["n_out"] == 3 and ck["state_dict"]["head.weight"].shape[0] == 3
    # 前两个输出通道和编码器继承自 2 通道权重（训练了 2 步，不会差太多）
    old = torch.load(w2, weights_only=False)["state_dict"]
    assert torch.allclose(ck["state_dict"]["head.weight"][:2].float(), old["head.weight"].float(), atol=0.05)
    roofnet._model_cache.clear()
    probs = roofnet.predict(np.zeros((70, 90, 3), np.uint8), 0.3, path=w3)
    assert len(probs) == 3 and probs[2].shape == (70, 90)
    roofnet._model_cache.clear()
