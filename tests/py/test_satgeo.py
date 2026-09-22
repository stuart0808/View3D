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
    # 赤道 0 级约 156543 m/px；每放大一级减半；纬度 60° 再乘 cos60° = 0.5
    assert sg.mpp_from_zoom(0, 0) == pytest.approx(156543.03392)
    assert sg.mpp_from_zoom(0, 18) == pytest.approx(0.597, abs=1e-3)
    assert sg.mpp_from_zoom(60, 18) == pytest.approx(0.2986, abs=1e-3)
    assert sg.mpp_from_zoom(0, 18, scale=2) == pytest.approx(0.2986, abs=1e-3)


def test_vegetation_and_dark_masks():
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
    cal = sg.calibrate((100, 100), (100, 85), (82, 73), 30)
    assert cal["v"] == pytest.approx((0, -0.5))
    assert cal["s"] == pytest.approx((-0.6, -0.9))
    assert sg.calibrate((0, 0), (0, 0), None, 10)["s"] is None


def test_footprint_inverts_lean():
    img, sil, fp = scene(height=30)
    got = sg.footprint(sil, V, 30)
    iou = (got & fp).sum() / (got | fp).sum()
    assert iou > 0.95
    # 没有倾斜时原样返回
    assert (sg.footprint(sil, (0, 0), 30) == sil).all()


@pytest.mark.parametrize("height", [15.0, 30.0, 45.0])
def test_estimate_height_from_shadow(height):
    img, sil, fp = scene(height=height)
    dark, _ = sg.dark_mask(img)
    cal = dict(v=V, s=S)
    h, score = sg.estimate_height(sil, dark, cal, sil, step=1.5)
    assert h == pytest.approx(height, abs=3.0)
    assert score > 0


def test_estimate_height_without_shadow_calibration():
    img, sil, _ = scene()
    dark, _ = sg.dark_mask(img)
    assert sg.estimate_height(sil, dark, dict(v=V, s=None), sil) == (None, 0.0)
    assert sg.estimate_height(np.zeros_like(sil), dark, dict(v=V, s=S), sil) == (None, 0.0)


# ---------------------------------------------------------------------------
# 分块 / 裁剪块 / 候选流水线
# ---------------------------------------------------------------------------
def test_tiles_cover_image_with_full_size_blocks():
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
    img = town()
    prog = []
    got = sg.find_buildings(img, 0.5, None, progress=lambda a, b: prog.append((a, b)))
    assert prog == [(1, 1)]
    # 没有 SAM 时，灰色地面和两栋楼连成一大块，面积 > 上限的会被丢掉；至少不会把绿地 / 影子当成楼
    for c in got:
        x0, y0, sub = c["crop"]
        assert not (sg.uncrop(c["crop"], img.shape[:2]) & (img[..., 1] == 150) & (img[..., 0] == 40)).any()


def test_shadow_mask_ignores_speckled_dark_foliage():
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
    img, sil, _ = scene(height=30)
    img[img[..., 0] == 35] = 170  # 把影子抹掉（被别的楼挡住 / 落在亮处）
    dark, _ = sg.shadow_mask(img)
    h, score = sg.estimate_height(sil, dark, dict(v=V, s=S), sil)
    assert h is None and score <= 0


def test_estimate_height_accepts_crop():
    img, sil, _ = scene(height=30)
    dark, _ = sg.shadow_mask(img)
    full = sg.estimate_height(sil, dark, dict(v=V, s=S), sil, step=1.5)
    part = sg.estimate_height(sg.crop(sil), dark, dict(v=V, s=S), sil, step=1.5)
    assert full == part  # 裁剪块和全图掩膜结果一致
    assert sg.estimate_height((0, 0, np.zeros((3, 3), bool)), dark, dict(v=V, s=S), sil) == (None, 0.0)


def test_clip_vegetation_trims_tree_bleed():
    veg = np.zeros((H, W), bool)
    veg[20:60, 100:140] = True  # 楼右边挨着一片树
    m = rect_mask(20, 20, 140, 60)  # SAM 掩膜: 楼（20~100）+ 漏进树里（100~140）
    c = sg.clip_vegetation(sg.crop(m), veg)
    assert c[0] == 20 and c[1] == 20 and c[2].shape == (40, 80)  # 只剩楼
    assert sg.clip_vegetation(sg.crop(rect_mask(100, 20, 140, 60)), veg) is None  # 全是树: 丢掉
    holey = rect_mask(20, 20, 100, 60) & ~rect_mask(50, 30, 60, 40)  # 屋顶上有个洞
    assert sg.clip_vegetation(sg.crop(holey), np.zeros((H, W), bool))[2].all()  # 洞被填上
