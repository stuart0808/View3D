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
    """没有影子 / OSM 层数时按占地面积猜层数

    小房子是独栋民房（3 层），中等的是多层住宅（6 层），特别大的多半是厂房仓库（2 层）；
    商铺一律 2 层。
    """
    assert autoscene.default_floors(120, "residential") == 3  # 独栋民房
    assert autoscene.default_floors(600, "residential") == 6  # 多层住宅
    assert autoscene.default_floors(3000, "residential") == 2  # 厂房 / 仓库
    assert autoscene.default_floors(100, "shop") == 2


def test_square_pixels():
    """经纬度网格的图东西向要乘 cos(纬度) 才是正方形像素

    北纬 60° 时东西向像素只有南北向一半长，宽度应该缩到一半、dlon 翻倍；
    没有地理参考或者在赤道上时原图原样返回（同一个对象，不复制）。
    """
    img = np.zeros((100, 200, 3), np.uint8)
    geo = {"type": "lonlat", "lon0": 121.0, "lat0": 60.0, "dlon": 1e-5, "dlat": 1e-5}  # 北纬 60°: 东西向像素只有一半长
    out, g = autoscene.square_pixels(img, geo)
    assert out.shape[1] == 100 and g["dlon"] == pytest.approx(2e-5)
    assert autoscene.square_pixels(img, None)[0] is img
    eq = dict(geo, lat0=0.0)  # 赤道: 本来就是正方形
    assert autoscene.square_pixels(img, eq)[0] is img


def test_build_labels_osm_priority_and_roads():
    """标签图拼接: OSM 建筑优先、路压在楼上时抠掉楼、水道画成水

    图像识别的楼和 OSM 那栋重叠就丢掉（OSM 的轮廓和层数更可靠）；
    压在路上的那部分建筑像素让给路，剩下的仍是住宅；最终层数一栋来自 OSM、一栋按面积。
    """
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
    """shape 大小的布尔图上画一个 [x0, x1) × [y0, y1) 的实心矩形
    """
    m = np.zeros(shape, bool)
    m[y0:y1, x0:x1] = True
    return m


def test_run_pipeline_color_fallback(tmp_path):
    """整条流水线（颜色兜底方法，不需要权重、不联网）

    检查: 至少识别出两栋楼；场景 JSON 带底图信息（米为单位的宽高）；
    底图和预览图都写出来了；进度回调从「读图」开始到「完成」结束；不给比例尺报 ValueError。
    """
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
    """屋顶网络能前向，输出和输入同样大小（96×128 不是 32 的倍数也行）
    """
    torch = pytest.importorskip("torch")
    m = roofnet.build_model(pretrained=False).eval()
    with torch.no_grad():
        y = m(torch.zeros(1, 3, 96, 128))
    assert tuple(y.shape) == (1, 2, 96, 128)


def test_augment_shapes_and_labels():
    """训练增广: 输出裁成指定尺寸，标签只剩 0 / 1 / 2 三个值

    缩放、旋转用最近邻插值，不能插出 0.5 这种不存在的类别。
    """
    import random
    img = np.random.default_rng(0).integers(0, 255, (300, 280, 3), np.uint8)
    mask = np.zeros((300, 280), np.uint8)
    mask[50:150, 50:150] = 1
    mask[50, 50:150] = 2
    a, m = roofnet.augment(img, mask, random.Random(1), 128)
    assert a.shape == (128, 128, 3) and m.shape == (128, 128)
    assert set(np.unique(m)) <= {0, 1, 2}


def test_instances_splits_touching_buildings():
    """概率图 → 单栋: 一条连着的屋顶被中间的边界拆成两栋

    两栋的左上角 x 一个是 20，另一个在边界附近；全零的概率图返回空列表。
    """
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
    """导入服务: 参数校验、建 job、场景索引

    米/像素模式和网络截图模式都能建 job，参考层数能透传；
    场景名带路径、没有比例尺（又不是 GeoTIFF）都拒绝；
    索引跳过 *_sidecar.json，只列真正的场景。
    """
    import sat_server as sv
    monkeypatch.setattr(sv, "OUT", tmp_path)
    q = {"name": ["ok_1"], "mpp": ["0.3"]}
    jid = sv.make_job(q, b"img", ".jpg")
    j = sv.jobs[jid]
    assert j["mpp"] == 0.3 and j["geo"] is None and j["state"] == "queued" and Path(j["image"]).read_bytes() == b"img"
    web = sv.jobs[sv.make_job({"name": ["w"], "lat": ["31"], "lon": ["121"], "zoom": ["18"], "datum": ["gcj02"], "ref_floors": ["18"]}, b"x", ".png")]
    assert web["ref_floors"] == 18.0 and j["ref_floors"] is None
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
    """评测指标: 一个命中、一个误报、一个漏检 → 精确率 / 召回率都是 0.5

    hits 按预测顺序标出哪些命中，画评测图时用。
    """
    inst = np.zeros((50, 100), np.int32)
    inst[10:30, 10:30] = 1
    inst[10:30, 60:90] = 2
    pred = [sg.crop(_rect(10, 10, 30, 32, (50, 100))), sg.crop(_rect(40, 40, 45, 45, (50, 100)))]  # 一个命中、一个误报
    r = eb.score(pred, inst)
    assert (r["tp"], r["fp"], r["fn"]) == (1, 1, 1)
    assert r["P"] == 0.5 and r["R"] == 0.5 and r["cover_R"] == 0.5
    assert r["hits"] == [True, False]


def test_stretch_16bit():
    """16 位卫星图拉伸到 8 位: 两端百分位映射到 0 和 255
    """
    a = np.zeros((10, 10, 3), np.uint16)
    a[..., :] = np.linspace(300, 700, 100).reshape(10, 10, 1).astype(np.uint16)
    out = fs.stretch(a)
    assert out.dtype == np.uint8 and out.min() == 0 and out.max() == 255


def test_tile_origin_parses_geotiff_header(monkeypatch):
    """只读 GeoTIFF 文件头就能拿到左上角经纬度和像素大小

    下载时用 HTTP Range 只取头部几 KB，这里用假的 http 函数返回整个内存文件。
    """
    tifffile = pytest.importorskip("tifffile")
    buf = io.BytesIO()
    tifffile.imwrite(buf, np.zeros((8, 8, 3), np.uint16), extratags=[
        (33550, 12, 3, (2.7e-6, 2.7e-6, 0.0), False), (33922, 12, 6, (0.0, 0.0, 0.0, 121.5, 31.25, 0.0), False)])
    data = buf.getvalue()
    monkeypatch.setattr(fs, "http", lambda url, rng=None, **k: data[rng[0]:rng[1] + 1] if rng else data)
    assert fs.tile_origin("x") == pytest.approx((121.5, 31.25, 2.7e-6, 2.7e-6))


def test_clean_roads_keeps_long_strips_only():
    """网络识别的路要清理: 被车遮断的短缺口连上，孤立的小块丢掉
    """
    prob = np.zeros((200, 300), np.float32)
    prob[95:105, :] = 0.9  # 一条 300 像素长的路
    prob[95:105, 140:143] = 0.1  # 被一辆车遮断 3 像素
    prob[20:30, 20:40] = 0.9  # 院子里的一小块水泥地
    m = autoscene.clean_roads(prob, 0.5)
    assert m[100, :].all()  # 缺口被连上
    assert not m[25, 30]  # 小块丢掉


def test_build_labels_uses_image_roads_only_without_osm():
    """图像识别的路只在没有 OSM 路网时使用，而且不切楼

    网络常把高楼立面误认成路，所以楼优先；OSM 路网够用时完全不用图像的路。
    """
    img = np.full((200, 200, 3), 150, np.uint8)
    roads = np.zeros((200, 200), bool)
    roads[95:105, :] = True
    crop = sg.crop(_rect(120, 80, 150, 125))
    lab, _ = autoscene.build_labels(img, 0.5, [crop], None, roads)
    assert lab[100, 10] == CID["road"]  # 楼外面是路
    assert lab[100, 130] == CID["residential"] and lab[90, 130] == CID["residential"]  # 网络的路不切楼: 楼优先
    feats = {k: [] for k in ("roads", "water", "green", "park", "parking", "plaza", "buildings", "waterways")}
    feats["roads"] = [dict(pts=np.array([[0.0, 30.0 + 40 * i], [200.0, 30.0 + 40 * i]]), cls="residential", width_m=4, oneway=False, elevated=False) for i in range(3)]
    lab2, _ = autoscene.build_labels(img, 0.5, [], feats, roads)
    assert lab2[100, 10] != CID["road"]  # OSM 有路网时不用图像识别的路


def test_three_channel_training_inherits_two_channel_weights(tmp_path, monkeypatch):
    """第二版（3 通道，加道路）从第一版（2 通道）权重继承着训练

    造两张建筑瓦片和两张道路瓦片，训练 2 步:
      新权重是 3 通道；前两个输出通道和旧权重接近；predict 返回 3 张概率图。
    """
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


def test_merge_sam_prefers_whole_towers():
    """高层场景合并: SAM 的整栋塔楼替换网络的碎屋顶，网络独有的小楼保留

    SAM 只盖住小楼一半的那块算重复，不再加一栋。
    """
    shape = (100, 100)
    tower = sg.crop(_rect(10, 10, 50, 40, shape))  # SAM: 整栋塔楼
    frag = sg.crop(_rect(15, 15, 30, 25, shape))  # 网络: 塔楼上的一块碎屋顶
    house = sg.crop(_rect(70, 70, 90, 90, shape))  # 网络: SAM 没找到的一栋小楼
    dup = sg.crop(_rect(70, 70, 80, 90, shape))  # SAM: 只盖住小楼的一半（小楼保留，这块算重复不加）
    got = autoscene.merge_sam([frag, house], [tower, dup], shape)
    assert sorted((c[0], c[1]) for c in got) == [(10, 10), (70, 70)]


def test_tall_scene_detection():
    """高层场景判定: 要有明显的楼影暗峰（够多、够大的黑块）

    亮地面没有暗峰 → 不是；加上 12 块大楼影 → 是。
    """
    rng = np.random.default_rng(0)
    img = rng.integers(120, 200, (400, 400, 3)).astype(np.uint8)  # 亮地面，没有暗峰
    assert not autoscene.tall_scene(img, 0.5)
    for k in range(12):  # 12 块又大又黑的楼影
        y, x = 20 + (k // 4) * 120, 20 + (k % 4) * 95
        img[y:y + 60, x:x + 40] = 20
    assert autoscene.tall_scene(img, 0.5)


def test_fill_tall_uses_median_for_hidden_big_towers():
    """高层场景里估不出层数的大楼取同片中位数，小楼仍留给按面积的默认值

    三栋估出来的楼 10 / 20 / 30 层（中位数 20）；一栋 50×50 像素 × 0.5 m = 625㎡ 的大楼没估出 → 20 层；
    一栋 10×10 像素 = 25㎡ 的小房子没估出 → 仍是 None。一栋都没估出时原样返回。
    """
    big = sg.crop(_rect(0, 0, 50, 50, (100, 100)))  # 625㎡
    small = sg.crop(_rect(60, 60, 70, 70, (100, 100)))  # 25㎡
    got = autoscene.fill_tall([10, 20, 30, None, None], [big, big, big, big, small], 0.5)
    assert got == [10, 20, 30, 20, None]
    assert autoscene.fill_tall([None, None], [big, small], 0.5) == [None, None]
