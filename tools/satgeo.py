#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
satgeo.py —— 卫星图上的几何小工具（纯函数，不依赖 SAM / torch，可单独测试）。sat2marks.py 用它做三件事:

1. 自动找建筑候选
   先用颜色把「不可能是屋顶」的像素排除掉（植被: 过绿指数；阴影: 很暗），只在剩下的地方撒 SAM 的提示点，
   省掉一半以上的推理时间，也少出很多树丛 / 阴影块。SAM 返回的一堆掩膜再按形状和颜色打分筛一遍、去重。

2. 倾斜校正（屋顶 → 墙脚）
   卫星多半不是正下方拍的（off-nadir），高楼在图上「歪」向一侧: 看到的是 屋顶 + 一侧立面，
   屋顶相对墙脚平移了 v·h（v = 每米高度在图上平移多少像素，h = 楼高）。
   于是: 图上的剪影 S = 墙脚 F ⊕ 线段[0, v·h]（沿倾斜方向的闵可夫斯基和），反过来 F = S ⊖ 线段（沿同一方向腐蚀）。

3. 用影子估楼高
   太阳方向也是全图一致的: 楼顶某点的影子落在 墙脚上方那点 + s·h（s = 每米高度影子在图上伸多长）。
   地面上的影子区域 = F ⊕ 线段[0, s·h]，去掉被楼挡住的部分。给定 h 就能预测影子在哪，
   在一串候选 h 里挑「预测影子区域里暗像素最多、亮像素最少」的那个。

v 和 s 由「校准」得到: 用户在一栋楼上点 墙脚角点 B、对应的屋顶角点 R、那个屋顶角点影子的尖端 T，
再告诉它这栋楼有几层 → v = (R − B)/H，s = (T − B)/H（H = 层数 × 层高）。全图只需校准一次。

坐标: 全部是图像像素坐标 (x 向右, y 向下)；掩膜是 bool 数组 [行 y, 列 x]。
"""
import math

import cv2
import numpy as np

EARTH_M_PER_PX_Z0 = 156543.03392  # Web 墨卡托瓦片: 0 级、赤道处每像素多少米（256 像素瓦片）


# ----------------------------------------------------------------------------
# 比例尺
# ----------------------------------------------------------------------------
def mpp_from_zoom(lat_deg, zoom, scale=1):
    """
    从网络地图的缩放级别算比例尺（米/像素）。截图来自谷歌 / 天地图 / 高德卫星图时，
    知道截图时的缩放级别和大致纬度就行，不用再拿标尺去量。
    Args:
        lat_deg: 纬度（度）。墨卡托投影在高纬度会放大，所以要乘 cos(纬度)
        zoom:    缩放级别（可带小数，比如浏览器缩放过）
        scale:   高分屏截图（devicePixelRatio = 2）时传 2
    Returns: 米/像素
    """
    return EARTH_M_PER_PX_Z0 * math.cos(math.radians(lat_deg)) / (2 ** zoom) / scale


# ----------------------------------------------------------------------------
# 颜色掩膜
# ----------------------------------------------------------------------------
def vegetation_mask(img, thr=0.06):
    """
    植被: 过绿指数 ExG = 2g − r − b（色度归一化后），并要求绿色占优、不是太暗。
    Args: img BGR uint8；thr 过绿指数阈值（越大越严）
    Returns: bool 掩膜
    """
    f = img.astype(np.float32) + 1.0  # +1 防止全黑像素除零
    s = f.sum(-1)
    b, g, r = f[..., 0] / s, f[..., 1] / s, f[..., 2] / s  # 色度归一化，去掉亮度影响
    exg = 2 * g - r - b
    return (exg > thr) & (g > r) & (g > b) & (img.max(-1) > 28)  # 太暗的（阴影里）不算，交给阴影掩膜


def dark_mask(img, thr=None):
    """
    阴影: 亮度（三通道最大值，先 5×5 模糊去噪）低于阈值的像素。
    thr 为 None 时自动取: 亮度直方图的 Otsu 阈值，但夹在 [45, 95] 之间 ——
    卫星图里阴影通常是全图最暗的一群，Otsu 能把它和受光面分开；夹一下防止全图偏暗 / 偏亮时跑飞。
    Returns: (bool 掩膜, 实际用的阈值)
    """
    v = cv2.GaussianBlur(img.max(-1), (5, 5), 0)  # 亮度 = max(B,G,R)，和 HSV 的 V 一样
    if thr is None:
        otsu, _ = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        thr = float(min(95, max(45, otsu)))
    return v < thr, thr


def shadow_mask(img, thr=None, min_px=30):
    """
    估楼高用的「真阴影」: 比 dark_mask 严格得多。
    高层小区的卫星图里，暗的东西有两类: 楼投下的阴影（大片、平滑、非常暗，亮度 20~40）和
    背光的树冠（斑斑点点，亮度 50~90）。亮度直方图在两者之间有个谷，阈值取这个谷底:
        先找 [5, 90] 里最高的峰（阴影那一群），再在峰之后 80 个灰度内找最低点。
    然后开运算去掉零碎的暗斑、丢掉小于 min_px 的块 —— 剩下的才是楼影。
    Returns: (bool 掩膜, 实际用的阈值)
    """
    v = cv2.GaussianBlur(img.max(-1), (5, 5), 0)
    if thr is None:
        hist = np.bincount(v.ravel(), minlength=256).astype(np.float64)
        hist = np.convolve(hist, np.ones(9) / 9, mode="same")  # 平滑，去掉直方图的锯齿
        peak = 5 + int(hist[5:91].argmax())  # 最暗的那一群
        hi = min(255, peak + 80)
        valley = peak + int(hist[peak:hi].argmin())  # 峰后第一个谷
        thr = float(min(95, max(30, valley)))
    m = (v < thr).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))  # 去斑点
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    big = np.zeros(n, bool)
    big[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_px  # 只留够大的块
    return big[lab], thr


def prompt_points(img, stride, exclude, margin=0):
    """
    给 SAM 的提示点: 每 stride 像素一个网格点，落在 exclude（植被 / 阴影）上的扔掉。
    exclude 先腐蚀一圈（3 像素），让紧贴屋顶边缘的点仍然保留 —— 屋顶边上常有一圈阴影。
    Args:
        img: 只用来取尺寸
        stride: 网格间距（像素）；小楼多就调小
        exclude: bool 掩膜，True 的地方不放点
        margin: 离图像边界多少像素内不放点（分块推理时块边缘的点多半得到被截断的掩膜）
    Returns: (N, 2) float 数组，每行 (x, y)
    """
    h, w = img.shape[:2]
    ex = cv2.erode(exclude.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0  # 7×7 腐蚀 = 每边缩 3 像素
    xs = np.arange(stride / 2, w, stride)  # 网格从半个间距处开始，四边对称
    ys = np.arange(stride / 2, h, stride)
    gx, gy = np.meshgrid(xs, ys)
    pts = np.stack([gx.ravel(), gy.ravel()], 1)
    keep = ~ex[pts[:, 1].astype(int), pts[:, 0].astype(int)]  # 落在排除区里的扔掉
    if margin:
        keep &= (pts[:, 0] >= margin) & (pts[:, 0] < w - margin) & (pts[:, 1] >= margin) & (pts[:, 1] < h - margin)
    return pts[keep]


def blob_prompts(exclude, stride, min_px=40, margin=0):
    """
    比均匀网格省得多的提示点: 把「可能是屋顶」的区域（exclude 之外）切成连通块，
    每块在离边界最远的地方放一个点（屋顶正中）；块很大（几栋楼连在一起，老城区常见）时，
    再在块内部按 stride 补网格点。高层小区里楼与楼之间隔着树和影子，一栋楼一个点就够了，
    推理次数从上千降到一两百 —— SAM 的耗时基本和点数成正比。
    Args:
        exclude: bool 掩膜，True = 植被 / 阴影，不放点
        stride:  大块内部补点的间距（像素）
        min_px:  比这小的块（屋顶设备、车）不放点
        margin:  离图像边界多少像素内不放点
    Returns: (N, 2) float 数组 (x, y)
    """
    free = (~exclude).astype(np.uint8)
    free = cv2.morphologyEx(free, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))  # 去掉一两个像素的细连接，别让两栋楼连成一块
    h, w = free.shape
    n, lab, stats, _ = cv2.connectedComponentsWithStats(free, connectivity=4)
    dist = cv2.distanceTransform(free, cv2.DIST_L2, 3)  # 每个像素离块边界多远
    pts = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if area < min_px:
            continue
        sub = (lab[y:y + bh, x:x + bw] == i)
        d = np.where(sub, dist[y:y + bh, x:x + bw], 0)
        j = int(d.argmax())
        pts.append((x + j % bw + 0.5, y + j // bw + 0.5))  # 块的「内心」
        if area > 4 * stride * stride:  # 大块: 在内部（离边 ≥ 3 像素）按网格补点
            gy, gx = np.mgrid[stride / 2:bh:stride, stride / 2:bw:stride]
            for px, py in zip(gx.ravel(), gy.ravel()):
                if sub[int(py), int(px)] and d[int(py), int(px)] >= 3:
                    pts.append((x + px, y + py))
    pts = np.array(pts, np.float64).reshape(-1, 2)
    if margin and len(pts):
        keep = (pts[:, 0] >= margin) & (pts[:, 0] < w - margin) & (pts[:, 1] >= margin) & (pts[:, 1] < h - margin)
        pts = pts[keep]
    return pts


# ----------------------------------------------------------------------------
# 建筑候选
# ----------------------------------------------------------------------------
def mask_features(mask, veg, dark, mpp):
    """
    一个掩膜的形状 / 颜色特征，给 building_score 打分用。
    Returns: dict
        area_m2   面积（㎡）
        veg       掩膜里植被像素的比例
        dark      掩膜里阴影像素的比例
        solidity  面积 / 凸包面积: 越接近 1 越「实」，树冠、L 形拼接的两栋楼会低一些
        rect      面积 / 最小外接矩形面积: 屋顶大多是矩形，接近 1
        elong     最小外接矩形的长宽比: 道路、围墙这种细长条会很大
        angle     最小外接矩形的方向（度），给候选排朝向用
    """
    m8 = mask.astype(np.uint8)
    area = int(m8.sum())
    if area == 0:
        return dict(area_m2=0.0, veg=0.0, dark=0.0, solidity=0.0, rect=0.0, elong=1.0, angle=0.0)
    cnts, _ = cv2.findContours(m8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    c = max(cnts, key=cv2.contourArea)  # 只看最大的一块（SAM 偶尔带几个碎点）
    hull = cv2.contourArea(cv2.convexHull(c)) or 1.0
    (_, _), (rw, rh), ang = cv2.minAreaRect(c)
    return dict(
        area_m2=area * mpp * mpp,
        veg=float(veg[mask].mean()),
        dark=float(dark[mask].mean()),
        solidity=min(1.0, area / hull),
        rect=min(1.0, area / max(1.0, rw * rh)),
        elong=max(rw, rh) / max(1.0, min(rw, rh)),
        angle=float(ang),
    )


def building_score(f, min_m2=25.0, max_m2=30000.0):
    """
    这个掩膜像不像一栋楼的屋顶（0 = 不像，越大越像）。规则都是硬门槛 + 一个平滑分数:
        · 面积在 [min_m2, max_m2]: 太小是屋顶设备 / 车，太大是整片地块 / 路面
        · 植被 < 30%、阴影 < 40%: 树丛和阴影块是 SAM 最常见的「假阳性」
        · 长宽比 < 8: 再细长就是路、围墙、河道
        · 实心度 > 0.75、矩形度 > 0.5
    分数 = 实心度 × 矩形度 × (1 − 植被) × (1 − 阴影)，候选之间去重时按它排序。
    """
    if not (min_m2 <= f["area_m2"] <= max_m2):
        return 0.0
    if f["veg"] >= 0.3 or f["dark"] >= 0.4 or f["elong"] >= 8:
        return 0.0
    if f["solidity"] <= 0.75 or f["rect"] <= 0.5:
        return 0.0
    return f["solidity"] * f["rect"] * (1 - f["veg"]) * (1 - f["dark"])


def select_candidates(masks, scores, max_overlap=0.25):
    """
    候选去重。SAM 对同一栋楼常给出好几个掩膜（整栋 / 半栋 / 屋顶上的一块），
    也会给出把两栋挨着的楼连成一块的掩膜。做法: 按「分数 × 面积的对数」从高到低贪心接受，
    和已接受的掩膜重叠超过自身 max_overlap 的就跳过。
    乘面积的对数是为了在分数接近时偏向完整的一栋，而不是屋顶上的一小块；
    两栋连成一块的掩膜实心度 / 矩形度低，分数会被压下去，自然输给单独的两栋。
    Args: masks 列表（bool 数组），scores 对应分数（0 的直接跳过）
    Returns: 接受的下标列表
    """
    order = sorted((i for i, s in enumerate(scores) if s > 0), key=lambda i: -scores[i] * math.log(10 + masks[i].sum()))
    taken = None  # 已接受掩膜的并集
    keep = []
    for i in order:
        m = masks[i]
        a = m.sum()
        if taken is not None and (m & taken).sum() > max_overlap * a:
            continue  # 和已有的重叠太多
        keep.append(i)
        taken = m.copy() if taken is None else (taken | m)
    return keep


# ----------------------------------------------------------------------------
# 倾斜 / 影子模型
# ----------------------------------------------------------------------------
def calibrate(base, roof, shadow_tip, height_m):
    """
    由一栋楼的三个点和它的高度，算出全图通用的倾斜向量 v 和影子向量 s（像素 / 米）。
    Args:
        base:       墙脚上的一个角点 (x, y)
        roof:       正上方那个屋顶角点 (x, y)；图是正射的（没有倾斜）就和 base 点同一个位置
        shadow_tip: 那个屋顶角点的影子尖端 (x, y)；没有明显影子可以给 None
        height_m:   这栋楼的高度（米），一般 = 层数 × 层高
    Returns: dict(v=(vx, vy), s=(sx, sy) 或 None)
    """
    bx, by = base
    v = ((roof[0] - bx) / height_m, (roof[1] - by) / height_m)
    s = None if shadow_tip is None else ((shadow_tip[0] - bx) / height_m, (shadow_tip[1] - by) / height_m)
    return dict(v=v, s=s)


def _sweep(mask, vec, length, mode):
    """
    沿方向 vec 把掩膜「扫」过 [0, length] 这一段: mode='or' 得到膨胀（闵可夫斯基和），
    mode='and' 得到腐蚀（所有平移都还在掩膜里的点）。单步不超过 1 像素，保证不漏。
    vec 是单位长度对应的像素位移，length 是长度（米），所以总位移 = vec × length。

    用「倍增」而不是逐步平移: 设 u 为单步位移、要覆盖 k = 0..n 步。R 覆盖 0..c 步时，
    R ∪ shift(R, (c+1)·u) 就覆盖 0..2c+1 步 —— 只要 log₂n 次平移，n 上百时快几十倍。
    最后一次平移 (n − c)·u 把覆盖范围补齐到正好 n（n − c ≤ c + 1，所以两段是连着的）。
    """
    dx, dy = vec[0] * length, vec[1] * length
    n = max(1, int(math.ceil(max(abs(dx), abs(dy)))))  # 步数: 最大分量有多少像素就走多少步
    ux, uy = dx / n, dy / n  # 单步位移（≤ 1 像素）
    h, w = mask.shape
    op = np.bitwise_or if mode == "or" else np.bitwise_and

    def shift(a, k):
        """把 a 平移 k 个单步；移进来的边缘填 0"""
        M = np.float32([[1, 0, ux * k], [0, 1, uy * k]])
        return cv2.warpAffine(a, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)

    r = mask.astype(np.uint8)
    cover = 0  # r 当前覆盖 0..cover 步
    while 2 * cover + 1 <= n:
        r = op(r, shift(r, cover + 1))
        cover = 2 * cover + 1
    if cover < n:
        r = op(r, shift(r, n - cover))  # 补齐到 n
    return r > 0


def footprint(silhouette, v, h):
    """
    剪影 → 墙脚。剪影 = 墙脚沿 v 扫过 [0, h] 的并，所以墙脚 = 剪影沿 −v 扫过 [0, h] 的交:
    一个点是墙脚，当且仅当它往屋顶方向平移 0 ~ v·h 都还落在剪影里。
    Args: silhouette bool 掩膜；v 倾斜向量（像素/米）；h 楼高（米）
    Returns: bool 掩膜（可能为空: h 估大了，把整栋都腐蚀掉了）
    """
    # warpAffine 平移 d 后，输出点 q 取的是原图 q − d 处的值；要检查 q + v·t 是否在剪影里，就得平移 −v·t
    return _sweep(silhouette, (-v[0], -v[1]), h, "and") if (v[0] or v[1]) and h > 0 else silhouette.copy()


def predicted_shadow(foot, s, h, occluders):
    """
    高 h 的楼在地面上的影子（图上）: 墙脚沿 s 扫过 [0, h]，再去掉被楼本身 / 别的楼挡住的部分（occluders）。
    """
    return _sweep(foot, s, h, "or") & ~occluders


def estimate_height(silhouette, dark, cal, occluders, h_min=3.0, h_max=180.0, step=3.0, penalty=1.5, min_foot=0.3):
    """
    用影子估楼高。对每个候选高度 h:
        预测影子区域 P(h) = predicted_shadow(footprint(剪影, v, h), s, h, 所有楼的剪影)
        得分 = P(h) 里的暗像素数 − penalty × 亮像素数
    取得分最高的 h。h 太小，影子没覆盖完真实的暗区，得分还能涨；h 太大，预测影子伸到亮地面上，
    每个亮像素扣 penalty 分，得分下降。penalty > 1 让它宁可略低估，也不要伸进旁边另一栋楼的影子里。
    搜索分两轮: 先每 2×step 米扫一遍，再在最好的那个附近按 step 细调 —— 得分曲线是单峰的，这样够用。
    另外墙脚面积不能小于剪影的 min_foot（30%）: 立面再宽也不会比楼本身深两倍多，
    h 大到把墙脚腐蚀成一条细缝，多半是影子连进了别处的暗区。
    Args:
        silhouette: 这栋楼的剪影（bool）
        dark:       全图的阴影掩膜（用 shadow_mask，别用 dark_mask: 背光的树冠会把楼高撑大）
        cal:        calibrate() 的结果；没有影子向量时返回 None
        occluders:  所有楼的剪影并集（影子落在楼上的部分不计分: 那里是屋顶，不是地面）
    Returns: (楼高米数 或 None, 最高得分)
    """
    if not cal or cal.get("s") is None:
        return None, 0.0
    v, s = cal["v"], cal["s"]
    # 剪影可以是全图掩膜，也可以是裁剪块 (x0, y0, 子掩膜)（大图上逐栋算时不必每栋都分配一张全图）
    if isinstance(silhouette, tuple):
        cx, cy, sub = silhouette
        if not sub.any():
            return None, 0.0
        bx0, by0, bx1, by1 = cx, cy, cx + sub.shape[1] - 1, cy + sub.shape[0] - 1
    else:
        ys, xs = np.nonzero(silhouette)
        if not len(xs):
            return None, 0.0
        bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max(), ys.max()
    # 只在剪影周围一个窗口里算，整张图上做平移太慢
    H_, W_ = dark.shape
    reach = h_max * max(math.hypot(*s), math.hypot(*v)) + 4  # 影子 / 倾斜最远能伸多少像素
    x0, x1 = int(max(0, bx0 - reach)), int(min(W_, bx1 + reach + 1))
    y0, y1 = int(max(0, by0 - reach)), int(min(H_, by1 + reach + 1))
    if isinstance(silhouette, tuple):
        sil = np.zeros((y1 - y0, x1 - x0), bool)
        sil[cy - y0:cy - y0 + sub.shape[0], cx - x0:cx - x0 + sub.shape[1]] = sub  # 把裁剪块放进窗口
    else:
        sil = silhouette[y0:y1, x0:x1]
    dk, occ = dark[y0:y1, x0:x1], occluders[y0:y1, x0:x1]
    area = float(sil.sum())
    cache = {}  # h → 得分；墙脚太小的记 None

    def score(h):
        """高度 h 的得分；不可能的高度（墙脚被腐蚀得太小）返回 None"""
        if h not in cache:
            foot = footprint(sil, v, h)
            if foot.sum() < min_foot * area:
                cache[h] = None
            else:
                p = predicted_shadow(foot, s, h, occ)
                cache[h] = float((p & dk).sum()) - penalty * float((p & ~dk).sum())
        return cache[h]

    # 第一轮: 粗扫；墙脚一旦太小，更高的也一样，停
    best_h, best = None, -1e18
    h = h_min
    while h <= h_max + 1e-6:
        sc = score(h)
        if sc is None:
            break
        if sc > best:
            best_h, best = h, sc
        h += 2 * step
    if best_h is None:
        return None, 0.0
    # 第二轮: 在最好的粗值两侧各试一步
    for h in (best_h - step, best_h + step):
        if h_min <= h <= h_max:
            sc = score(h)
            if sc is not None and sc > best:
                best_h, best = h, sc
    if best <= 0:
        return None, best  # 预测影子里亮的比暗的还多: 这栋楼的影子被别的楼挡了 / 落在树上，看不出来，别瞎猜
    return best_h, best


# ----------------------------------------------------------------------------
# 裁剪块: 候选掩膜只存外接矩形里的那一块，大图上几百个候选也不占多少内存
# ----------------------------------------------------------------------------
def crop(mask):
    """bool 全图掩膜 → (x0, y0, 子掩膜)；空掩膜返回 None"""
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    x0, y0 = int(xs.min()), int(ys.min())
    return (x0, y0, mask[y0:int(ys.max()) + 1, x0:int(xs.max()) + 1].copy())


def uncrop(c, shape):
    """(x0, y0, 子掩膜) → bool 全图掩膜"""
    x0, y0, sub = c
    out = np.zeros(shape, bool)
    out[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]] = sub
    return out


def tiles(w, h, size=1024, overlap=256):
    """
    把 w × h 的图切成 size × size 的块，相邻块重叠 overlap（楼压在块边上时，总有一块把它完整包住）。
    最后一行 / 列的块贴着图像边缘往回放，所以每块都是满尺寸（图比 size 小时就是整张图）。
    Returns: [(x0, y0, x1, y1)]
    """
    def starts(n):
        if n <= size:
            return [0]
        s = list(range(0, n - size, size - overlap))
        return s + [n - size]  # 最后一块贴边
    return [(x, y, min(w, x + size), min(h, y + size)) for y in starts(h) for x in starts(w)]


def find_buildings(img, mpp, segment_all, tile=1024, overlap=256, stride=40, progress=None):
    """
    全图自动找建筑候选。
    Args:
        img:         BGR 图
        mpp:         米/像素（面积门槛要换成像素）
        segment_all: 函数 (块图像, 提示点 (N,2) 块内像素坐标) → bool 掩膜列表（块大小）。
                     sat2marks 里是 SAM；没装 SAM 时传 None，直接把「非植被非阴影」的连通块当候选（粗糙但能用）
        tile, overlap: 分块大小 / 重叠。SAM 会把输入缩到 1024，所以块取 1024 = 原分辨率推理，小楼不糊
        stride:      大连通块里补提示点的间距（像素）
        progress:    回调 (已完成块数, 总块数)
    Returns: 候选列表 [{crop: (x0, y0, 子掩膜), feats, score}]，已去重，按分数从高到低
    """
    h, w = img.shape[:2]
    veg = vegetation_mask(img)
    dark, _ = dark_mask(img)
    exclude = veg | dark
    crops = []
    boxes = tiles(w, h, tile, overlap)
    for k, (x0, y0, x1, y1) in enumerate(boxes):
        ex = exclude[y0:y1, x0:x1]
        edge = 8 if len(boxes) > 1 else 0  # 多块时块边 8 像素内不放点: 那里的楼多半被块边截断，交给相邻块
        if segment_all is None:
            # 兜底: 可能是屋顶的区域开运算后的连通块，每块一个候选
            free = cv2.morphologyEx((~ex).astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
            n, lab = cv2.connectedComponents(free, connectivity=4)
            masks = [lab == i for i in range(1, n)]
        else:
            pts = blob_prompts(ex, stride, margin=edge)
            masks = segment_all(img[y0:y1, x0:x1], pts) if len(pts) else []
        for m in masks:
            c = crop(m)
            if c is not None:
                crops.append((c[0] + x0, c[1] + y0, c[2]))  # 块坐标 → 全图坐标
        if progress:
            progress(k + 1, len(boxes))
    # 打分: 特征只在候选的外接矩形里算
    feats, scores = [], []
    for (cx, cy, sub) in crops:
        sh = sub.shape
        f = mask_features(sub, veg[cy:cy + sh[0], cx:cx + sh[1]], dark[cy:cy + sh[0], cx:cx + sh[1]], mpp)
        feats.append(f)
        scores.append(building_score(f, min_m2=25.0, max_m2=30000.0))
    keep = select_crops(crops, scores, (h, w))
    return [dict(crop=crops[i], feats=feats[i], score=scores[i]) for i in keep]


def select_crops(crops, scores, shape, max_overlap=0.25):
    """select_candidates 的裁剪块版本: 规则相同，只是「已接受的并集」用一张全图掩膜维护，比较时只看外接矩形"""
    order = sorted((i for i, s in enumerate(scores) if s > 0), key=lambda i: -scores[i] * math.log(10 + crops[i][2].sum()))
    taken = np.zeros(shape, bool)
    keep = []
    for i in order:
        x0, y0, sub = crops[i]
        win = taken[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]]
        if (sub & win).sum() > max_overlap * sub.sum():
            continue  # 和已接受的重叠太多
        keep.append(i)
        win |= sub  # win 是 taken 的视图，直接写回
    return keep
