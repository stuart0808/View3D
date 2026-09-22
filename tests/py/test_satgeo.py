# -*- coding: utf-8 -*-
"""
satgeo.py 的测试。用合成图: 画一栋已知墙脚、已知高度的「楼」，按给定的倾斜向量画出屋顶 + 立面，
按影子向量画出地面上的影子，然后检查能不能把墙脚和高度反推回来。
"""
import math
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import satgeo as sg  # noqa: E402

W, H = 240, 200
V = (0.0, -0.5)  # 每米高度屋顶往上（北）挪 0.5 像素
S = (-0.6, -0.9)  # 每米高度影子往左上伸


def rect_mask(x0, y0, x1, y1):
    """[x0, x1) × [y0, y1) 的矩形掩膜"""
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = True
    return m


def scene(height=30.0, foot=(90, 110, 170, 140)):
    """
    合成一栋楼: 返回 (图像, 剪影, 墙脚)。
    地面浅灰，影子深灰（只画在地面上），剪影（屋顶 + 立面）浅色。
    """
    fp = rect_mask(*foot)
    sil = sg._sweep(fp, V, height, "or")  # 剪影 = 墙脚沿倾斜方向扫过楼高
    shadow = sg._sweep(fp, S, height, "or") & ~sil  # 影子 = 墙脚沿影子方向扫过楼高，被楼挡住的不算
    img = np.full((H, W, 3), 170, np.uint8)
    img[shadow] = 35
    img[sil] = 215
    return img, sil, fp


# ---------------------------------------------------------------------------
def test_mpp_from_zoom():
    """Web 墨卡托缩放级别 → 米/像素

    截图模式全靠它定比例尺，算错了整座城会放大缩小。
    检查三件事: 赤道 0 级的基准值、纬度余弦修正、高分屏倍率（scale=2 相当于再放大一级）。
    """
    # 赤道 0 级约 156543 m/px；每放大一级减半；纬度 60° 再乘 cos60° = 0.5
    assert sg.mpp_from_zoom(0, 0) == pytest.approx(156543.03392)
    assert sg.mpp_from_zoom(0, 18) == pytest.approx(0.597, abs=1e-3)
    assert sg.mpp_from_zoom(60, 18) == pytest.approx(0.2986, abs=1e-3)
    assert sg.mpp_from_zoom(0, 18, scale=2) == pytest.approx(0.2986, abs=1e-3)


def test_vegetation_and_dark_masks():
    """植被掩膜只认绿色，暗部掩膜只认真正的黑块

    合成图上半是绿地、左下是阴影、其余是灰色地面:
    植被只能出现在上半；自动阈值要落在合理区间并且只圈出左下；
    手动给极低阈值时应该什么都不选（证明手动阈值确实生效）。
    """
    img = np.full((40, 40, 3), 160, np.uint8)
    img[:20] = (40, 150, 40)  # 上半: 绿色（BGR）
    img[20:, :20] = (25, 25, 25)  # 左下: 阴影
    veg = sg.vegetation_mask(img)
    assert veg[5:15, 5:35].all() and not veg[25:, :].any()
    dk, thr = sg.dark_mask(img)
    assert 45 <= thr <= 95
    assert dk[25:35, 3:17].all() and not dk[25:35, 23:37].any()
    dk2, thr2 = sg.dark_mask(img, thr=10)  # 手动给阈值: 10 以下没有像素
    assert thr2 == 10 and not dk2.any()


def test_prompt_points_skip_excluded_and_margin():
    """SAM 提示点: 排除区（植被 / 阴影）里不放点，margin 让出图边

    排除区先腐蚀 3 像素再用，所以边界附近还能留点；
    不排除时 10 像素步长的 100×100 图正好 10×10 个点；
    margin=20 时所有点都在 [20, 80) 以内（贴边的点 SAM 容易切出半栋楼）。
    """
    img = np.zeros((100, 100, 3), np.uint8)
    ex = np.zeros((100, 100), bool)
    ex[:, :50] = True  # 左半边不放点
    pts = sg.prompt_points(img, 10, ex)
    assert len(pts) > 0
    assert (pts[:, 0] >= 47).all()  # 腐蚀 3 像素后，排除区边界附近（x≥47）的点可以保留
    assert len(sg.prompt_points(img, 10, np.zeros((100, 100), bool))) == 100
    pts_m = sg.prompt_points(img, 10, np.zeros((100, 100), bool), margin=20)
    assert (pts_m >= 20).all() and (pts_m < 80).all()


def test_features_and_score():
    """掩膜特征（面积 / 实心度 / 矩形度 / 长宽比）和建筑打分

    一个 60×30 的实心矩形应当是满分附近的楼；
    整块是绿的、细长条（像路）、太小的都应该给 0 分；空掩膜面积为 0 不报错。
    """
    veg = np.zeros((H, W), bool)
    dark = np.zeros((H, W), bool)
    box = rect_mask(50, 50, 110, 80)
    f = sg.mask_features(box, veg, dark, 0.5)
    assert f["area_m2"] == pytest.approx(60 * 30 * 0.25)
    assert f["solidity"] == pytest.approx(1, abs=0.05) and f["rect"] == pytest.approx(1, abs=0.05)
    assert f["elong"] == pytest.approx(2, abs=0.1)
    assert sg.building_score(f) > 0.9
    # 绿色的不要
    assert sg.building_score(sg.mask_features(box, box.copy(), dark, 0.5)) == 0
    # 细长条（路）不要
    assert sg.building_score(sg.mask_features(rect_mask(0, 10, 200, 14), veg, dark, 0.5)) == 0
    # 太小不要
    assert sg.building_score(sg.mask_features(rect_mask(0, 0, 4, 4), veg, dark, 0.5)) == 0
    # 空掩膜
    assert sg.mask_features(np.zeros((H, W), bool), veg, dark, 0.5)["area_m2"] == 0


def test_select_candidates_prefers_whole_building_and_splits_merged_pair():
    """候选去重: 整栋胜过半栋，两栋被细缝连起来的大块不要

    SAM 对同一个点会给出多级掩膜（半栋 / 整栋 / 连着邻楼），
    这里期望留下整栋和另一栋独立的楼，半栋被整栋覆盖掉，连体块被拆分判掉。
    """
    whole = rect_mask(20, 20, 80, 50)
    part = rect_mask(20, 20, 50, 50)  # 同一栋楼的左半
    other = rect_mask(120, 20, 170, 50)
    merged = whole | other | rect_mask(80, 34, 120, 36)  # 两栋被一条细缝连起来
    masks = [part, whole, other, merged]
    veg = dark = np.zeros((H, W), bool)
    scores = [sg.building_score(sg.mask_features(m, veg, dark, 0.5)) for m in masks]
    keep = sg.select_candidates(masks, scores)
    assert sorted(keep) == [1, 2]  # 整栋 + 另一栋；半栋和连体块都被去掉


def test_calibrate():
    """从三个点击点反推倾斜向量和影子向量

    墙脚、屋顶、影子尖三个像素点 + 已知楼高 → 每米高度的偏移；
    没点影子时 s 为 None（后续就不做影子估高）。
    """
    cal = sg.calibrate((100, 100), (100, 85), (82, 73), 30)
    assert cal["v"] == pytest.approx((0, -0.5))
    assert cal["s"] == pytest.approx((-0.6, -0.9))
    assert sg.calibrate((0, 0), (0, 0), None, 10)["s"] is None


def test_footprint_inverts_lean():
    """倾斜拍摄的剪影 → 墙脚: 反向扫回去应当和真实墙脚高度重合

    用合成楼验证 IoU > 0.95；倾斜向量为零（正射图）时应原样返回剪影。
    """
    img, sil, fp = scene(height=30)
    got = sg.footprint(sil, V, 30)
    iou = (got & fp).sum() / (got | fp).sum()
    assert iou > 0.95
    # 没有倾斜时原样返回
    assert (sg.footprint(sil, (0, 0), 30) == sil).all()


@pytest.mark.parametrize("height", [15.0, 30.0, 45.0])
def test_estimate_height_from_shadow(height):
    """影子长度估楼高: 15 / 30 / 45 米三种楼都能在 ±3 米内估回来

    合成图的影子方向和长度严格按 S × 楼高画，所以误差只来自搜索步长和像素化。
    """
    img, sil, fp = scene(height=height)
    dark, _ = sg.dark_mask(img)
    cal = dict(v=V, s=S)
    h, score = sg.estimate_height(sil, dark, cal, sil, step=1.5)
    assert h == pytest.approx(height, abs=3.0)
    assert score > 0


def test_estimate_height_without_shadow_calibration():
    """没有影子向量、或者楼的掩膜是空的，都返回 (None, 0)

    调用方据此回退到按面积给默认层数，不能抛异常打断整个流水线。
    """
    img, sil, _ = scene()
    dark, _ = sg.dark_mask(img)
    assert sg.estimate_height(sil, dark, dict(v=V, s=None), sil) == (None, 0.0)
    assert sg.estimate_height(np.zeros_like(sil), dark, dict(v=V, s=S), sil) == (None, 0.0)


# ---------------------------------------------------------------------------
# 分块 / 裁剪块 / 候选流水线
# ---------------------------------------------------------------------------
def test_tiles_cover_image_with_full_size_blocks():
    """大图切块: 每块都满尺寸、最后一列贴边、并集覆盖整张图

    满尺寸是为了 SAM / 网络输入大小一致；比块还小的图就整张一块。
    """
    assert sg.tiles(800, 600) == [(0, 0, 800, 600)]  # 比块小: 整张
    bx = sg.tiles(2500, 1100, size=1024, overlap=256)
    xs = sorted({b[0] for b in bx})
    assert xs[0] == 0 and xs[-1] == 2500 - 1024  # 最后一列贴边
    assert all(b[2] - b[0] == 1024 and b[3] - b[1] == 1024 for b in bx)  # 每块满尺寸
    cover = np.zeros((1100, 2500), bool)
    for x0, y0, x1, y1 in bx:
        cover[y0:y1, x0:x1] = True
    assert cover.all()


def test_crop_roundtrip():
    """裁剪块 (x0, y0, 子掩膜) 与全图掩膜互转

    流水线里上百栋楼都存裁剪块省内存，来回转换必须无损；空掩膜裁剪返回 None。
    """
    m = rect_mask(30, 40, 70, 45)
    c = sg.crop(m)
    assert c[0] == 30 and c[1] == 40 and c[2].shape == (5, 40)
    assert (sg.uncrop(c, m.shape) == m).all()
    assert sg.crop(np.zeros((5, 5), bool)) is None


def town():
    """一张 300×200 的小图: 灰色地面上两栋亮屋顶、一片绿地、一块影子"""
    img = np.full((200, 300, 3), 150, np.uint8)
    img[20:60, 20:100] = 225  # 楼 A: 40 × 80 像素
    img[100:150, 180:260] = 225  # 楼 B
    img[120:190, 20:120] = (40, 150, 40)  # 绿地
    img[60:80, 20:100] = 25  # 楼 A 的影子
    return img


def test_find_buildings_with_fake_segmenter():
    """SAM 流程（用假分割器代替真模型，跑得快、结果确定）

    假分割器对每个提示点返回整块 + 一个多余的半块，
    期望最后只剩两栋完整的楼，而且分数都高。
    """
    img = town()
    calls = []

    def fake(tile, pts):
        """假 SAM: 提示点落在哪个亮块里，就返回那个亮块（同时返回一个多余的半块）"""
        calls.append(len(pts))
        out = []
        bright = tile.min(-1) > 200
        n, lab = cv2.connectedComponents(bright.astype(np.uint8))
        for x, y in pts:
            k = lab[int(y), int(x)]
            if k:
                full = lab == k
                half = full.copy()
                half[:, : full.shape[1] // 2] = False
                out += [full, half]
        return out

    got = sg.find_buildings(img, 0.5, fake, stride=40)
    assert calls  # 确实调用了分割
    boxes = sorted((c["crop"][0], c["crop"][1], c["crop"][2].shape) for c in got)
    assert boxes == [(20, 20, (40, 80)), (180, 100, (50, 80))]  # 两栋整楼，半块被去重
    assert all(c["score"] > 0.8 for c in got)


def test_find_buildings_without_sam_uses_color_blobs():
    """没有 SAM 时退回颜色连通块

    进度回调只报一次 (1, 1)；结果里不能把绿地当成楼。
    """
    img = town()
    prog = []
    got = sg.find_buildings(img, 0.5, None, progress=lambda a, b: prog.append((a, b)))
    assert prog == [(1, 1)]
    # 没有 SAM 时，灰色地面和两栋楼连成一大块，面积 > 上限的会被丢掉；至少不会把绿地 / 影子当成楼
    for c in got:
        x0, y0, sub = c["crop"]
        assert not (sg.uncrop(c["crop"], img.shape[:2]) & (img[..., 1] == 150) & (img[..., 0] == 40)).any()


def test_shadow_mask_ignores_speckled_dark_foliage():
    """影子掩膜: 大块真阴影要全部选中，斑点状的背光树冠不要

    树冠的暗斑小而碎，形态学开运算之后应当几乎全被去掉（< 2%）。
    """
    rng = np.random.default_rng(0)
    img = np.full((120, 160, 3), 170, np.uint8)
    img[10:60, 10:80] = 25  # 大块真阴影
    speck = rng.random((120, 160)) < 0.3
    speck[:, :90] = False
    img[speck] = 70  # 右侧: 斑斑点点的背光树冠
    m, thr = sg.shadow_mask(img)
    assert m[20:50, 20:70].all()
    assert m[:, 100:].mean() < 0.02


def test_estimate_height_unknown_when_shadow_hidden():
    """影子被挡住 / 落在亮处看不见时，给「不知道」而不是瞎估一个数

    调用方会把 None 换成同片中位数或按面积的默认层数。
    """
    img, sil, _ = scene(height=30)
    img[img[..., 0] == 35] = 170  # 把影子抹掉（被别的楼挡住 / 落在亮处）
    dark, _ = sg.shadow_mask(img)
    h, score = sg.estimate_height(sil, dark, dict(v=V, s=S), sil)
    assert h is None and score <= 0


def test_estimate_height_accepts_crop():
    """estimate_height 接受裁剪块和全图掩膜两种输入，结果一致

    空裁剪块同样返回 (None, 0)。
    """
    img, sil, _ = scene(height=30)
    dark, _ = sg.shadow_mask(img)
    full = sg.estimate_height(sil, dark, dict(v=V, s=S), sil, step=1.5)
    part = sg.estimate_height(sg.crop(sil), dark, dict(v=V, s=S), sil, step=1.5)
    assert full == part  # 裁剪块和全图掩膜结果一致
    assert sg.estimate_height((0, 0, np.zeros((3, 3), bool)), dark, dict(v=V, s=S), sil) == (None, 0.0)


def test_clip_vegetation_trims_tree_bleed():
    """SAM 掩膜漏进旁边树里的部分要剪掉

    剪完只剩楼本身；整块都是树的直接丢掉；屋顶上的小洞（空调外机、天窗）要填上。
    """
    veg = np.zeros((H, W), bool)
    veg[20:60, 100:140] = True  # 楼右边挨着一片树
    m = rect_mask(20, 20, 140, 60)  # SAM 掩膜: 楼（20~100）+ 漏进树里（100~140）
    c = sg.clip_vegetation(sg.crop(m), veg)
    assert c[0] == 20 and c[1] == 20 and c[2].shape == (40, 80)  # 只剩楼
    assert sg.clip_vegetation(sg.crop(rect_mask(100, 20, 140, 60)), veg) is None  # 全是树: 丢掉
    holey = rect_mask(20, 20, 100, 60) & ~rect_mask(50, 30, 60, 40)  # 屋顶上有个洞
    assert sg.clip_vegetation(sg.crop(holey), np.zeros((H, W), bool))[2].all()  # 洞被填上


def test_shadow_direction_and_auto_heights():
    """全自动估高: 先找影子方向，再按太阳高度角或参考层数换算层数

    三栋正射楼的影子都朝 S 方向，期望:
      方向和真值夹角 < 18°；高矮顺序正确；30 米的楼约 10 层；
      给了参考层数时整体比例被拉到中位数 = 参考层数；没有影子的图不估。
    """
    # 三栋正射（不倾斜）的楼，影子都朝左上 S 方向；楼高 15 / 30 / 45 米
    img = np.full((400, 500, 3), 170, np.uint8)
    crops, sil_all, shadow_all = [], np.zeros((400, 500), bool), np.zeros((400, 500), bool)
    for (x, y), hgt in zip([(80, 250), (230, 300), (380, 330)], [15.0, 30.0, 45.0]):
        fp = np.zeros((400, 500), bool)
        fp[y:y + 30, x:x + 60] = True
        sil_all |= fp
        shadow_all |= sg._sweep(fp, S, hgt, "or")
        crops.append(sg.crop(fp))
    img[shadow_all & ~sil_all] = 30
    img[sil_all] = 215
    shadow, _ = sg.shadow_mask(img)
    (dx, dy), conf = sg.shadow_direction(sil_all, shadow, 0.5)
    su = np.array(S) / np.hypot(*S)
    assert conf > 0.1 and dx * su[0] + dy * su[1] > 0.95  # 方向和真值夹角 < 18°
    # 太阳高度角换算: |S| = 1.08 像素/米，0.5 m/px → tan(el) = 1 / (1.08 × 0.5) → el ≈ 61.6°
    el = np.degrees(np.arctan(1 / (np.hypot(*S) * 0.5)))
    fl, info = sg.auto_heights(crops, img, 0.5, sun_elev_deg=el)
    assert info["used"] and fl[0] < fl[1] < fl[2]  # 高矮顺序对
    assert abs(fl[1] - 10) <= 2  # 30 米 ≈ 10 层
    fl2, info2 = sg.auto_heights(crops, img, 0.5, sun_elev_deg=30.0, ref_floors=10)
    assert fl2[1] == 10 and info2["scale"] != 1.0  # 参考层数把中位数拉到 10 层
    flat = np.full((100, 100, 3), 170, np.uint8)  # 没有影子: 不估
    assert sg.auto_heights([sg.crop(np.pad(np.ones((20, 20), bool), 40))], flat, 0.5)[1]["used"] is False


def test_auto_heights_ignores_dark_roofs_without_real_shadows():
    """没有真正楼影的图（老城区深色瓦屋顶）不估高

    以前最暗的屋顶会被当成影子，结果整片老房子被画成塔楼。
    现在阴影阈值 ≥ 60 或方向置信度 < 0.15 时直接放弃，全部返回 None。
    """
    # 老城区那种图: 最暗的是深色瓦屋顶（亮度 70 左右），没有真正的楼影 → 不该拿来估高
    rng = np.random.default_rng(1)
    img = rng.integers(110, 170, (300, 300, 3)).astype(np.uint8)
    crops = []
    for k in range(9):
        y, x = 20 + (k // 3) * 95, 20 + (k % 3) * 95
        img[y:y + 40, x:x + 60] = 70  # 深色屋顶
        m = np.zeros((300, 300), bool)
        m[y:y + 40, x:x + 60] = True
        crops.append(sg.crop(m))
    fl, info = sg.auto_heights(crops, img, 0.5)
    assert info["used"] is False and all(f is None for f in fl)
