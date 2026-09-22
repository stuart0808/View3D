#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
map2scene.py —— 把「涂了色块标记的二维地图图片」转换成前端用的 scene.json

标记约定（默认调色板，可用 --markers 覆盖，见 markers.default.json）:
    红   #FF0000  商铺建筑（2 层）          —— 填充色块
    橙   #FF8000  商铺建筑（1 层）          —— 填充色块
    品红 #FF00FF  写字楼/非商铺高楼          —— 填充色块（层数按占地面积自动取 6~28 层）
    春绿 #00FF80  住宅楼                    —— 填充色块（9~18 层）
    黄绿 #80FF00  活动场馆（体育场、剧院…）   —— 填充色块，形状随意；名称/类型/容量写在 --sidecar 里
    蓝   #0000FF  车行道                    —— 填充色块（环岛不用特别标: 画成一个圆环，脚本会自动认出来）
    玫红 #FF0080  高架路                    —— 填充色块，直接盖在地面道路上画；不与地面道路相交，两端通到图外
    绿   #00FF00  绿化带/草坪（不可走，种树） —— 填充色块
    深绿 #008000  公园（可走，草地+树）       —— 填充色块
    天蓝 #0080FF  水体                      —— 填充色块
    粉   #FF80FF  广场（可走，特殊铺装）      —— 填充色块
    紫   #8000FF  停车场（可走，车位+车）     —— 填充色块
    黄   #FFFF00  店门（可选，不标则自动生成）—— 小圆点，点在建筑边缘附近
    青   #00FFFF  人流出入口（可选）          —— 小圆点，点在人行区域

人行区域不用标：地块范围内「非建筑、非车行道」的部分自动视为可行走。

用法:
    python tools/map2scene.py map_marked.png -o public/scenes/my.json --width-m 300 --debug preview.png

坐标系: 输出单位为米，x 向右、y 向下（与图片一致），原点在内容中心。

流程（main）:
    1. classify: 逐像素按颜色归类 → 每种标记一张掩膜
    2. 建筑: 掩膜 → 轮廓 → 简化 → 直角化（吸附到街区主方向）→ 层数
    3. 道路 / 高架 / 面状区域掩膜 → 地块范围（内容外包络）→ 人行铺装 = 地块 − 道路 − 下沉区域
    4. 环岛检测（道路掩膜里的圆形孔洞）
    5. 道路骨架 → 中心线图 → 剪毛刺、并路口、路口归正 → roadGraph（节点 / 边 / 路宽 / 路口深度）、车道线、斑马线
    6. 高架同样走骨架，level=1
    7. sidecar: 核心区、场馆信息、轨道交通线路
    8. 店门（手工点或自动沿临街边布）、人流出入口（手工点、核心区边界、或地块四周）
    9. 写 scene.json，可选画预览图
"""
import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import nearest_points, unary_union
from shapely.prepared import prep

# 默认调色板。每项字段:
#   color  —— 标记色 '#RRGGBB'，归类时按 RGB 欧氏距离找最近的一种
#   layer  —— 图层类型: building（建筑）/ road（车行道）/ elevated（高架）/ area（面状区域）/ door（店门点）/ portal（出入口点）
#   kind   —— 同一 layer 内的细分: 建筑的 shop / block / residential / venue，区域的 green / park / water / plaza / parking
#   floors —— 建筑默认层数；block / residential 在 main 里会按占地面积 / 序号再改
# 顺序即 classify 返回的类别索引（0..n-1），--markers 给的自定义表也按同样结构解析
DEFAULT_MARKERS = [
    {"color": "#FF0000", "layer": "building", "kind": "shop", "floors": 2},
    {"color": "#FF8000", "layer": "building", "kind": "shop", "floors": 1},
    {"color": "#FF00FF", "layer": "building", "kind": "block", "floors": 5},
    {"color": "#00FF80", "layer": "building", "kind": "residential", "floors": 11},
    {"color": "#80FF00", "layer": "building", "kind": "venue", "floors": 4},
    {"color": "#0000FF", "layer": "road"},
    {"color": "#FF0080", "layer": "elevated"},
    {"color": "#00FF00", "layer": "area", "kind": "green"},
    {"color": "#008000", "layer": "area", "kind": "park"},
    {"color": "#0080FF", "layer": "area", "kind": "water"},
    {"color": "#FF80FF", "layer": "area", "kind": "plaza"},
    {"color": "#8000FF", "layer": "area", "kind": "parking"},
    {"color": "#FFFF00", "layer": "door"},
    {"color": "#00FFFF", "layer": "portal"},
]


# ----------------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------------
def remove_by_id(lst, item):
    """
    按对象身份从列表里删掉 item。不能用 list.remove: 它拿 == 挨个比，元素里有 numpy 数组时（边的端点、折线），
    只要排在前面的某个元素其他字段恰好相等，比到数组就会抛「truth value of an array is ambiguous」
    """
    for i, x in enumerate(lst):
        if x is item:
            del lst[i]
            return
    raise ValueError("不在列表里")


def log(*a):
    """进度信息走 stderr，stdout 留给可能的管道输出；每行带 [map2scene] 前缀便于在 npm 脚本输出里辨认"""
    print("[map2scene]", *a, file=sys.stderr)


def imread_unicode(path):
    """cv2.imread 在 Windows 上不支持中文路径，用 imdecode 绕开。"""
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"无法读取图片: {path}")
    return img


def imwrite_unicode(path, img):
    """同 imread_unicode: 中文路径下写图。格式按扩展名定，没有扩展名时按 png 编码"""
    ok, buf = cv2.imencode(Path(path).suffix or ".png", img)
    if ok:
        buf.tofile(str(path))


def hex_to_rgb(s):
    """'#RRGGBB' → (r, g, b)，各分量 0~255；前导 # 可有可无"""
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def classify(img, markers, tol, min_sat=70):
    """
    逐像素归类到最近的标记色（RGB 欧氏距离 < tol），返回类别索引图（-1 = 未标记）。
    标记色都是高饱和色，所以 max-min < min_sat 的像素（各种深浅的灰）直接判为未标记。

    Args:
        img:     cv2 读入的 BGR 或 BGRA 图（灰度图会先转成 BGR，自然全部判为未标记）
        markers: 调色板列表，见 DEFAULT_MARKERS；索引即返回值里的类别号
        tol:     颜色容差（RGB 距离）。默认 100 足够容忍 jpg 压缩和抗锯齿，底图颜色接近标记色时应调小
        min_sat: 饱和度门槛（max(r,g,b) - min(r,g,b)）。卫星底图、灰色路面都是低饱和，靠它一刀切掉
    Returns:
        (h, w) int16 数组，值为 markers 索引或 -1。透明像素（alpha < 128）也记 -1
    """
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    alpha = img[..., 3] if img.shape[2] == 4 else None
    h, w = img.shape[:2]
    best = np.full((h, w), -1, np.int16)
    cols = [np.array(hex_to_rgb(m["color"]), np.int32) for m in markers]  # 标记色按 RGB 顺序存，下面切片时把 BGR 反过来
    # 按行分块。实测 4800x3400 (1632 万像素): 不分块峰值 832MB / 7.2s，分块 153MB / 8.1s，结果逐像素一致。
    # 这个尺寸其实不分块也行；占用和像素数成正比，上亿像素（同样范围用 0.2 m/px 画）时不分块要 5GB 以上，所以留着
    for y0 in range(0, h, 512):
        rgb = img[y0:y0 + 512, :, 2::-1].astype(np.int32)  # BGR → RGB；转 int32 防止平方溢出
        b_ = best[y0:y0 + 512]  # 视图，写它就是写 best
        best_d = np.full(rgb.shape[:2], tol * tol, np.int32)  # 距离平方比较，省一次开方；初值 = 容差，超过的不归类
        for i, c in enumerate(cols):
            d = ((rgb - c) ** 2).sum(-1)
            hit = d < best_d  # 比目前最近的还近才覆盖 → 最终每个像素落在最近的标记色上
            b_[hit] = i
            best_d[hit] = d[hit]
        b_[(rgb.max(-1) - rgb.min(-1)) < min_sat] = -1  # 饱和度过滤放在最后，优先级高于颜色距离
    if alpha is not None:
        best[alpha < 128] = -1
    return best


def clean_mask(mask, open_px=3, close_px=5):
    """
    先开（去掉孤立小点）后闭（补上小孔 / 细缝），核是椭圆。

    顺序很重要: 先闭再开会把手抖留下的碎点先连成片、再也去不掉；先开则碎点直接消失，
    闭运算只补真正属于色块的小缺口（画笔漏涂、抗锯齿留下的细缝）。
    Args:
        mask:     0/255 的 uint8 掩膜
        open_px:  开运算核直径（像素），比它小的孤立点被删掉
        close_px: 闭运算核直径（像素），比它窄的缝 / 孔被填上
    Returns:
        同尺寸的 uint8 掩膜
    """
    k1 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_px, open_px))
    k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_px, close_px))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k1)
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k2)


def mask_to_rings(mask, min_area_px):
    """
    掩膜 → [(外环, [内环...])]，OpenCV 轮廓（像素坐标）。小于 min_area_px 的外环丢掉，内环门槛减半。

    RETR_CCOMP 只给两层层级（外环 + 它的孔），孔里再套的岛会被当成新的外环，对地图标记来说够用。
    CHAIN_APPROX_NONE 保留全部轮廓像素，简化交给后面的 simplify_ring 按米制容差做。
    Args:
        mask:        0/255 掩膜
        min_area_px: 外环最小面积（像素²）；内环门槛取一半，因为楼里的天井本来就比楼小
    Returns:
        [(shell, [hole, ...])]，元素都是 findContours 原样的 (N,1,2) int32 数组
    """
    cnts, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    out = []
    if hier is None:
        return out
    hier = hier[0]  # hier[i] = [next, prev, first_child, parent]
    for i, c in enumerate(cnts):
        if hier[i][3] != -1 or cv2.contourArea(c) < min_area_px:  # 有 parent 的是孔，这里只遍历外环
            continue
        holes = []
        j = hier[i][2]  # 第一个孔，之后沿 next 链走完所有孔
        while j != -1:
            if cv2.contourArea(cnts[j]) >= min_area_px * 0.5:
                holes.append(cnts[j])
            j = hier[j][0]
        out.append((c, holes))
    return out


def simplify_ring(cnt, eps):
    """
    Douglas-Peucker 简化，返回 (N,2) float 数组；简化到不足 3 点返回 None。

    Args:
        cnt: findContours 给的 (N,1,2) 轮廓
        eps: 允许偏离原轮廓的最大距离（像素）。调用方按 --simplify-m / mpp 换算，但至少 1px
    """
    a = cv2.approxPolyDP(cnt, eps, True).reshape(-1, 2).astype(np.float64)  # closed=True: 按闭合环简化
    return a if len(a) >= 3 else None


# ----------------------------------------------------------------------------
# 建筑轮廓直角化
# ----------------------------------------------------------------------------
def dominant_angle(rings):
    """
    边长加权的主方向（弧度，(-45°,45°]），利用 4θ 折叠消除 90° 歧义。

    矩形楼的四条边方向两两相差 90°，直接对方向角求平均会互相抵消；把角度乘 4 后，
    0° / 90° / 180° / 270° 全部映到同一相位，向量求和再除回 4 就得到「街区网格」的朝向。
    Args:
        rings: 若干 (N,2) 顶点数组（米或像素均可，只用方向和长度比例）
    Returns:
        主方向弧度；空输入返回 0
    """
    s = c = 0.0
    for p in rings:
        e = np.roll(p, -1, 0) - p  # 每条边的向量（首尾相接）
        L = np.hypot(e[:, 0], e[:, 1])
        th = np.arctan2(e[:, 1], e[:, 0])
        s += float((L * np.sin(4 * th)).sum())  # 长边权重大: 短小的锯齿边不该左右整体朝向
        c += float((L * np.cos(4 * th)).sum())
    return math.atan2(s, c) / 4.0


def ang_diff90(a, b):
    """两个方向角在 90° 周期下的最小夹角（建筑主方向差 90° 视为同向）"""
    d = (a - b) % (math.pi / 2)
    return min(d, math.pi / 2 - d)


def _line_intersect(p1, d1, p2, d2):
    """两条直线（点 + 方向）的交点；平行返回 None"""
    cross = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(cross) < 1e-9:
        return None
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / cross
    return np.array([p1[0] + t * d1[0], p1[1] + t * d1[1]])


def orthogonalize(pts, ang, snap_deg=22.0, jog_tol=1.2):
    """
    把多边形的边吸附到主方向的两条正交轴上，再由相邻边求交重建顶点。
    偏离两轴都超过 snap_deg 的边视为斜边，保持原样。
    pts: (N,2) 米；ang: 主方向弧度；jog_tol: 小于该长度的折线台阶会被抹平（米）。

    思路: 先把整个多边形旋转 -ang，让主方向变成 x 轴，这样「吸附」就退化成把边归为水平 / 竖直两类，
    每条边只剩一个参数 c（水平边的 y、竖直边的 x）；处理完再旋转回去。
    snap_deg=22°: 比 22.5°（两轴之间的一半）略小，留一点余量给真正的 45° 斜边，不把它硬掰成台阶。
    返回 (M,2) 顶点数组；边合并后不足 3 条时返回 None（调用方回退到原轮廓）。
    """
    ca, sa = math.cos(-ang), math.sin(-ang)
    R = np.array([[ca, -sa], [sa, ca]])
    P = pts @ R.T  # 旋转到主方向坐标系
    n = len(P)

    # 每条边归类: H 水平（c = y 坐标）、V 竖直（c = x 坐标）、F 自由斜边；L 长度，a/b 端点（旋转后坐标）
    edges = []  # dict(t='H'|'V'|'F', c, L, a, b)
    for i in range(n):
        a, b = P[i], P[(i + 1) % n]
        d = b - a
        L = float(np.hypot(*d))
        if L < 1e-6:
            continue
        th = math.degrees(math.atan2(d[1], d[0]))
        dev = ((th + 45.0) % 90.0) - 45.0  # 与最近一条轴的夹角，范围 [-45°, 45°)
        if abs(dev) <= snap_deg:
            if abs(d[0]) >= abs(d[1]):
                edges.append(dict(t="H", c=(a[1] + b[1]) / 2, L=L, a=a, b=b))  # 水平边: c 取两端 y 的平均
            else:
                edges.append(dict(t="V", c=(a[0] + b[0]) / 2, L=L, a=a, b=b))  # 竖直边: c 取两端 x 的平均
        else:
            edges.append(dict(t="F", c=None, L=L, a=a, b=b))  # 斜边: 原样保留，靠端点 a/b 定义直线

    def merge_pass(es):
        """反复做两件事直到没变化: 抹掉同类边之间的小台阶；合并相邻同类边（错位大就插一条垂直连接边）"""
        changed = True
        while changed and len(es) > 3:  # 至少留 3 条边才是多边形；每轮只改一处然后从头再扫，避免迭代中改列表
            changed = False
            # 1) 抹掉夹在两条同类边之间的一小串短边（台阶、缺口）
            #    像素轮廓上常见「H 短V 短H」这种 1~2 像素的台阶，两条 H 边的 c 几乎相等；把中间的短边删掉，
            #    第 2 步就会把两条 H 边合成一条。run 最多试 3 条，再长的就不是噪声而是真实的凹凸了
            m = len(es)
            for i in range(m):
                p = es[i]
                if p["t"] == "F":
                    continue
                for run in (1, 2, 3):
                    if run + 2 > m:
                        break
                    mids = [es[(i + 1 + r) % m] for r in range(run)]
                    q = es[(i + 1 + run) % m]  # 跳过 run 条短边后的那条边，要求和 p 同类且几乎共线
                    if q["t"] != p["t"] or q is p or abs(q["c"] - p["c"]) > jog_tol:
                        continue
                    if all(e["L"] < jog_tol * 1.5 for e in mids) and sum(e["L"] for e in mids) < jog_tol * 3:  # 每条都短、总长也短
                        for e in mids:
                            remove_by_id(es, e)
                        changed = True
                        break
                if changed:
                    break
            if changed:
                continue
            # 2) 合并相邻同类边；错位过大时补一条垂直连接边
            #    相邻两条同为 H（或同为 V）的边中间没有别的边，说明原轮廓在这里有个被吸附掉的小拐角:
            #    共线（c 相差 ≤ jog_tol）就并成一条；错位明显则是真实的台阶，插一条垂直边把它们接上，
            #    否则第 3 步求交时两条平行线没有交点
            for i, e in enumerate(es):
                q = es[(i + 1) % len(es)]
                if e is q or e["t"] == "F" or e["t"] != q["t"]:
                    continue
                if abs(e["c"] - q["c"]) <= jog_tol:
                    tot = e["L"] + q["L"]
                    e["c"] = (e["c"] * e["L"] + q["c"] * q["L"]) / tot  # 位置按长度加权，长边说了算
                    e["L"] = tot
                    e["b"] = q["b"]
                    remove_by_id(es, q)
                else:
                    j = e["b"]  # 连接边放在 e 的末端处，长度 = 两条边的错位量
                    t = "V" if e["t"] == "H" else "H"
                    c = j[0] if t == "V" else j[1]
                    es.insert(es.index(q), dict(t=t, c=c, L=abs(e["c"] - q["c"]), a=j, b=j))
                changed = True
                break
        return es

    edges = merge_pass(edges)
    if len(edges) < 3:
        return None

    def as_line(e):
        """边 → (直线上一点, 方向)。H/V 边由 c 定义一条无限长的轴线，F 边用原始两端点"""
        if e["t"] == "H":
            return np.array([0.0, e["c"]]), np.array([1.0, 0.0])
        if e["t"] == "V":
            return np.array([e["c"], 0.0]), np.array([0.0, 1.0])
        return e["a"], e["b"] - e["a"]

    # 相邻两边求交得到新顶点；交点飞太远（近乎平行的两条边）就退回原端点
    # H 边和 V 边必定垂直，交点就是干净的直角顶点；只有斜边（F）和轴边夹角很小时交点才会飞出去
    out = []
    m = len(edges)
    for i in range(m):
        e, q = edges[i], edges[(i + 1) % m]
        x = _line_intersect(*as_line(e), *as_line(q))
        if x is None or np.hypot(*(x - e["b"])) > max(6.0, 4 * jog_tol):  # 离原端点超过 6m（或 4 倍容差）视为异常
            x = np.array(e["b"], dtype=np.float64)
        out.append(x)
    out = np.array(out)
    return out @ R  # 逆旋转（R 为正交阵）


def ortho_building(poly_m, holes_m, ang, enable):
    """
    直角化并校验（面积对称差 ≤18% 才接受），失败则回退到原轮廓。返回 shapely Polygon。

    Args:
        poly_m:  外环顶点 (N,2)，米
        holes_m: 内环顶点数组列表，米
        ang:     这栋楼的主方向（弧度）
        enable:  False 时只做有效性修复不直角化（--no-ortho，或场馆这类异形建筑）
    """
    src = Polygon(poly_m, holes_m)
    if not src.is_valid:
        src = src.buffer(0)  # 自交的像素轮廓靠 buffer(0) 修；拆成多块时只留最大的一块
        if isinstance(src, MultiPolygon):
            src = max(src.geoms, key=lambda g: g.area)
    if not enable:
        return src
    shell = orthogonalize(np.asarray(src.exterior.coords)[:-1], ang)  # [:-1]: shapely 的环首尾重复一点
    if shell is None or len(shell) < 3:
        return src
    holes = []
    for h in src.interiors:
        hh = orthogonalize(np.asarray(h.coords)[:-1], ang)
        if hh is not None and len(hh) >= 3:
            holes.append(hh)
    try:
        cand = Polygon(shell, holes)
        if not cand.is_valid or cand.area <= 0:
            return src
        # 对称差 = 多出来的 + 少掉的面积。直角化本意是修锯齿，改动应该很小；差太多说明吸附把形状搞错了
        # （比如把真正的斜楼硬掰成阶梯），宁可保留原轮廓
        diff = cand.symmetric_difference(src).area / src.area
        if diff > 0.18:
            return src
        clean = cand.simplify(0.05, preserve_topology=True)  # 5cm 容差: 只去掉求交产生的重合 / 共线点
        return clean if clean.is_valid and isinstance(clean, Polygon) else cand
    except Exception:
        return src


# ----------------------------------------------------------------------------
# 道路骨架 → 中心线图
# ----------------------------------------------------------------------------
N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]  # 8 邻域 (dy, dx)


def skeletonize_mask(mask):
    """
    细化成单像素骨架: 优先 scikit-image，其次 opencv-contrib 的 thinning，都没有返回 None。

    两种实现结果略有差别（skimage 的 Zhang 算法毛刺更少），后面 prune_and_merge 都能兜住。
    Args:
        mask: 0/255 道路掩膜
    Returns:
        同尺寸 bool 数组，True = 骨架像素；无可用实现时 None（调用方跳过道路图生成）
    """
    try:
        from skimage.morphology import skeletonize
        return skeletonize(mask > 0)
    except ImportError:
        if hasattr(cv2, "ximgproc"):
            return cv2.ximgproc.thinning(mask) > 0
        log("警告: 未安装 scikit-image，跳过道路中心线/斑马线生成 (pip install scikit-image)")
        return None


def skeleton_graph(sk):
    """
    骨架像素 → 图。返回 nodes{id:(x,y)}, edges[[a,b,pts(N,2 xy)]]
    节点 = 邻居数 ≠ 2 的骨架像素（端点、分叉点），相邻的节点像素聚成一个；边 = 从节点出发沿骨架走到下一个节点的像素串。
    没有任何节点的闭环（孤立的环道）单独处理成自环边。

    坐标约定: 内部数组四周各补 1 像素（skp），这样邻域访问不用做边界判断；
    输出的节点 / 路径坐标都已减 1 回到原图像素坐标，(x, y) 顺序，y 向下。
    节点 id 就是连通域标号（从 1 起），边的 a/b 是节点 id。
    """
    H, W = sk.shape
    skp = np.pad(sk, 1).astype(np.uint8)
    # 每个骨架像素的 8 邻域里有几个骨架像素: 用 8 次整体平移相加，比逐像素循环快得多
    nb = np.zeros_like(skp, dtype=np.int32)
    for dy, dx in N8:
        nb += np.roll(np.roll(skp, dy, 0), dx, 1)
    nb *= skp  # 非骨架像素清零
    is_node = (skp > 0) & (nb != 2) & (nb > 0)  # 邻居 = 2 是路中间的普通像素；1 = 端点，≥3 = 分叉；0 = 孤立点不要

    # 相邻的节点像素聚成一个节点
    # 骨架在分叉处常是一小团 2~4 个像素都满足邻居 ≥3，不聚合就会产生一堆挤在一起的假节点和零长边
    ncomp, lab = cv2.connectedComponents(is_node.astype(np.uint8), connectivity=8)
    nodes = {}
    for k in range(1, ncomp):
        ys, xs = np.nonzero(lab == k)
        nodes[k] = (float(xs.mean()) - 1, float(ys.mean()) - 1)  # 团的质心；-1 去掉 pad

    visited = np.zeros_like(skp, dtype=bool)
    edges = []
    direct = set()  # 直接相邻的两个节点团之间的边，用 (小 id, 大 id) 去重

    def walk(start_id, y0, x0, y1, x1):
        """从节点 start_id 的邻居 (y1,x1) 出发沿骨架走，碰到别的节点就停。返回 (终点节点 id 或 None, 像素路径)"""
        path = [(x0 - 1, y0 - 1), (x1 - 1, y1 - 1)]
        py, px, cy, cx = y0, x0, y1, x1  # p = 上一步，c = 当前；不回头走
        while True:
            visited[cy, cx] = True
            nxt = None
            end_id = None
            for dy, dx in N8:
                yy, xx = cy + dy, cx + dx
                if not skp[yy, xx] or (yy == py and xx == px):
                    continue
                if lab[yy, xx]:
                    # 碰到节点像素: 是别的节点就结束；是出发节点自己的团，刚出发时跳过（团里相邻像素），
                    # 走出 4 步以上再碰到才算真的绕回来了（自环，比如小环道）
                    if lab[yy, xx] != start_id or len(path) > 4:
                        end_id = lab[yy, xx]
                        break
                    continue
                if not visited[yy, xx]:
                    nxt = (yy, xx)
            if end_id is not None:
                return end_id, path
            if nxt is None:
                return None, path  # 走到头也没碰到节点（理论上不会: 端点本身就是节点），丢弃
            py, px, cy, cx = cy, cx, nxt[0], nxt[1]
            path.append((cx - 1, cy - 1))

    # 从每个节点像素出发，沿每个非节点邻居走一条边。visited 保证同一条边不会从两头各走一遍
    ys, xs = np.nonzero(is_node)
    for y, x in zip(ys, xs):
        sid = lab[y, x]
        for dy, dx in N8:
            yy, xx = y + dy, x + dx
            if not skp[yy, xx]:
                continue
            if lab[yy, xx]:
                # 两个不同的节点团直接贴在一起（中间没有普通像素）: 补一条两点直连的零长边，否则图会断开
                oid = lab[yy, xx]
                if oid != sid and (min(sid, oid), max(sid, oid)) not in direct:
                    direct.add((min(sid, oid), max(sid, oid)))
                    edges.append([sid, oid, np.array([nodes[sid], nodes[oid]])])
                continue
            if visited[yy, xx]:
                continue
            eid, path = walk(sid, y, x, yy, xx)
            if eid is None or len(path) < 2:
                continue
            pts = [nodes[sid]] + path[1:] + [nodes[eid]]  # 两端换成节点质心，中间是像素路径
            edges.append([sid, eid, np.array(pts, dtype=np.float64)])

    # 没有任何节点的纯环路
    # 一个完整的圆环道路，骨架上每个像素邻居都恰好是 2，上面的扫描一个节点都找不到。
    # 这里把剩下没走过的像素串起来，随便挑起点当节点，做成一条 a == b 的自环边
    rest = (skp > 0) & ~visited & ~is_node
    nid = max(nodes.keys(), default=0) + 1
    while rest.any():
        y, x = map(int, np.argwhere(rest)[0])
        path = [(x - 1, y - 1)]
        rest[y, x] = False
        cy, cx = y, x
        while True:  # 贪心走: 每步取第一个还没走过的邻居，直到无路可走
            moved = False
            for dy, dx in N8:
                yy, xx = cy + dy, cx + dx
                if rest[yy, xx]:
                    rest[yy, xx] = False
                    path.append((xx - 1, yy - 1))
                    cy, cx = yy, xx
                    moved = True
                    break
            if not moved:
                break
        if len(path) > 10:  # 太短的碎片是骨架噪声，不当环路
            nodes[nid] = (float(path[0][0]), float(path[0][1]))
            edges.append([nid, nid, np.array(path + [path[0]], dtype=np.float64)])  # 末尾补上起点使折线闭合
            nid += 1
    return nodes, edges


def poly_len(pts):
    """折线长度"""
    return float(np.hypot(*np.diff(pts, axis=0).T).sum()) if len(pts) > 1 else 0.0


def prune_and_merge(nodes, edges, dt):
    """
    剪掉骨架毛刺，再把度为 2 的节点两侧的边拼起来，并把挨得太近的路口合并。
    dt 是道路掩膜的距离变换（每个像素到路边的距离），用来估路宽。返回 (edges, deg, width_of)

    三种整理在一个循环里轮流做，每做一处就从头重新算度数，直到没有可做的为止:
      1) 剪毛刺 —— 细化算法在路边每个小凸起处都会长出一根短刺；
      2) 拼接度 2 节点 —— 剪掉毛刺后原来的三岔口只剩两条边，要把它们接成一条完整的路；
      3) 合并近邻路口 —— 见下面的注释。
    edges 就地修改（元素为 [a, b, pts] 列表），nodes 也会被改（合并路口时更新坐标）。
    Args:
        nodes: skeleton_graph 的节点字典 {id: (x, y)}，像素
        edges: skeleton_graph 的边列表
        dt:    cv2.distanceTransform 的结果（float32，像素）
    Returns:
        (edges, deg, width_of): 整理后的边、每个节点的度、按折线估路宽的函数（像素）
    """
    def width_of(pts):
        """一条边的路宽（像素）: 沿线距离变换的中位数 × 2。中位数不受路口处（局部很宽）和毛刺端点（很窄）影响"""
        ix = np.clip(pts[:, 0].round().astype(int), 0, dt.shape[1] - 1)
        iy = np.clip(pts[:, 1].round().astype(int), 0, dt.shape[0] - 1)
        return 2.0 * float(np.median(dt[iy, ix]))

    def max_width_of(pts):
        """沿线最宽处（毛刺判断用）"""
        ix = np.clip(pts[:, 0].round().astype(int), 0, dt.shape[1] - 1)
        iy = np.clip(pts[:, 1].round().astype(int), 0, dt.shape[0] - 1)
        return 2.0 * float(dt[iy, ix].max())

    while True:
        deg = {}  # 节点度: 自环边两端同一节点，算 2
        for a, b, _ in edges:
            deg[a] = deg.get(a, 0) + 1
            deg[b] = deg.get(b, 0) + 1
        # 毛刺: 一端悬空、另一端是路口，且长度 < 1.2 倍路宽。一轮里全部剪掉
        # 用 max_width_of 而不是中位数: 毛刺根部在路口里，那里的距离变换值就是它被「长出来」的尺度；
        # 真正的断头路（比如通到图外的路）远比路宽长，不会被误剪。deg == 1 且另一端也是 1 的孤立线段也保留
        spurs = [e for e in edges if e[0] != e[1]
                 and ((deg[e[0]] == 1 and deg[e[1]] >= 3) or (deg[e[1]] == 1 and deg[e[0]] >= 3))
                 and poly_len(e[2]) < 1.2 * max_width_of(e[2])]
        if spurs:
            for e in spurs:
                remove_by_id(edges, e)
            continue
        # 拼接度为 2 的节点
        # 剪掉毛刺后留下的「假路口」只连两条边，把两条折线首尾接起来成一条；每次只拼一个然后重算度数
        merged = False
        for n, d in deg.items():
            if d != 2:
                continue
            inc = [e for e in edges if e[0] == n or e[1] == n]
            if len(inc) != 2 or inc[0] is inc[1]:  # 自环边会在 inc 里出现一次但占 2 度，跳过
                continue
            e1, e2 = inc
            if e1[0] == e1[1] or e2[0] == e2[1]:
                continue
            # 把两条边都摆成「朝向 n」和「离开 n」的方向: p1 以 n 结尾，p2 以 n 开头
            p1 = e1[2] if e1[1] == n else e1[2][::-1]
            a = e1[0] if e1[1] == n else e1[1]
            p2 = e2[2] if e2[0] == n else e2[2][::-1]
            b = e2[1] if e2[0] == n else e2[0]
            remove_by_id(edges, e1)
            remove_by_id(edges, e2)
            edges.append([a, b, np.vstack([p1, p2[1:]])])  # p2[0] 就是 n，和 p1[-1] 重复，去掉
            merged = True
            break
        if merged:
            continue
        # 路口合并: 宽路和窄路相交时，骨架常把一个路口拆成两个挨得很近的节点，中间连一条比路宽还短的「假路段」。
        # 留着它车会在路口里面排队、和别的进口道的车叠在一起。把这种边收缩掉，两个节点并成一个。
        short = None  # 每轮只收缩最短的一条，收缩后度数变了要重算
        for e in edges:
            a, b, pts = e
            if a != b and deg[a] >= 3 and deg[b] >= 3 and poly_len(pts) < 0.9 * max_width_of(pts):  # 两端都是路口、比路宽还短
                if short is None or poly_len(pts) < poly_len(short[2]):
                    short = e
        if short is None:
            break  # 三种整理都无事可做，收工
        a, b, _ = short
        remove_by_id(edges, short)
        # 合并后的位置取两者里「更靠路中心」的那个（距离变换值大的）。取中点会让节点偏离宽路的中心线，
        # 而车道是按「到节点的距离」截短的，一偏支路车道就伸进主干路里去了
        def dt_at(n_):
            x_, y_ = nodes[n_]
            return float(dt[min(dt.shape[0] - 1, max(0, int(round(y_)))), min(dt.shape[1] - 1, max(0, int(round(x_))))])
        pos = nodes[a] if dt_at(a) >= dt_at(b) else nodes[b]
        nodes[a] = pos  # b 并入 a: 所有引用 b 的边端点改成 a，端点坐标也挪到新位置
        for e in edges:
            for end in (0, 1):
                if e[end] in (a, b):
                    e[end] = a
                    e[2] = e[2].copy()  # 先拷贝再改，避免几条边共享同一个数组
                    e[2][0 if end == 0 else -1] = pos
        # 合并后可能出现很短的自环（原来两点之间的另一条平行短边），一并去掉
        edges[:] = [e for e in edges if not (e[0] == e[1] and poly_len(e[2]) < 3 * max_width_of(e[2]))]
    deg = {}
    for a, b, _ in edges:
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1
    return edges, deg, width_of


def point_at(pts, s):
    """
    折线上弧长 s 处的点与切向。

    Args:
        pts: (N,2) 折线顶点（单位随调用方，main 里是米）
        s:   从起点量起的弧长；超出总长时返回终点和最后一段的方向
    Returns:
        (点 (2,), 单位切向量 (2,))
    """
    seg = np.diff(pts, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    acc = 0.0
    for i, l in enumerate(L):
        if l < 1e-9:  # 重合点产生的零长段，跳过以免除零
            continue
        if acc + l >= s:
            t = (s - acc) / l
            return pts[i] + seg[i] * t, seg[i] / l
        acc += l
    k = len(L) - 1  # s 超出折线: 找最后一段非零长的段作为切向
    while k > 0 and L[k] < 1e-9:
        k -= 1
    return pts[-1].copy(), seg[k] / max(L[k], 1e-9)


def cut_polyline(pts, s0, s1):
    """
    截取弧长 [s0, s1] 之间的子折线。

    两端用 point_at 插值出精确端点，中间保留落在区间内的原顶点，所以曲线形状不变。
    调用方保证 s0 < s1 且都在 [0, 总长] 内。
    """
    out = [point_at(pts, s0)[0]]
    seg = np.diff(pts, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    acc = 0.0
    for i, l in enumerate(L):
        acc += l
        if s0 < acc < s1:  # 顶点 pts[i+1] 的弧长 = acc，落在区间内才保留
            out.append(pts[i + 1])
    out.append(point_at(pts, s1)[0])
    return np.array(out)


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------
def match_drawn_road(pts, roads, pad):
    """
    骨架提取出的一条道路边，对应编辑器里画的哪条路（取车道数、单行方向用）

    标记图上的路只是一片蓝色，骨架化以后得到的边和用户画的折线不是一一对应的（路口会把一条画线切成几段，
    画线之间的连接处也可能多出短边），所以按「几何重合」匹配: 在边上均匀取最多 15 个点，
    落在某条画线「半宽 + pad」范围内的比例 ≥ 60% 就算这条路。

    Args:
        pts: 边的像素路径 (N, 2)，x, y
        roads: [{"points": (M, 2) 像素折线（按行驶方向画）, "width_px", "lanes" 每方向车道数, "oneway"}]
        pad: 额外容差（像素），骨架会偏离画线中心一点，路口附近更明显
    Returns:
        (lanes, dir): lanes = 每方向车道数（0 = 没匹配 / 没指定，前端按路宽推）；
                      dir = +1 单行且沿边的点序行驶，-1 单行且逆点序，0 双向
    """
    pts = np.asarray(pts, np.float64)
    if not roads or len(pts) < 2:
        return 0, 0
    idx = np.linspace(0, len(pts) - 1, min(len(pts), 15)).round().astype(int)  # 均匀取样
    S = pts[idx]
    T = np.gradient(S, axis=0)  # 每个采样点处边的走向
    best = (0.0, None, None)  # (重合比例, 画线, 每个采样点最近画线段的方向)
    for r in roads:
        P = np.asarray(r["points"], np.float64)
        if len(P) < 2:
            continue
        A, D = P[:-1], P[1:] - P[:-1]  # 画线的各段: 起点、方向向量
        L2 = np.maximum((D ** 2).sum(1), 1e-9)
        # 每个采样点到每一段的投影参数 t（截到 [0, 1]）和最近点 → 距离矩阵 (采样点, 段)
        t = np.clip(((S[:, None, :] - A[None]) * D[None]).sum(2) / L2[None], 0, 1)
        Q = A[None] + t[..., None] * D[None]
        d = np.hypot(S[:, None, 0] - Q[..., 0], S[:, None, 1] - Q[..., 1])
        frac = float((d.min(1) <= r.get("width_px", 0) / 2 + pad).mean())  # 落在路面范围内的采样点比例
        if frac > best[0]:
            best = (frac, r, D[d.argmin(1)])
    frac, r, dirs = best
    if frac < 0.6:
        return 0, 0  # 没有哪条画线和它重合: 可能是画线之间的连接短边，按路宽推车道
    lanes = int(r.get("lanes") or 0)
    if not r.get("oneway"):
        return lanes, 0
    # 单行: 边的走向和画线方向点积之和的符号 = 沿点序还是逆点序行驶
    return lanes, (1 if float((T * dirs).sum()) >= 0 else -1)


def apply_junctions(nodes, junctions, reach=12.0):
    """
    场景编辑器的路口设置 → roadGraph 节点属性（就地修改 nodes）

    编辑器里的路口是用户点的一个位置，生成前还不知道路网会被骨架化成哪些节点，所以按距离对:
    每条设置找「度 ≥ 3、离得最近、且在 路口半径 + reach 米以内」的节点。
    Args:
        nodes: roadGraph["nodes"]，{id: {pos, radius, degree, ...}}，坐标米
        junctions: [{pos: [x, y] 米, control: "signal" | "none", green: [东西, 南北] 秒 | None, noLeft: 布尔}]
    Returns:
        对上的个数
    """
    hit = 0
    for j in junctions:
        best, bd = None, None
        for n in nodes.values():
            if n.get("degree", 0) < 3 or n.get("roundabout") or n.get("level"):
                continue  # 只有平面交叉的路口才有灯 / 转向限制
            d = math.hypot(n["pos"][0] - j["pos"][0], n["pos"][1] - j["pos"][1])
            if d <= n.get("radius", 0) + reach and (bd is None or d < bd):
                best, bd = n, d
        if best is None:
            continue
        hit += 1
        best["control"] = "none" if j.get("control") == "none" else "signal"
        if j.get("green") and best["control"] == "signal":
            best["signal"] = {"green": [float(j["green"][0]), float(j["green"][1])]}
        if j.get("noLeft"):
            best["noLeft"] = True
    return hit


def geom_to_json(g, nd=2):
    """
    shapely 几何 → [{polygon, holes}]（多部件拆开，面积 < 1㎡ 的丢掉），坐标保留 nd 位小数。

    这是 scene.json 里所有面状要素的统一格式: polygon 为外环顶点列表（不重复首点），holes 为内环列表。
    GeometryCollection 里的线 / 点部件（差集运算偶尔会产生）直接忽略。
    """
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]
    out = []
    for p in polys:
        if p.is_empty or p.area < 1.0:
            continue
        out.append({
            "polygon": [[round(x, nd), round(y, nd)] for x, y in list(p.exterior.coords)[:-1]],
            "holes": [[[round(x, nd), round(y, nd)] for x, y in list(h.coords)[:-1]] for h in p.interiors],
        })
    return out


def main():
    # ---------------- 参数 ----------------
    ap = argparse.ArgumentParser(description="标记图 → scene.json", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("image", help="涂好标记色的地图图片 (png/jpg)")
    ap.add_argument("-o", "--out", default="scene.json")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--width-m", type=float, help="整张图片宽度对应的实际米数")
    g.add_argument("--mpp", type=float, help="米/像素（与 --width-m 二选一，都不给则按图宽=300m）")
    ap.add_argument("--markers", help="自定义标记调色板 json（格式见 markers.default.json）")
    ap.add_argument("--tol", type=float, default=100, help="颜色容差（RGB 距离），底图颜色干扰大时调小")
    ap.add_argument("--min-sat", type=float, default=70, help="饱和度门槛（max-min），低于它的像素一律当作未标记")
    ap.add_argument("--no-ortho", action="store_true", help="关闭建筑轮廓直角化")
    ap.add_argument("--simplify-m", type=float, default=0.7, help="轮廓简化容差（米）")
    ap.add_argument("--site", choices=["auto", "full"], default="auto", help="地块范围: auto=标记内容的外包络, full=整张图")
    ap.add_argument("--site-margin-m", type=float, default=6.0, help="地块外包络向外扩的人行边（米）")
    ap.add_argument("--door-spacing-m", type=float, default=14.0, help="自动店门间距（米）")
    ap.add_argument("--crosswalk-spacing-m", type=float, default=90.0, help="长路段中途补斑马线的间距（米），0=不补")
    ap.add_argument("--sidecar", help="附带的 json: 标记图上画不了的东西 —— 轨道交通线路/车站、场馆信息、逐人仿真的核心区范围（像素坐标）")
    ap.add_argument("--debug", help="输出叠加了识别结果的预览图")
    args = ap.parse_args()

    markers = json.loads(Path(args.markers).read_text("utf-8")) if args.markers else DEFAULT_MARKERS
    img = imread_unicode(args.image)
    H, W = img.shape[:2]
    # mpp = 米/像素，全文所有「米 ↔ 像素」换算都靠它。--width-m 给的是整张图的宽度对应多少米
    mpp = args.mpp or ((args.width_m or 300.0) / W)
    log(f"图片 {W}x{H}px, 比例 {mpp:.4f} m/px → {W * mpp:.0f}x{H * mpp:.0f} m")

    # ---------------- 归类 → 每种标记一张掩膜 ----------------
    cls = classify(img, markers, args.tol, args.min_sat)
    px = lambda m_: max(1, int(round(m_ / mpp)))  # 米 → 像素（至少 1px，形态学核尺寸不能为 0）

    # 每种标记一张 0/255 掩膜，按 markers 索引存；下面各图层再按 layer 字段挑出各自的索引列表
    layer_mask = {}
    for i, m in enumerate(markers):
        layer_mask[i] = (cls == i).astype(np.uint8) * 255

    bld_idx = [i for i, m in enumerate(markers) if m["layer"] == "building"]
    road_idx = [i for i, m in enumerate(markers) if m["layer"] == "road"]
    area_idx = [i for i, m in enumerate(markers) if m["layer"] == "area"]
    elev_idx = [i for i, m in enumerate(markers) if m["layer"] == "elevated"]
    door_idx = [i for i, m in enumerate(markers) if m["layer"] == "door"]
    portal_idx = [i for i, m in enumerate(markers) if m["layer"] == "portal"]

    # 点状标记先取质心，再把它们占的像素还给周围的面状图层（否则建筑边上会缺一口）
    def dots(idx_list):
        """
        点状标记的连通域质心（像素）。

        一个圆点就是一个连通域，不管画多大都只算一个点；两个点画得挨在一起会被合成一个，标记时留点距离。
        Returns:
            [(x, y), ...] 像素坐标
        """
        pts = []
        for i in idx_list:
            n, _, stats, cent = cv2.connectedComponentsWithStats(layer_mask[i], connectivity=8)
            for k in range(1, n):  # 0 号是背景
                if stats[k, cv2.CC_STAT_AREA] >= 4:  # 少于 4 像素的多半是抗锯齿残留，不算一个点
                    pts.append(cent[k])
        return pts

    door_px = dots(door_idx)  # 像素坐标，后面各自吸附到建筑外墙 / 可走区域
    portal_px = dots(portal_idx)
    # 圆点盖住的像素要还给它所在的面状图层（否则建筑边上会缺一口）:
    # 只在圆点范围内取「该图层闭运算」的结果 —— 压在边线上的点补平缺口而不鼓包，落在内部的点补上洞
    dot_mask = np.zeros((H, W), np.uint8)
    dot_size = 0  # 最大的圆点直径（像素），决定补洞用的闭运算核有多大
    for i in door_idx + portal_idx:
        dot_mask |= layer_mask[i]
        n, _, stats, _ = cv2.connectedComponentsWithStats(layer_mask[i], connectivity=8)
        if n > 1:
            dot_size = max(dot_size, int(stats[1:, cv2.CC_STAT_WIDTH].max()), int(stats[1:, cv2.CC_STAT_HEIGHT].max()))
    dot_size = min(dot_size, px(8))  # 封顶 8m: 画得再大也不该把整栋楼闭成一坨
    if dot_size:
        dot_mask = cv2.dilate(dot_mask, np.ones((7, 7), np.uint8))  # 圆点周围一圈抗锯齿像素也一起补
        dot_k = cv2.getStructuringElement(cv2.MORPH_RECT, (dot_size + 11, dot_size + 11))  # 核要比圆点大，才能跨过它把两侧连上

    def area_mask(i):
        """
        面状图层的干净掩膜: 去噪 + 补回被圆点盖住的像素。

        闭运算核 0.8m（至少 3px）: 手绘色块边缘的抗锯齿缝一般不到 1m，再大就会把相邻两栋楼之间的窄巷粘起来。
        圆点补回只取「闭运算结果 ∩ 圆点范围」，圆点之外的像素不受影响。
        """
        m = clean_mask(layer_mask[i], 3, max(3, px(0.8) | 1))  # 先去噪点，否则闭运算会把碎点连成片
        if dot_size:
            m = m | (cv2.morphologyEx(m, cv2.MORPH_CLOSE, dot_k) & dot_mask)
        return m

    # 像素 ↔ 米: 原点在图片中心
    # 图像坐标 y 向下，输出也保持 y 向下（前端再翻到自己的坐标系），所以这里只有平移 + 缩放，没有翻转
    cx, cy = W / 2.0, H / 2.0
    to_m = lambda p: (np.asarray(p, dtype=np.float64) - [cx, cy]) * mpp
    to_px = lambda p: np.asarray(p, dtype=np.float64) / mpp + [cx, cy]

    # ---------------- 建筑 ----------------
    raw = []  # (marker, shell_m, holes_m)
    bmask_all = np.zeros((H, W), np.uint8)  # 所有建筑的并集，后面从道路 / 区域掩膜里扣掉，也用于环岛判断
    for i in bld_idx:
        m = area_mask(i)
        bmask_all |= m
        for shell, holes in mask_to_rings(m, px(4) ** 2):  # 小于 4m×4m 的色块不算楼
            s = simplify_ring(shell, max(1.0, args.simplify_m / mpp))  # 简化容差换成像素，至少 1px
            if s is None:
                continue
            hs = [h for h in (simplify_ring(h, max(1.0, args.simplify_m / mpp)) for h in holes) if h is not None]
            raw.append((markers[i], to_m(s), [to_m(h) for h in hs]))
    # sidecar 里直接给出的单栋轮廓（autoscene 用）: 挨在一起的房子在按类别涂色的标记图上会连成一块，
    # 被当成一栋；直接给轮廓就能保住「一栋一栋」。轮廓是像素坐标，kind / floors 跟着走
    side_early = json.loads(Path(args.sidecar).read_text("utf-8")) if args.sidecar else {}
    for fp in side_early.get("footprints", []):
        ring = np.asarray(fp["poly"], np.float64)
        if len(ring) < 3:
            continue
        cv2.fillPoly(bmask_all, [np.round(ring).astype(np.int32).reshape(-1, 1, 2)], 255)  # 也要从道路 / 铺装里扣掉
        mk = {"kind": fp.get("kind", "residential"), "floors": fp.get("floors") or 2, "fixed_floors": bool(fp.get("floors")),
              # 场景编辑器改已有场景时带上原来的楼编号和属性: 编号不变，实地标注等按编号挂的数据才对得上
              "id": fp.get("id"), "attrs": fp.get("attrs") or {}}
        raw.append((mk, to_m(ring), []))
    if side_early.get("footprints"):
        log(f"sidecar 单栋轮廓: {len(side_early['footprints'])} 栋")
    if not raw:
        log("警告: 没有识别到任何建筑色块（检查标记颜色，或调大 --tol）")

    # 全局主方向 = 所有楼的边长加权方向，代表街区网格的朝向；写进 scene.angle 供前端对齐地面贴图等
    g_ang = dominant_angle([r[1] for r in raw]) if raw else 0.0
    log(f"建筑 {len(raw)} 栋, 全局主方向 {math.degrees(g_ang):.1f}°")

    # 每栋楼: 自己的主方向（接近全局主方向就直接用全局的）→ 直角化 → 层数（写字楼按占地面积 6~28 层，住宅 9~18 层）
    buildings = []
    # 楼编号: sidecar 指定了就用（重复的只认第一个），其余从 b1 起顺序编、跳过已被占用的
    given, used = set(), set()
    for mk, _, _ in raw:
        bid = mk.get("id")
        if isinstance(bid, str) and bid and bid not in given:
            given.add(bid)
        else:
            mk["id"] = None  # 重复 / 非法: 当成没指定
    next_no = 1  # 下一个候选编号

    def new_id():
        """下一个没被指定编号占用的 b<n>"""
        nonlocal next_no
        while f"b{next_no}" in given or f"b{next_no}" in used:
            next_no += 1
        used.add(f"b{next_no}")
        return f"b{next_no}"

    for k, (mk, shell, holes) in enumerate(raw):
        ang = dominant_angle([shell])
        if ang_diff90(ang, g_ang) < math.radians(7):  # 7° 以内的偏差视为手抖，统一到街区方向，整片楼才会齐
            ang = g_ang
        kind = mk.get("kind", "shop")
        poly = ortho_building(shell, holes, ang, not args.no_ortho and kind != "venue")  # 场馆多是椭圆、异形，保持原样
        floors = mk.get("floors", 2)
        if mk.get("fixed_floors"):
            pass  # sidecar 轮廓自带层数（OSM / 影子估的 / 按面积给的），不再按类型随机
        elif kind == "block":
            floors = int(min(28, 6 + poly.area // 260 + (k * 7) % 5))  # 每 260㎡ 占地加 1 层，再加按序号的伪随机抖动，封顶 28
        elif kind == "residential":
            floors = 9 + (k * 5) % 10  # 9~18 层，按序号错开，避免一排楼一样高
        # attrs: 编辑器带过来的属性（场馆信息、实地标注写回的商户清单和吸引力、名称），原样写进场景
        attrs = {a: mk["attrs"][a] for a in ("venue", "attraction", "shops", "name") if a in mk.get("attrs", {})}
        buildings.append(dict(id=mk.get("id") or new_id(), kind=kind, floors=floors, angle=ang, geom=poly, **attrs))
    b_union = unary_union([b["geom"] for b in buildings]) if buildings else Polygon()  # 米制建筑并集，后面区域 / 可走范围要减掉它

    # ---------------- 道路 / 地块 / 人行铺装 ----------------
    rmask = np.zeros((H, W), np.uint8)
    for i in road_idx:
        rmask |= area_mask(i)
    rmask &= ~bmask_all  # 建筑优先: 涂色重叠处算楼不算路

    # 高架是盖在地面道路上画的，会把下面的路「切断」: 用闭运算把被盖住的那一段补回来
    emask = np.zeros((H, W), np.uint8)
    for i in elev_idx:
        emask |= area_mask(i)
    emask &= ~bmask_all
    if emask.any() and rmask.any():
        ew = int(cv2.distanceTransform(emask, cv2.DIST_L2, 5).max() * 2)  # 高架最宽处的宽度（像素）
        kk = int(ew * 1.4) | 1  # 闭运算核要能跨过整个桥面（斜穿时更宽，取 1.4 倍），| 1 保证奇数
        rmask |= cv2.morphologyEx(rmask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (kk, kk))) & emask  # 只在桥面范围内补，不影响别处
        # 两种标记色交界处的抗锯齿像素哪一类都不算，会在路面里留下细缝，骨架会因此碎成一堆 —— 在高架附近再闭一次封住
        near = cv2.dilate(emask, np.ones((9, 9), np.uint8))
        rmask |= cv2.morphologyEx(rmask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)) & near

    # 面状区域按优先级互斥: 先到先得，后面的类型只取还没被占的像素
    # 水体最优先（谁也不能盖住水），广场最靠后（它只是铺装花样，让给别的）
    AREA_PRIORITY = ["water", "parking", "green", "park", "plaza"]
    area_masks = {}
    taken = bmask_all | rmask  # 建筑和道路已经占掉的像素
    for kind in AREA_PRIORITY:
        m = np.zeros((H, W), np.uint8)
        for i in area_idx:
            if markers[i].get("kind") == kind:
                m |= area_mask(i)
        m &= ~taken
        if m.any():
            area_masks[kind] = clean_mask(m, max(3, px(1.0) | 1), 3)  # 减掉别的图层后会留下 1m 以内的碎边，开运算去掉
            taken |= area_masks[kind]

    # 地块范围: 所有标记内容的外包络（40m 闭运算把街区之间的缝合上），再外扩一圈人行边
    if args.site == "full":
        site_mask = np.full((H, W), 255, np.uint8)
    else:
        union = taken | emask  # 所有标记内容（含高架）
        kk = px(40) | 1  # 40m: 比两个街区之间的路宽 + 人行道都大，闭运算后街区之间不留缝
        scale = max(1, kk // 41)  # 大核闭运算很慢，降采样做
        small = cv2.resize(union, (W // scale, H // scale), interpolation=cv2.INTER_NEAREST)
        ks = max(3, (kk // scale) | 1)
        small = cv2.copyMakeBorder(small, ks, ks, ks, ks, cv2.BORDER_CONSTANT, value=0)  # 补黑边: 闭运算在图边缘会把内容「粘」到边框上
        small = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks)))
        small = small[ks:-ks, ks:-ks]
        closed = cv2.resize(small, (W, H), interpolation=cv2.INTER_NEAREST) | union  # 放回原尺寸后再并上原内容，补回降采样丢掉的细节
        cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        site_mask = np.zeros((H, W), np.uint8)
        cv2.drawContours(site_mask, cnts, -1, 255, -1)  # 只取最外层轮廓并填实: 内部的孔（街区中间的空地）都算地块
        mg = px(args.site_margin_m)
        if mg > 0:
            site_mask = cv2.dilate(site_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * mg + 1, 2 * mg + 1)))  # 外扩一圈当人行边

    def mask_to_geom(mask, simp):
        """
        掩膜 → 米制 shapely 几何（多个连通域并成一个 MultiPolygon），buffer(0) 修自交。

        Args:
            mask: 0/255 掩膜
            simp: simplify 容差（米）。像素轮廓一个像素一个点，不简化后面的 buffer / difference 会很慢
        """
        polys = []
        for shell, holes in mask_to_rings(mask, px(3) ** 2):  # 小于 3m×3m 的碎片丢掉
            p = Polygon(to_m(shell.reshape(-1, 2)), [to_m(h.reshape(-1, 2)) for h in holes if len(h) >= 3])
            p = p.buffer(0)
            if not p.is_empty:
                polys.append(p)
        return unary_union(polys).simplify(simp, preserve_topology=True) if polys else Polygon()

    # 从这里起全部在米制 shapely 几何上操作。simplify 容差: 地块 1m（边界粗糙无所谓）、道路 0.8m、区域 0.6m
    site = mask_to_geom(site_mask, 1.0)
    roads = mask_to_geom(rmask, 0.8)
    # 圆角: 先开后闭
    # join_style=1 是圆角 buffer；负→正把尖角磨圆（地块外包络的 40m 闭运算会留下尖刺），正→负把窄缝合上
    site = site.buffer(-5, join_style=1).buffer(5, join_style=1)
    roads = roads.buffer(1.0, join_style=1).buffer(-1.0, join_style=1)
    # 面状区域: 轮廓稍作平滑；绿地/水体本来就是自然形状，圆一点更好看
    areas = {}
    for kind, m in area_masks.items():
        g_ = mask_to_geom(m, 0.6)
        r_ = 1.5 if kind in ("green", "park", "water") else 0.8  # 自然形状用大半径，停车场 / 广场保留一点棱角
        g_ = g_.buffer(r_, join_style=1).buffer(-2 * r_, join_style=1).buffer(r_, join_style=1)  # 闭 + 开: 填缝再磨角，面积基本不变
        # 区域和道路 / 建筑之间留 0.2m 缝，避免共享边导致渲染 z-fighting；广场可以贴着楼（楼前广场很常见）
        g_ = g_.difference(roads.buffer(0.2)).difference(b_union.buffer(0.2)) if kind != "plaza" else g_.difference(roads.buffer(0.2))
        g_ = g_.simplify(0.2, preserve_topology=True)
        if not g_.is_empty:
            areas[kind] = g_
    empty = Polygon()
    # 可走区域 walk_free = 铺装 + 停车场 − 建筑 − 绿化带 − 水体，后面布门 / 出入口都要落在它里面
    # 水体和停车场在路面标高（从人行铺装里挖掉），绿化/公园/广场盖在铺装上面
    sunk = unary_union([areas.get("water", empty), areas.get("parking", empty)])
    pavement = site.difference(roads).difference(sunk)
    pavement = pavement.buffer(-2.5, join_style=1).buffer(2.5, join_style=1)  # 路口处人行道转角变圆
    pavement = pavement.simplify(0.15, preserve_topology=True)  # 0.15m: 前端要挤出成网格，顶点越少越好，但不能看出棱
    site = site.simplify(0.15, preserve_topology=True)
    blocked = unary_union([b_union.buffer(0.3), areas.get("green", empty), areas.get("water", empty)])  # 楼外扩 0.3m: 门不能贴着墙皮
    walk_free = unary_union([pavement, areas.get("parking", empty)]).difference(blocked)
    walk_prep = prep(walk_free)  # prepared geometry: 后面要做几百次 contains 查询，预处理后快一个数量级
    if areas:
        log("面状区域: " + ", ".join(f"{k} {v.area:.0f}㎡" for k, v in areas.items()))

    # ---------------- 环岛检测 ----------------
    # 道路掩膜里的孔洞，够圆（圆度 > 0.72）、半径 3~28m、里面没有建筑 → 环岛的中心岛
    islands = []  # (中心 px, 内半径 px, 轮廓)
    if rmask.any():
        cnts, hier = cv2.findContours(rmask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        for i, c in enumerate(cnts):
            if hier[0][i][3] == -1:  # 没有 parent 的是道路外轮廓，只看孔
                continue
            area = cv2.contourArea(c)
            peri = cv2.arcLength(c, True)
            # 圆度 = 4πA/P²，正圆为 1；0.72 能放过手画的椭圆，挡住街区那种方孔（正方形约 0.785 但通常带毛边更低）
            if not (math.pi * px(3) ** 2 < area < math.pi * px(28) ** 2) or 4 * math.pi * area / max(peri * peri, 1) < 0.72:
                continue
            m_ = cv2.moments(c)
            ctr = np.array([m_["m10"] / m_["m00"], m_["m01"] / m_["m00"]])  # 一阶矩 / 面积 = 质心
            hole = np.zeros((H, W), np.uint8)
            cv2.drawContours(hole, [c], -1, 255, -1)
            if (hole & bmask_all).sum() > 0.2 * hole.sum():  # 孔里有楼 → 是被环路围住的街区，不是环岛
                continue
            islands.append((ctr, math.sqrt(area / math.pi), c))  # 等面积圆的半径当内半径
        if islands:
            log(f"环岛 {len(islands)} 个")

    # ---------------- 道路中心线 / 斑马线 ----------------
    # road_graph 是前端车流的骨干数据:
    #   nodes[id] = {pos 米, radius 路口半径（到路边距离）米, degree 度, roundabout?, level?,
    #                control? / signal? / noLeft? 编辑器的路口设置（无灯、绿灯时长、禁止左转）}
    #   edges[]   = {a, b 节点 id, width 路宽米, points 中心线米, ext [两端路口深度], oneway?, roundabout?, median?, level?,
    #                laneCount? 编辑器指定的每方向车道数}
    # lanes 是给渲染用的车道线（已截掉路口和斑马线），crosswalks 是斑马线；三者坐标都是米
    lanes, crosswalks = [], []
    road_graph = {"nodes": {}, "edges": []}
    sk = skeletonize_mask(rmask) if rmask.any() else None
    if sk is not None and sk.any():
        dt = cv2.distanceTransform(rmask, cv2.DIST_L2, 5)  # 每个路面像素到最近路边的距离（像素），估路宽 / 路口半径全靠它
        nodes, edges = skeleton_graph(sk)
        edges, deg, width_of = prune_and_merge(nodes, edges, dt)

        # —— 路口归正 ——
        # 细化算法得到的骨架，窄路进宽路时是斜着接到宽路中心线上的，正对着的两条支路会接在相距二十多米的两个点上；
        # 后面车道的截短、斑马线的位置都是「从节点沿折线量距离」，节点不在真正的路口中心、折线进路口时拐弯，量出来就全是错的
        # （车道伸进横向道路里、车叠在一起）。所以:
        #   1) 用各条路在路口范围之外的直线段求交（最小二乘），得到路口的真实中心；
        #   2) 把各条路的折线从路口范围边缘直接拉直接到这个中心。
        def dt_m(pos_):
            """像素位置处的距离变换值（到路边的距离，像素）"""
            return float(dt[min(H - 1, max(0, int(round(pos_[1])))), min(W - 1, max(0, int(round(pos_[0]))))])

        ends = {}  # nid -> [(edge, end)]
        for e in edges:
            if e[0] == e[1]:
                continue
            ends.setdefault(e[0], []).append((e, 0))
            ends.setdefault(e[1], []).append((e, 1))
        reach = {}  # nid -> 路口范围半径（像素），只有度 ≥3 的真路口才有
        for nid, lst in ends.items():
            if deg.get(nid, 0) < 3:
                continue
            c_ = np.array(nodes[nid], dtype=np.float64)
            r_ = max(dt_m(c_) * 1.15, max(width_of(e[2]) for e, _ in lst) * 0.6)  # 路口范围: 至少盖住最宽那条路的半幅
            # 最小二乘求「离各条直线距离平方和最小」的点: 每条直线贡献投影矩阵 M = I - dd^T，
            # 解 (ΣM) x = Σ(M·mean)。两条平行线（同一条路穿过）时 A 奇异，靠下面的条件数判断
            A_ = np.zeros((2, 2))
            b_ = np.zeros(2)
            for e, end in lst:
                q = e[2] if end == 0 else e[2][::-1]  # 从路口这一端开始排
                far = q[np.hypot(q[:, 0] - c_[0], q[:, 1] - c_[1]) > r_][:int(30 / mpp)]  # 路口范围之外的前 30m，再远可能已经拐弯
                if len(far) < 8:  # 点太少拟合不出方向（短边、被路口范围整个盖住的边）
                    continue
                mean = far.mean(0)
                d_ = np.linalg.svd(far - mean)[2][0]  # 第一主成分 = 这段路的方向
                M_ = np.eye(2) - np.outer(d_, d_)
                A_ += M_
                b_ += M_ @ mean
            new = c_
            on_ring = any(np.hypot(c_[0] - ic[0], c_[1] - ic[1]) < ir + px(18) for ic, ir, _ in islands)  # 环岛的弧不是直线，不拿来求交
            if not on_ring and np.linalg.cond(A_) < 50:
                cand = np.linalg.solve(A_, b_)
                # 解出来的点必须仍在路口附近（1.6 倍范围）且落在路面上，否则是数值病态，保留原节点
                if np.hypot(*(cand - c_)) < r_ * 1.6 and rmask[min(H - 1, max(0, int(round(cand[1])))), min(W - 1, max(0, int(round(cand[0]))))]:
                    new = cand
            nodes[nid] = (float(new[0]), float(new[1]))
            reach[nid] = max(r_, dt_m(new) * 1.15)  # 新位置更靠路口中心，距离变换值可能更大，范围随之更新

        # 2) 拉直: 把每条边在路口范围内的那一截像素路径扔掉，换成「路口中心 → 范围边缘第一个点」的直线段
        for e in edges:
            a_, b_, pts_ = e
            if a_ == b_:
                continue
            for end, nid in ((0, a_), (1, b_)):
                if nid not in reach:
                    continue
                c_ = np.array(nodes[nid], dtype=np.float64)
                far = np.nonzero(np.hypot(pts_[:, 0] - c_[0], pts_[:, 1] - c_[1]) > reach[nid])[0]  # 范围之外的点的下标
                if len(far) < 2:
                    continue  # 整条边都在路口范围内（环岛的短弧等），不动
                pts_ = np.vstack([c_, pts_[far[0]:]]) if end == 0 else np.vstack([pts_[:far[-1] + 1], c_])
            e[2] = pts_

        # 斑马线深度 3.2m（前端画条纹的宽度），CORNER 2.5m = 路缘转角圆弧半径（和上面 pavement 的 buffer 2.5 对应），
        # 斑马线要放在转角之外才不会被人行道转角挡住
        CW_DEPTH, CORNER = 3.2, 2.5

        def ring_of(pts):
            """这条边是不是某个环岛的环道；是则返回行驶方向（+1 = 沿点序，-1 = 逆点序），环内一律逆时针（靠右行驶）"""
            for ctr, r_in, _ in islands:
                d = np.hypot(pts[:, 0] - ctr[0], pts[:, 1] - ctr[1])
                if d.min() > r_in * 0.7 and d.max() < r_in + px(18):  # 整条边都在「内半径 ~ 内半径 + 18m」的环带里才算环道，进出的支路不算
                    k = len(pts) // 2  # 取中点附近两点算叉积，判断绕行方向
                    a_, b_ = pts[max(0, k - 1)], pts[min(len(pts) - 1, k + 1)]
                    cross = (a_[0] - ctr[0]) * (b_[1] - a_[1]) - (a_[1] - ctr[1]) * (b_[0] - a_[0])
                    return 1 if cross < 0 else -1  # 图像坐标 y 向下: 叉积为负 = 屏幕上逆时针
            return 0

        # 路口沿某条路方向的范围 = 与它相交（不共线）的那些路的半宽，而不是它自己的半宽。
        # 窄支路接宽主干路时差别很大: 按自己路宽算，斑马线会画到主干路（甚至高架桥面）底下去。
        edge_w = [width_of(e[2]) * mpp for e in edges]  # 每条边的路宽（米），按 edges 下标索引
        # 编辑器画的路（sidecar roads，像素坐标）: 按几何重合找到对应的边，拿到车道数和单行方向
        drawn = [dict(r, width_px=float(r.get("width_m", 0)) / mpp) for r in side_early.get("roads", [])]
        drawn_of = [match_drawn_road(e[2], drawn, max(3.0, 2.0 / mpp)) for e in edges]  # 每条边: (车道数, 单行方向)

        def arm_dir(pts, at_start):
            """这条边从某端出发的方向（取前 20 个点）"""
            q = pts if at_start else pts[::-1]
            k = min(len(q) - 1, 20)  # 拉直后前 20 个点基本就是路口里那段直线，方向稳定
            d = q[k] - q[0]
            return d / max(np.hypot(*d), 1e-9)

        incident = {}  # nid -> [(边下标, 从路口出发的单位方向)]，自环不算
        for ei, (a_, b_, pts_) in enumerate(edges):
            if a_ == b_:
                continue
            incident.setdefault(a_, []).append((ei, arm_dir(pts_, True)))
            incident.setdefault(b_, []).append((ei, arm_dir(pts_, False)))

        def box_extent(nid, ei):
            """路口 nid 沿边 ei 方向的深度 = 与之相交的其他路的最大半宽（去掉自己的直行延续）"""
            arms = incident.get(nid, [])
            me = next((d for i, d in arms if i == ei), None)
            others = [(i, d) for i, d in arms if i != ei]
            if me is None or not others:  # 找不到自己（自环）或没有别的路: 退回用自己的半宽
                return edge_w[ei] / 2
            if len(others) >= 2:  # 去掉和自己最接近反向的那条（同一条路穿过路口的延续）
                cont = min(others, key=lambda t: float(np.dot(t[1], me)))
                if float(np.dot(cont[1], me)) < -0.7:  # 点积 < -0.7 ≈ 夹角 > 135°，确实是对面的延续而不是斜岔路
                    others = [t for t in others if t[0] != cont[0]]
            return max(edge_w[i] for i, _ in others) / 2

        # 桥下的路: 中心线大部分压在高架下面。桥面正下方是桥墩和隔离带，不走车，前端据此把车道排在桥面投影两侧
        edt_deck = cv2.distanceTransform(emask, cv2.DIST_L2, 5) if emask.any() else None

        def under_deck(pts):
            """返回这条路头顶桥面的半宽（米），不在桥下返回 0。取沿线的中位数: 高架交叉口、弯角处掩膜局部很宽，不能用全局最大值"""
            if edt_deck is None:
                return 0.0
            ix = np.clip(pts[:, 0].round().astype(int), 0, W - 1)
            iy = np.clip(pts[:, 1].round().astype(int), 0, H - 1)
            inside = emask[iy, ix] > 0
            return round(float(np.median(edt_deck[iy, ix][inside])) * mpp, 2) if inside.mean() > 0.6 else 0.0  # 60% 以上的点在桥下才算桥下路

        # 逐条边输出: roadGraph 的节点 / 边，车道线（截掉路口 + 斑马线），斑马线（路口进口道处 + 长路段中途）
        ring_nodes = set()  # 环道上的节点，前端按环岛规则（让行、不设红绿灯）处理
        for a, b, pts in edges:
            if ring_of(pts):
                ring_nodes.update((a, b))
        for ei, (a, b, pts) in enumerate(edges):
            w_m = edge_w[ei]
            ring = ring_of(pts)  # 0 = 不是环道；±1 = 环道及其行驶方向
            lane_n, d_dir = drawn_of[ei]  # 编辑器指定的每方向车道数（0 = 按路宽推）、单行方向
            oneway = ring or d_dir  # 0 = 双向；±1 = 单行（环道或编辑器画的单行路），沿 / 逆点序
            median = under_deck(pts)  # 桥面半宽（米），0 = 不在桥下
            # 像素路径每个像素一个点，太密；按 0.8m（至少 1.5px）容差简化成折线，closed=False
            sp = cv2.approxPolyDP(pts.astype(np.float32).reshape(-1, 1, 2), max(1.5, 0.8 / mpp), False).reshape(-1, 2).astype(np.float64)
            pm = to_m(sp)
            total = poly_len(pm)  # 这条边的长度（米），下面截车道 / 放斑马线都按弧长算
            for nid in (a, b):
                nx_, ny_ = nodes[nid]
                rad = float(dt[min(H - 1, max(0, int(round(ny_)))), min(W - 1, max(0, int(round(nx_))))]) * mpp  # 节点处到路边的距离 = 路口半径（米）
                road_graph["nodes"][str(nid)] = {"pos": [round(float(v), 2) for v in to_m([nx_, ny_])], "radius": round(rad, 2), "degree": int(deg.get(nid, 0)),
                                                 **({"roundabout": True} if nid in ring_nodes else {})}
            road_graph["edges"].append({"a": str(a), "b": str(b), "width": round(w_m, 2), "points": [[round(float(x), 2), round(float(y), 2)] for x, y in pm],
                                        **({"oneway": oneway} if oneway else {}), **({"roundabout": True} if ring else {}),
                                        **({"median": median} if median else {}), **({"laneCount": lane_n} if lane_n else {}),
                                        # ext: 路口沿这条路方向伸进来多深（两端各一个），车道据此截短；比用路口半径准，宽路接窄路时差很多
                                        "ext": [round(box_extent(a, ei), 2) if deg.get(a, 0) >= 3 else 0, round(box_extent(b, ei), 2) if deg.get(b, 0) >= 3 else 0]})
            if ring:  # 环道: 不设斑马线，只画车道分隔线（点序调成行驶方向，前端按「行驶方向右侧」算偏移）
                if total > 8:
                    piece = cut_polyline(pm, 3.0, total - 3.0)
                    lanes.append(dict(points=piece if oneway == 1 else piece[::-1], width=w_m, oneway=True))
                continue
            # trim[end] = 这一端要从车道线上截掉的长度（米）: 路口深度 + 转角 + 斑马线 + 停止线间隙
            trim = [0.0, 0.0]
            for end, nid in ((0, a), (1, b)):
                is_junction = deg.get(nid, 0) >= 3
                if is_junction:
                    d0 = box_extent(nid, ei) + CORNER + 0.5  # 斑马线起点: 出了路口范围、过了转角圆弧再留 0.5m
                    if total > 2 * (d0 + CW_DEPTH) + 4:  # 两头都放斑马线后中间还剩 4m 以上才放，短边不放
                        s = d0 + CW_DEPTH / 2  # 斑马线中心的弧长位置
                        c, t = point_at(pm, s if end == 0 else total - s)
                        # node/edge: 这条斑马线属于哪个路口的哪条路，前端据此挂红绿灯
                        crosswalks.append(dict(center=c, dir=t, span=w_m + 1.0, depth=CW_DEPTH, node=str(nid), edge=len(road_graph["edges"]) - 1))  # span 比路宽多 1m，两头压到路缘
                    trim[end] = d0 + CW_DEPTH + 1.5  # 车道线在斑马线后 1.5m 处开始（停止线位置）
                else:
                    trim[end] = 1.0  # 断头路 / 图边: 只留 1m 不画到头
            usable = total - trim[0] - trim[1]
            if usable < 6:  # 截完不到 6m 的路段不画车道线（路口之间的短接段）
                continue
            # 长路段中途补斑马线
            # 没有 node/edge 字段: 中途斑马线不属于任何路口，前端不挂红绿灯（行人优先过街）
            mids = []
            if args.crosswalk_spacing_m > 0 and usable > args.crosswalk_spacing_m * 1.6:  # 至少 1.6 倍间距才值得在中间放一条
                k = int(usable // args.crosswalk_spacing_m)
                mids = []
                for j in range(k):
                    s0 = trim[0] + usable * (j + 1) / (k + 1)  # k 条斑马线把可用段等分成 k+1 份
                    for off in (0, 15, -15, 30, -30):  # 避开弯道: 前后 8m 切向基本一致才放
                        s = s0 + off
                        if s - 10 < trim[0] or s + 10 > total - trim[1]:  # 偏移后不能撞到两头的路口斑马线
                            continue
                        t0, t1 = point_at(pm, s - 8)[1], point_at(pm, s + 8)[1]
                        if float(np.dot(t0, t1)) > 0.985:  # cos 10° ≈ 0.985: 16m 内转向不到 10° 算直路
                            mids.append(s)
                            break
                mids.sort()
                for s in mids:
                    c, t = point_at(pm, s)
                    crosswalks.append(dict(center=c, dir=t, span=w_m + 1.0, depth=CW_DEPTH))
            # 车道线按斑马线切段: cuts 是 [起, 止, 起, 止, ...] 的弧长列表，每条斑马线两侧各让 1m
            cuts = [trim[0]] + [v for s in mids for v in (s - CW_DEPTH / 2 - 1, s + CW_DEPTH / 2 + 1)] + [total - trim[1]]
            for j in range(0, len(cuts), 2):
                if cuts[j + 1] - cuts[j] > 5:  # 5m 以下的碎段不画
                    piece = cut_polyline(pm, cuts[j], cuts[j + 1])
                    # 编辑器画的单行路: 点序调成行驶方向；laneCount 让前端按指定车道数排车道
                    lanes.append(dict(points=piece if oneway >= 0 else piece[::-1], width=w_m, median=median, oneway=bool(oneway), laneCount=lane_n))
        log(f"道路中心线 {len(lanes)} 段, 斑马线 {len(crosswalks)} 处")
        # 编辑器的路口设置（sidecar junctions，像素坐标）: 对到最近的路口节点上，写进节点给前端的信号灯 / 车流用
        apply_junctions(road_graph["nodes"], [dict(j, pos=to_m(j["pos"]).tolist()) for j in side_early.get("junctions", [])])

    # ---------------- 高架 ----------------
    # 桥面多边形 + 自己的骨架图（节点 id 加 e 前缀，level=1）；不和地面路网相连，上下桥的匝道由前端按需生成
    elevated = Polygon()
    if emask.any():
        # join_style=2 是尖角（mitre）: 桥面边缘要保持直，不像道路那样磨圆
        elevated = mask_to_geom(emask, 1.0).buffer(0.8, join_style=2).buffer(-0.8, join_style=2).simplify(0.6, preserve_topology=True)
        esk = skeletonize_mask(emask)
        if esk is not None and esk.any():
            edt = cv2.distanceTransform(emask, cv2.DIST_L2, 5)
            enodes, eedges = skeleton_graph(esk)
            eedges, edeg, ewidth = prune_and_merge(enodes, eedges, edt)
            # 高架不做路口归正 / 斑马线: 高架之间通常只有匝道分合流，没有平面交叉
            for a, b, pts in eedges:
                w_m = ewidth(pts) * mpp
                sp = cv2.approxPolyDP(pts.astype(np.float32).reshape(-1, 1, 2), max(1.5, 0.8 / mpp), False).reshape(-1, 2).astype(np.float64)
                pm = to_m(sp)
                if poly_len(pm) < 20:  # 20m 以下的碎段（骨架在桥面分合流处的残余）不要
                    continue
                # 节点 id 加 e 前缀避免和地面路网撞号；radius 直接取半幅路宽（高架没有真正的路口）
                for nid in (a, b):
                    road_graph["nodes"][f"e{nid}"] = {"pos": [round(float(v), 2) for v in to_m(enodes[nid])], "radius": round(w_m / 2, 2), "degree": int(edeg.get(nid, 0)), "level": 1}
                road_graph["edges"].append({"a": f"e{a}", "b": f"e{b}", "width": round(w_m, 2), "level": 1, "points": [[round(float(x), 2), round(float(y), 2)] for x, y in pm]})
                lanes.append(dict(points=cut_polyline(pm, 1.0, poly_len(pm) - 1.0), width=w_m, level=1))  # 两头各留 1m，不截路口 / 斑马线
        log(f"高架 {elevated.area:.0f}㎡")

    # 环岛中心岛做成绿地
    # 孔洞轮廓本来就是路面的边，内缩 0.6m 留出路缘石；中心岛不可走，从 walk_free 里挖掉并重建 prepared 几何
    if islands:
        isl = unary_union([Polygon(to_m(c.reshape(-1, 2))).buffer(0).simplify(0.4).buffer(-0.6, join_style=1) for _, _, c in islands])
        areas["green"] = unary_union([areas["green"], isl]) if "green" in areas else isl
        walk_free = walk_free.difference(isl)
        walk_prep = prep(walk_free)

    # ---------------- sidecar: 核心区 / 场馆 / 轨道交通 ----------------
    # sidecar 里的坐标全是标记图的像素坐标（方便用户在图上量），这里统一换成米
    side = json.loads(Path(args.sidecar).read_text("utf-8")) if args.sidecar else {}
    region = None  # 核心区（逐人仿真范围）矩形，米；None = 全图
    if side.get("activeRegion"):
        (rx0, ry0), (rx1, ry1) = to_m(side["activeRegion"][:2]), to_m(side["activeRegion"][2:])  # [x0, y0, x1, y1] 像素
        region = Polygon([(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)])
    in_region = (lambda g_: region is None or region.intersects(g_))
    # 场馆信息按 at 坐标就近挂到某栋 venue 建筑上（图上只画了色块，名字 / 类型 / 容量画不出来）
    for v in side.get("venues", []):
        cands = [b for b in buildings if b["kind"] == "venue"]
        if cands:
            pt = Point(*to_m(v["at"]))
            best_b = min(cands, key=lambda b: b["geom"].distance(pt))
            best_b["venue"] = {k_: v[k_] for k_ in ("name", "type", "capacity") if k_ in v}
    # 逐栋楼的层数（sat2marks 用影子估出来的，或者用户手填的）: at 点落在哪栋楼里（容差 3m）就改那栋。
    # 几个点落进同一栋（挨着的楼在标记图上连成了一块）时取最高的，免得一栋高楼被旁边的矮楼拉低
    got_floors = {}  # 楼 id → 层数
    for a in side.get("buildings", []):  # 每条记录: {at: [x, y] 像素, floors}
        if not a.get("floors"):
            continue  # 没有层数的记录跳过
        pt = Point(*to_m(a["at"]))  # 像素 → 米
        hit = [b for b in buildings if b["geom"].distance(pt) <= 3.0]  # 点在楼里或 3m 内（轮廓直角化后边缘会挪一点）
        if hit:
            b = min(hit, key=lambda b_: b_["geom"].distance(pt))  # 离得最近的那栋（在楼里时距离为 0）
            got_floors[b["id"]] = max(got_floors.get(b["id"], 0), int(max(1, round(a["floors"]))))
    for b in buildings:  # 写回
        if b["id"] in got_floors:
            b["floors"] = got_floors[b["id"]]
    if side.get("buildings"):
        log(f"sidecar 层数: {len(got_floors)} 栋楼（共 {len(side['buildings'])} 条记录）")
    # 细长比上限: 楼高不超过最窄边的 8 倍（真实高层住宅的高宽比很少超过 6~7）。
    # 防的是识别出来的碎片 / 窄条被给了很高的层数，变成一根铅笔立在那里；层高按 3m 算
    capped = 0  # 被压低的栋数，写日志
    for b in buildings:
        if b["kind"] not in ("block", "residential"):
            continue  # 商铺本来就低、场馆是异形，不管
        rr = b["geom"].minimum_rotated_rectangle  # 最小外接矩形
        xs_, ys_ = rr.exterior.coords.xy  # 四个角（首尾重复）
        short = min(math.hypot(xs_[1] - xs_[0], ys_[1] - ys_[0]), math.hypot(xs_[2] - xs_[1], ys_[2] - ys_[1]))  # 最小外接矩形的短边（米）
        lim = max(2, int(8 * short / 3.0))  # 层数上限，至少 2 层
        if b["floors"] > lim:
            b["floors"] = lim
            capped += 1
    if capped:
        log(f"细长比上限: {capped} 栋楼的层数被压低（楼高 ≤ 8 × 最窄边）")
    # 轨道交通: 线路折线 + 车站，原样透传（只换坐标单位），前端自己画轨道 / 跑车
    transit = None
    if side.get("transit"):
        transit = {"lines": []}
        for ln in side["transit"]["lines"]:
            transit["lines"].append({**{k_: ln[k_] for k_ in ("id", "name", "kind", "color") if k_ in ln}, "loop": bool(ln.get("loop")),
                                     "points": [[round(float(v_), 2) for v_ in to_m(q)] for q in ln["points"]],
                                     "stations": [{"name": st["name"], "pos": [round(float(v_), 2) for v_ in to_m(st["at"])]} for st in ln.get("stations", [])]})
        log(f"轨道交通 {len(transit['lines'])} 条线, {sum(len(l['stations']) for l in transit['lines'])} 个车站")

    # ---------------- 店门 ----------------
    doors = []

    def edge_normal_outward(poly, a, b):
        """边 a→b 的单位法线，朝建筑外侧"""
        d = np.array(b) - np.array(a)
        n = np.array([d[1], -d[0]]) / max(np.hypot(*d), 1e-9)  # 先任取一侧的垂线
        mid = (np.array(a) + np.array(b)) / 2
        if poly.contains(Point(*(mid + n * 0.4))):  # 沿法线走 0.4m 还在楼里 → 取反；不依赖顶点绕向
            n = -n
        return n

    def snap_door(p_m):
        """手工点的门吸附到最近建筑的外墙上（15m 内），返回 {building, pos, normal}"""
        pt = Point(*p_m)
        best = min(buildings, key=lambda b: b["geom"].exterior.distance(pt))
        if best["geom"].exterior.distance(pt) > 15:  # 点得太远（15m 外）多半是误标，忽略
            return None
        ext = best["geom"].exterior
        s = ext.project(pt)  # 点在外墙环上的投影弧长
        q = np.array(ext.interpolate(s).coords[0])  # 门的位置 = 投影点
        q2 = np.array(ext.interpolate((s + 0.2) % ext.length).coords[0])  # 前后各 0.2m 取两点定墙的方向，% 处理绕回起点
        q1 = np.array(ext.interpolate((s - 0.2) % ext.length).coords[0])
        n = edge_normal_outward(best["geom"], q1, q2)
        return dict(building=best["id"], pos=q, normal=n)

    for p in door_px:
        d = snap_door(to_m(p))
        if d:
            doors.append(d)
        else:
            log(f"警告: 店门标记 {p.round()} 离任何建筑都超过 15m，已忽略")
    # 没手工标门的楼自动布门: 场馆沿周长每 30m、写字楼 / 住宅最长的一两条临街边、商铺每条临街边按间距布
    marked = {d["building"] for d in doors}
    auto_n = 0
    for b in buildings:
        if b["id"] in marked or not in_region(b["geom"]):
            continue  # 核心区以外不逐人仿真，不需要门
        if b["kind"] == "venue":  # 场馆: 沿周长每 30m 一个出入口（椭圆轮廓的边都很短，不能按边来布）
            ext = b["geom"].exterior
            for j in range(max(4, int(ext.length // 30))):  # 至少 4 个出入口
                s_ = ext.length * (j + 0.5) / max(4, int(ext.length // 30))  # 等分周长，取每段中点
                q, q1, q2 = (np.array(ext.interpolate(v_ % ext.length).coords[0]) for v_ in (s_, s_ - 0.5, s_ + 0.5))
                n = edge_normal_outward(b["geom"], q1, q2)
                if walk_prep.contains(Point(*(q + n * 3.0))):  # 门外 3m 必须可走（不是贴着路 / 水 / 别的楼）
                    doors.append(dict(building=b["id"], pos=q, normal=n))
                    auto_n += 1
            continue
        if b["kind"] != "shop":  # 写字楼 / 住宅: 最长的一两条临街边各开一个门
            co = np.asarray(b["geom"].exterior.coords)
            edges_ = sorted(zip(co[:-1], co[1:]), key=lambda e_: -float(np.hypot(*(e_[1] - e_[0]))))  # 按边长降序
            made = 0
            for a, c in edges_:
                if made >= 2 or float(np.hypot(*(c - a))) < 8:  # 最多 2 个门；8m 以下的边开不了大门
                    break
                n = edge_normal_outward(b["geom"], a, c)
                if walk_prep.contains(Point(*((a + c) / 2 + n * 2.5))):  # 门外 2.5m 可走 = 这条边临街
                    doors.append(dict(building=b["id"], pos=(a + c) / 2, normal=n))
                    auto_n += 1
                    made += 1
            continue
        # 商铺: 每条临街边按 --door-spacing-m 均匀开门，一条边上一排小店
        co = np.asarray(b["geom"].exterior.coords)
        for a, c in zip(co[:-1], co[1:]):
            L = float(np.hypot(*(c - a)))
            if L < 6:  # 6m 以下的边（直角化留下的短边、转角）不开门
                continue
            n = edge_normal_outward(b["geom"], a, c)
            mid = (a + c) / 2
            if not walk_prep.contains(Point(*(mid + n * 2.5))):
                continue
            k = max(1, int(round(L / args.door_spacing_m)))  # 门数 = 边长 / 间距，四舍五入，至少 1 个
            for j in range(k):
                doors.append(dict(building=b["id"], pos=a + (c - a) * ((j + 0.5) / k), normal=n))  # 等分后取每段中点
                auto_n += 1
    log(f"店门 {len(doors)} 个（手工标记 {len(doors) - auto_n}，自动 {auto_n}）")

    # ---------------- 人流出入口 ----------------
    # 手工点吸附到可走区域；有核心区时沿核心区边界每 45m 一个（权重 0.5）；什么都没有就在地块四周放 8 个
    # weight 是前端生成行人时按权重抽样的概率: 手工点 1.0，核心区边界自动点 0.5（数量多，单个权重低一些）
    portals = []
    for p in portal_px:
        q = to_m(p)
        if not walk_prep.contains(Point(*q)):  # 点到楼里 / 路上了: 挪到可走区域最近的点
            q = np.array(nearest_points(walk_free, Point(*q))[0].coords[0])
        portals.append(dict(pos=q, weight=1.0))
    if region is not None:
        ring_ = region.exterior
        for j in range(int(ring_.length // 45)):  # 沿核心区边界每 45m 一个
            q = np.array(ring_.interpolate(j * 45.0).coords[0])
            c_ = np.array(region.centroid.coords[0])
            q_in = q + (c_ - q) / max(np.hypot(*(c_ - q)), 1e-9) * 4.0  # 朝核心区中心内移 4m，保证落在区内
            if walk_prep.contains(Point(*q_in)):  # 边界上落在路 / 楼里的位置跳过
                portals.append(dict(pos=q_in, weight=0.5))
    if not portals and not walk_free.is_empty:
        minx, miny, maxx, maxy = site.bounds
        mx, my = (minx + maxx) / 2, (miny + maxy) / 2
        # 地块包围盒的四角 + 四边中点，各自吸到最近的可走点
        for tx, ty in [(minx, miny), (mx, miny), (maxx, miny), (maxx, my), (maxx, maxy), (mx, maxy), (minx, maxy), (minx, my)]:
            q = np.array(nearest_points(walk_free, Point(tx, ty))[0].coords[0])
            portals.append(dict(pos=q, weight=1.0))
        log("未标记出入口，已在地块四周自动放置 8 个")

    # ---------------- 输出 ----------------
    # 坐标统一保留 2 位小数（厘米），方向向量 4 位；version 变了前端要同步改加载逻辑
    r2 = lambda v: [round(float(v[0]), 2), round(float(v[1]), 2)]
    minx, miny, maxx, maxy = site.bounds
    scene = {
        "version": 4,
        "units": "m",
        "source": Path(args.image).name,
        "angle": round(g_ang, 5),
        "bounds": {"minX": round(minx, 2), "minY": round(miny, 2), "maxX": round(maxx, 2), "maxY": round(maxy, 2)},
        **({"activeRegion": dict(zip(("minX", "minY", "maxX", "maxY"), (round(v_, 2) for v_ in region.bounds)))} if region is not None else {}),
        **({"transit": transit} if transit else {}),
        # site: 地块范围；pavement: 人行铺装（地块 − 道路 − 下沉区域）；buildings 的 attraction 是行人目的地权重，默认 1.0
        "site": geom_to_json(site),
        "pavement": geom_to_json(pavement),
        "buildings": [
            {"id": b["id"], "kind": b["kind"], "floors": b["floors"], "angle": round(b["angle"], 5), "attraction": b.get("attraction", 1.0),
             **({"venue": b["venue"]} if b.get("venue") else {}),
             **({"name": b["name"]} if b.get("name") else {}), **({"shops": b["shops"]} if b.get("shops") else {}),
             **geom_to_json(b["geom"])[0]}
            for b in buildings if geom_to_json(b["geom"])
        ],
        "areas": [{"kind": k, **poly} for k, g_ in areas.items() for poly in geom_to_json(g_)],
        "roadGraph": road_graph,
        "elevated": geom_to_json(elevated),
        "lanes": [{"points": [r2(p) for p in l["points"]], "width": round(l["width"], 2),
                   **({"oneway": True} if l.get("oneway") else {}), **({"level": 1} if l.get("level") else {}),
                   **({"median": l["median"]} if l.get("median") else {}),
                   **({"laneCount": l["laneCount"]} if l.get("laneCount") else {})} for l in lanes],
        "crosswalks": [{"center": r2(c["center"]), "dir": [round(float(c["dir"][0]), 4), round(float(c["dir"][1]), 4)],
                        "span": round(c["span"], 2), "depth": c["depth"], "node": c.get("node"), "edge": c.get("edge")} for c in crosswalks],
        "doors": [{"building": d["building"], "pos": r2(d["pos"]), "normal": [round(float(d["normal"][0]), 4), round(float(d["normal"][1]), 4)]} for d in doors],
        "portals": [{"pos": r2(p["pos"]), "weight": p["weight"]} for p in portals],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), "utf-8")
    log(f"已写出 {out}  ({out.stat().st_size / 1024:.1f} KB)")

    if args.debug:
        write_debug(args.debug, img, scene, to_px)


def write_debug(path, img, scene, to_px):
    """
    把识别结果叠在灰化的原图上: 铺装、区域、高架、地块边界、车道线、斑马线、建筑、门、出入口、轨道线、核心区。

    直接从写出的 scene 字典画，所以预览看到的就是前端会拿到的数据，而不是中间变量。
    颜色是 BGR。半透明填充的做法: 复制一层、在副本上实心填充、再按比例混回去。
    Args:
        path:  预览图输出路径
        img:   原始标记图（BGR / BGRA / 灰度）
        scene: main 组装好的 scene 字典（米）
        to_px: 米 → 像素的换算函数
    """
    base = img[..., :3] if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    gray = cv2.cvtColor(cv2.cvtColor(base, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    vis = cv2.addWeighted(gray, 0.35, np.full_like(gray, 255), 0.65, 0)  # 原图灰化并提亮到 35%，让叠加的颜色突出
    P = lambda pts: to_px(pts).round().astype(np.int32).reshape(-1, 1, 2)  # 米制点列 → cv2 多边形格式
    for pv in scene["pavement"]:
        lay = vis.copy()
        cv2.fillPoly(lay, [P(pv["polygon"])] + [P(h) for h in pv["holes"]], (225, 235, 225))  # 外环和孔一起传，fillPoly 用奇偶规则留出孔
        vis = cv2.addWeighted(lay, 0.6, vis, 0.4, 0)
        cv2.polylines(vis, [P(pv["polygon"])] + [P(h) for h in pv["holes"]], True, (90, 160, 90), 1, cv2.LINE_AA)
    # 各类面状区域的填充色（BGR），描边用同色的 60% 亮度
    AREA_COL = {"green": (120, 200, 120), "park": (80, 160, 80), "water": (230, 170, 90), "plaza": (210, 180, 230), "parking": (200, 140, 170)}
    for a in scene.get("areas", []):
        lay = vis.copy()
        cv2.fillPoly(lay, [P(a["polygon"])] + [P(h) for h in a["holes"]], AREA_COL.get(a["kind"], (180, 180, 180)))
        vis = cv2.addWeighted(lay, 0.7, vis, 0.3, 0)
        cv2.polylines(vis, [P(a["polygon"])], True, tuple(int(c * 0.6) for c in AREA_COL.get(a["kind"], (180, 180, 180))), 2, cv2.LINE_AA)
    for e_ in scene.get("elevated", []):
        lay = vis.copy()
        cv2.fillPoly(lay, [P(e_["polygon"])] + [P(h) for h in e_["holes"]], (150, 90, 230))  # 环形高架是带孔的，孔要一起传进去才不会把环内涂满
        vis = cv2.addWeighted(lay, 0.45, vis, 0.55, 0)
    # 地块边界深灰描边；车道线橙色（含高架车道线，无高度区分），斑马线橙黄矩形
    for s in scene["site"]:
        cv2.polylines(vis, [P(s["polygon"])], True, (60, 60, 60), 2, cv2.LINE_AA)
    for l in scene["lanes"]:
        cv2.polylines(vis, [P(l["points"])], False, (200, 120, 0), 2, cv2.LINE_AA)
    for c in scene["crosswalks"]:
        # 斑马线是以 center 为中心、沿道路方向 dir 深 depth、横向 span 的矩形；画出四个角
        ctr, t = np.array(c["center"]), np.array(c["dir"])
        n = np.array([-t[1], t[0]])  # 法向 = 切向转 90°
        q = [ctr + t * c["depth"] / 2 + n * c["span"] / 2, ctr - t * c["depth"] / 2 + n * c["span"] / 2,
             ctr - t * c["depth"] / 2 - n * c["span"] / 2, ctr + t * c["depth"] / 2 - n * c["span"] / 2]
        cv2.polylines(vis, [P(q)], True, (0, 140, 255), 2, cv2.LINE_AA)
    for b in scene["buildings"]:
        col = (60, 60, 220) if b["kind"] == "shop" else (180, 60, 180)  # 商铺红、其他紫；顶点画黑点便于检查直角化结果
        lay = vis.copy()
        cv2.fillPoly(lay, [P(b["polygon"])], col)
        vis = cv2.addWeighted(lay, 0.35, vis, 0.65, 0)
        cv2.polylines(vis, [P(b["polygon"])] + [P(h) for h in b["holes"]], True, col, 2, cv2.LINE_AA)
        for v in P(b["polygon"]).reshape(-1, 2):
            cv2.circle(vis, tuple(int(x) for x in v), 3, (0, 0, 0), -1, cv2.LINE_AA)
    # 门画成「圆点 + 沿法线向外 3m 的短线」，一眼能看出法线方向是否朝外；出入口画空心圆
    for d in scene["doors"]:
        p = to_px(d["pos"])
        q = to_px(np.array(d["pos"]) + np.array(d["normal"]) * 3)
        cv2.line(vis, tuple(p.round().astype(int)), tuple(q.round().astype(int)), (0, 180, 230), 2, cv2.LINE_AA)
        cv2.circle(vis, tuple(p.round().astype(int)), 4, (0, 200, 255), -1, cv2.LINE_AA)
    for p in scene["portals"]:
        c = tuple(to_px(p["pos"]).round().astype(int))
        cv2.circle(vis, c, 8, (200, 180, 0), 2, cv2.LINE_AA)  # 青色空心圆，权重不区分
    for ln in (scene.get("transit") or {}).get("lines", []):
        col = tuple(int(ln["color"].lstrip("#")[i:i + 2], 16) for i in (4, 2, 0))  # 线路色 '#RRGGBB' → BGR，所以切片顺序倒过来
        cv2.polylines(vis, [P(ln["points"])], bool(ln.get("loop")), col, 4, cv2.LINE_AA)  # 环线闭合
        for st in ln["stations"]:
            c = tuple(to_px(st["pos"]).round().astype(int))
            cv2.circle(vis, c, 11, (255, 255, 255), -1, cv2.LINE_AA)
            cv2.circle(vis, c, 11, col, 3, cv2.LINE_AA)
    if scene.get("activeRegion"):
        r = scene["activeRegion"]
        cv2.rectangle(vis, tuple(to_px([r["minX"], r["minY"]]).round().astype(int)), tuple(to_px([r["maxX"], r["maxY"]]).round().astype(int)), (0, 0, 0), 3)
    imwrite_unicode(path, vis)
    log(f"预览图 {path}")


if __name__ == "__main__":
    main()
