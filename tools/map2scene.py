#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
map2scene.py —— 把「涂了色块标记的二维地图图片」转换成前端用的 scene.json

标记约定（默认调色板，可用 --markers 覆盖，见 markers.default.json）:
    红   #FF0000  商铺建筑（2 层）          —— 填充色块
    橙   #FF8000  商铺建筑（1 层）          —— 填充色块
    品红 #FF00FF  非商铺建筑/高楼（5 层）    —— 填充色块
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

DEFAULT_MARKERS = [
    {"color": "#FF0000", "layer": "building", "kind": "shop", "floors": 2},
    {"color": "#FF8000", "layer": "building", "kind": "shop", "floors": 1},
    {"color": "#FF00FF", "layer": "building", "kind": "block", "floors": 5},
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
def log(*a):
    print("[map2scene]", *a, file=sys.stderr)


def imread_unicode(path):
    """cv2.imread 在 Windows 上不支持中文路径，用 imdecode 绕开。"""
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"无法读取图片: {path}")
    return img


def imwrite_unicode(path, img):
    ok, buf = cv2.imencode(Path(path).suffix or ".png", img)
    if ok:
        buf.tofile(str(path))


def hex_to_rgb(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def classify(img, markers, tol, min_sat=70):
    """
    逐像素归类到最近的标记色（RGB 欧氏距离 < tol），返回类别索引图（-1 = 未标记）。
    标记色都是高饱和色，所以 max-min < min_sat 的像素（各种深浅的灰）直接判为未标记。
    """
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    alpha = img[..., 3] if img.shape[2] == 4 else None
    rgb = img[..., 2::-1].astype(np.int32)
    h, w = rgb.shape[:2]
    best = np.full((h, w), -1, np.int16)
    best_d = np.full((h, w), tol * tol, np.int32)
    for i, m in enumerate(markers):
        c = np.array(hex_to_rgb(m["color"]), np.int32)
        d = ((rgb - c) ** 2).sum(-1)
        hit = d < best_d
        best[hit] = i
        best_d[hit] = d[hit]
    if alpha is not None:
        best[alpha < 128] = -1
    best[(rgb.max(-1) - rgb.min(-1)) < min_sat] = -1
    return best


def clean_mask(mask, open_px=3, close_px=5):
    k1 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_px, open_px))
    k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_px, close_px))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k1)
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k2)


def mask_to_rings(mask, min_area_px):
    """返回 [(外环, [内环...])], 像素坐标 float ndarray(N,2)。"""
    cnts, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    out = []
    if hier is None:
        return out
    hier = hier[0]
    for i, c in enumerate(cnts):
        if hier[i][3] != -1 or cv2.contourArea(c) < min_area_px:
            continue
        holes = []
        j = hier[i][2]
        while j != -1:
            if cv2.contourArea(cnts[j]) >= min_area_px * 0.5:
                holes.append(cnts[j])
            j = hier[j][0]
        out.append((c, holes))
    return out


def simplify_ring(cnt, eps):
    a = cv2.approxPolyDP(cnt, eps, True).reshape(-1, 2).astype(np.float64)
    return a if len(a) >= 3 else None


# ----------------------------------------------------------------------------
# 建筑轮廓直角化
# ----------------------------------------------------------------------------
def dominant_angle(rings):
    """边长加权的主方向（弧度，(-45°,45°]），利用 4θ 折叠消除 90° 歧义。"""
    s = c = 0.0
    for p in rings:
        e = np.roll(p, -1, 0) - p
        L = np.hypot(e[:, 0], e[:, 1])
        th = np.arctan2(e[:, 1], e[:, 0])
        s += float((L * np.sin(4 * th)).sum())
        c += float((L * np.cos(4 * th)).sum())
    return math.atan2(s, c) / 4.0


def ang_diff90(a, b):
    d = (a - b) % (math.pi / 2)
    return min(d, math.pi / 2 - d)


def _line_intersect(p1, d1, p2, d2):
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
    """
    ca, sa = math.cos(-ang), math.sin(-ang)
    R = np.array([[ca, -sa], [sa, ca]])
    P = pts @ R.T
    n = len(P)

    edges = []  # dict(t='H'|'V'|'F', c, L, a, b)
    for i in range(n):
        a, b = P[i], P[(i + 1) % n]
        d = b - a
        L = float(np.hypot(*d))
        if L < 1e-6:
            continue
        th = math.degrees(math.atan2(d[1], d[0]))
        dev = ((th + 45.0) % 90.0) - 45.0
        if abs(dev) <= snap_deg:
            if abs(d[0]) >= abs(d[1]):
                edges.append(dict(t="H", c=(a[1] + b[1]) / 2, L=L, a=a, b=b))
            else:
                edges.append(dict(t="V", c=(a[0] + b[0]) / 2, L=L, a=a, b=b))
        else:
            edges.append(dict(t="F", c=None, L=L, a=a, b=b))

    def merge_pass(es):
        changed = True
        while changed and len(es) > 3:
            changed = False
            # 1) 抹掉夹在两条同类边之间的一小串短边（台阶、缺口）
            m = len(es)
            for i in range(m):
                p = es[i]
                if p["t"] == "F":
                    continue
                for run in (1, 2, 3):
                    if run + 2 > m:
                        break
                    mids = [es[(i + 1 + r) % m] for r in range(run)]
                    q = es[(i + 1 + run) % m]
                    if q["t"] != p["t"] or q is p or abs(q["c"] - p["c"]) > jog_tol:
                        continue
                    if all(e["L"] < jog_tol * 1.5 for e in mids) and sum(e["L"] for e in mids) < jog_tol * 3:
                        for e in mids:
                            es.remove(e)
                        changed = True
                        break
                if changed:
                    break
            if changed:
                continue
            # 2) 合并相邻同类边；错位过大时补一条垂直连接边
            for i, e in enumerate(es):
                q = es[(i + 1) % len(es)]
                if e is q or e["t"] == "F" or e["t"] != q["t"]:
                    continue
                if abs(e["c"] - q["c"]) <= jog_tol:
                    tot = e["L"] + q["L"]
                    e["c"] = (e["c"] * e["L"] + q["c"] * q["L"]) / tot
                    e["L"] = tot
                    e["b"] = q["b"]
                    es.remove(q)
                else:
                    j = e["b"]
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
        if e["t"] == "H":
            return np.array([0.0, e["c"]]), np.array([1.0, 0.0])
        if e["t"] == "V":
            return np.array([e["c"], 0.0]), np.array([0.0, 1.0])
        return e["a"], e["b"] - e["a"]

    out = []
    m = len(edges)
    for i in range(m):
        e, q = edges[i], edges[(i + 1) % m]
        x = _line_intersect(*as_line(e), *as_line(q))
        if x is None or np.hypot(*(x - e["b"])) > max(6.0, 4 * jog_tol):
            x = np.array(e["b"], dtype=np.float64)
        out.append(x)
    out = np.array(out)
    return out @ R  # 逆旋转（R 为正交阵）


def ortho_building(poly_m, holes_m, ang, enable):
    """直角化并校验，失败则回退到简化后的原轮廓。"""
    src = Polygon(poly_m, holes_m)
    if not src.is_valid:
        src = src.buffer(0)
        if isinstance(src, MultiPolygon):
            src = max(src.geoms, key=lambda g: g.area)
    if not enable:
        return src
    shell = orthogonalize(np.asarray(src.exterior.coords)[:-1], ang)
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
        diff = cand.symmetric_difference(src).area / src.area
        if diff > 0.18:
            return src
        clean = cand.simplify(0.05, preserve_topology=True)
        return clean if clean.is_valid and isinstance(clean, Polygon) else cand
    except Exception:
        return src


# ----------------------------------------------------------------------------
# 道路骨架 → 中心线图
# ----------------------------------------------------------------------------
N8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def skeletonize_mask(mask):
    try:
        from skimage.morphology import skeletonize
        return skeletonize(mask > 0)
    except ImportError:
        if hasattr(cv2, "ximgproc"):
            return cv2.ximgproc.thinning(mask) > 0
        log("警告: 未安装 scikit-image，跳过道路中心线/斑马线生成 (pip install scikit-image)")
        return None


def skeleton_graph(sk):
    """骨架像素 → 图。返回 nodes{id:(x,y)}, edges[[a,b,pts(N,2 xy)]]"""
    H, W = sk.shape
    skp = np.pad(sk, 1).astype(np.uint8)
    nb = np.zeros_like(skp, dtype=np.int32)
    for dy, dx in N8:
        nb += np.roll(np.roll(skp, dy, 0), dx, 1)
    nb *= skp
    is_node = (skp > 0) & (nb != 2) & (nb > 0)

    # 相邻的节点像素聚成一个节点
    ncomp, lab = cv2.connectedComponents(is_node.astype(np.uint8), connectivity=8)
    nodes = {}
    for k in range(1, ncomp):
        ys, xs = np.nonzero(lab == k)
        nodes[k] = (float(xs.mean()) - 1, float(ys.mean()) - 1)

    visited = np.zeros_like(skp, dtype=bool)
    edges = []
    direct = set()

    def walk(start_id, y0, x0, y1, x1):
        path = [(x0 - 1, y0 - 1), (x1 - 1, y1 - 1)]
        py, px, cy, cx = y0, x0, y1, x1
        while True:
            visited[cy, cx] = True
            nxt = None
            end_id = None
            for dy, dx in N8:
                yy, xx = cy + dy, cx + dx
                if not skp[yy, xx] or (yy == py and xx == px):
                    continue
                if lab[yy, xx]:
                    if lab[yy, xx] != start_id or len(path) > 4:
                        end_id = lab[yy, xx]
                        break
                    continue
                if not visited[yy, xx]:
                    nxt = (yy, xx)
            if end_id is not None:
                return end_id, path
            if nxt is None:
                return None, path
            py, px, cy, cx = cy, cx, nxt[0], nxt[1]
            path.append((cx - 1, cy - 1))

    ys, xs = np.nonzero(is_node)
    for y, x in zip(ys, xs):
        sid = lab[y, x]
        for dy, dx in N8:
            yy, xx = y + dy, x + dx
            if not skp[yy, xx]:
                continue
            if lab[yy, xx]:
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
            pts = [nodes[sid]] + path[1:] + [nodes[eid]]
            edges.append([sid, eid, np.array(pts, dtype=np.float64)])

    # 没有任何节点的纯环路
    rest = (skp > 0) & ~visited & ~is_node
    nid = max(nodes.keys(), default=0) + 1
    while rest.any():
        y, x = map(int, np.argwhere(rest)[0])
        path = [(x - 1, y - 1)]
        rest[y, x] = False
        cy, cx = y, x
        while True:
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
        if len(path) > 10:
            nodes[nid] = (float(path[0][0]), float(path[0][1]))
            edges.append([nid, nid, np.array(path + [path[0]], dtype=np.float64)])
            nid += 1
    return nodes, edges


def poly_len(pts):
    return float(np.hypot(*np.diff(pts, axis=0).T).sum()) if len(pts) > 1 else 0.0


def prune_and_merge(nodes, edges, dt):
    """剪掉骨架毛刺，再把度为 2 的节点两侧的边拼起来。"""
    def width_of(pts):
        ix = np.clip(pts[:, 0].round().astype(int), 0, dt.shape[1] - 1)
        iy = np.clip(pts[:, 1].round().astype(int), 0, dt.shape[0] - 1)
        return 2.0 * float(np.median(dt[iy, ix]))

    def max_width_of(pts):
        ix = np.clip(pts[:, 0].round().astype(int), 0, dt.shape[1] - 1)
        iy = np.clip(pts[:, 1].round().astype(int), 0, dt.shape[0] - 1)
        return 2.0 * float(dt[iy, ix].max())

    while True:
        deg = {}
        for a, b, _ in edges:
            deg[a] = deg.get(a, 0) + 1
            deg[b] = deg.get(b, 0) + 1
        # 毛刺: 一端悬空、另一端是路口，且长度 < 1.2 倍路宽。一轮里全部剪掉
        spurs = [e for e in edges if e[0] != e[1]
                 and ((deg[e[0]] == 1 and deg[e[1]] >= 3) or (deg[e[1]] == 1 and deg[e[0]] >= 3))
                 and poly_len(e[2]) < 1.2 * max_width_of(e[2])]
        if spurs:
            for e in spurs:
                edges.remove(e)
            continue
        # 拼接度为 2 的节点
        merged = False
        for n, d in deg.items():
            if d != 2:
                continue
            inc = [e for e in edges if e[0] == n or e[1] == n]
            if len(inc) != 2 or inc[0] is inc[1]:
                continue
            e1, e2 = inc
            if e1[0] == e1[1] or e2[0] == e2[1]:
                continue
            p1 = e1[2] if e1[1] == n else e1[2][::-1]
            a = e1[0] if e1[1] == n else e1[1]
            p2 = e2[2] if e2[0] == n else e2[2][::-1]
            b = e2[1] if e2[0] == n else e2[0]
            edges.remove(e1)
            edges.remove(e2)
            edges.append([a, b, np.vstack([p1, p2[1:]])])
            merged = True
            break
        if not merged:
            break
    deg = {}
    for a, b, _ in edges:
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1
    return edges, deg, width_of


def point_at(pts, s):
    """折线上弧长 s 处的点与切向。"""
    seg = np.diff(pts, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    acc = 0.0
    for i, l in enumerate(L):
        if l < 1e-9:
            continue
        if acc + l >= s:
            t = (s - acc) / l
            return pts[i] + seg[i] * t, seg[i] / l
        acc += l
    k = len(L) - 1
    while k > 0 and L[k] < 1e-9:
        k -= 1
    return pts[-1].copy(), seg[k] / max(L[k], 1e-9)


def cut_polyline(pts, s0, s1):
    """截取弧长 [s0, s1] 之间的子折线。"""
    out = [point_at(pts, s0)[0]]
    seg = np.diff(pts, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    acc = 0.0
    for i, l in enumerate(L):
        acc += l
        if s0 < acc < s1:
            out.append(pts[i + 1])
    out.append(point_at(pts, s1)[0])
    return np.array(out)


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------
def geom_to_json(g, nd=2):
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
    ap.add_argument("--debug", help="输出叠加了识别结果的预览图")
    args = ap.parse_args()

    markers = json.loads(Path(args.markers).read_text("utf-8")) if args.markers else DEFAULT_MARKERS
    img = imread_unicode(args.image)
    H, W = img.shape[:2]
    mpp = args.mpp or ((args.width_m or 300.0) / W)
    log(f"图片 {W}x{H}px, 比例 {mpp:.4f} m/px → {W * mpp:.0f}x{H * mpp:.0f} m")

    cls = classify(img, markers, args.tol, args.min_sat)
    px = lambda m_: max(1, int(round(m_ / mpp)))  # 米 → 像素

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
        pts = []
        for i in idx_list:
            n, _, stats, cent = cv2.connectedComponentsWithStats(layer_mask[i], connectivity=8)
            for k in range(1, n):
                if stats[k, cv2.CC_STAT_AREA] >= 4:
                    pts.append(cent[k])
        return pts

    door_px = dots(door_idx)
    portal_px = dots(portal_idx)
    # 圆点盖住的像素要还给它所在的面状图层（否则建筑边上会缺一口）:
    # 只在圆点范围内取「该图层闭运算」的结果 —— 压在边线上的点补平缺口而不鼓包，落在内部的点补上洞
    dot_mask = np.zeros((H, W), np.uint8)
    dot_size = 0
    for i in door_idx + portal_idx:
        dot_mask |= layer_mask[i]
        n, _, stats, _ = cv2.connectedComponentsWithStats(layer_mask[i], connectivity=8)
        if n > 1:
            dot_size = max(dot_size, int(stats[1:, cv2.CC_STAT_WIDTH].max()), int(stats[1:, cv2.CC_STAT_HEIGHT].max()))
    dot_size = min(dot_size, px(8))
    if dot_size:
        dot_mask = cv2.dilate(dot_mask, np.ones((7, 7), np.uint8))
        dot_k = cv2.getStructuringElement(cv2.MORPH_RECT, (dot_size + 11, dot_size + 11))

    def area_mask(i):
        m = clean_mask(layer_mask[i], 3, max(3, px(0.8) | 1))  # 先去噪点，否则闭运算会把碎点连成片
        if dot_size:
            m = m | (cv2.morphologyEx(m, cv2.MORPH_CLOSE, dot_k) & dot_mask)
        return m

    cx, cy = W / 2.0, H / 2.0
    to_m = lambda p: (np.asarray(p, dtype=np.float64) - [cx, cy]) * mpp
    to_px = lambda p: np.asarray(p, dtype=np.float64) / mpp + [cx, cy]

    # ---------------- 建筑 ----------------
    raw = []  # (marker, shell_m, holes_m)
    bmask_all = np.zeros((H, W), np.uint8)
    for i in bld_idx:
        m = area_mask(i)
        bmask_all |= m
        for shell, holes in mask_to_rings(m, px(4) ** 2):
            s = simplify_ring(shell, max(1.0, args.simplify_m / mpp))
            if s is None:
                continue
            hs = [h for h in (simplify_ring(h, max(1.0, args.simplify_m / mpp)) for h in holes) if h is not None]
            raw.append((markers[i], to_m(s), [to_m(h) for h in hs]))
    if not raw:
        log("警告: 没有识别到任何建筑色块（检查标记颜色，或调大 --tol）")

    g_ang = dominant_angle([r[1] for r in raw]) if raw else 0.0
    log(f"建筑 {len(raw)} 栋, 全局主方向 {math.degrees(g_ang):.1f}°")

    buildings = []
    for k, (mk, shell, holes) in enumerate(raw):
        ang = dominant_angle([shell])
        if ang_diff90(ang, g_ang) < math.radians(7):
            ang = g_ang
        poly = ortho_building(shell, holes, ang, not args.no_ortho)
        buildings.append(dict(id=f"b{k + 1}", kind=mk.get("kind", "shop"), floors=mk.get("floors", 2), angle=ang, geom=poly))
    b_union = unary_union([b["geom"] for b in buildings]) if buildings else Polygon()

    # ---------------- 道路 / 地块 / 人行铺装 ----------------
    rmask = np.zeros((H, W), np.uint8)
    for i in road_idx:
        rmask |= area_mask(i)
    rmask &= ~bmask_all

    # 高架是盖在地面道路上画的，会把下面的路「切断」: 用闭运算把被盖住的那一段补回来
    emask = np.zeros((H, W), np.uint8)
    for i in elev_idx:
        emask |= area_mask(i)
    emask &= ~bmask_all
    if emask.any() and rmask.any():
        ew = int(cv2.distanceTransform(emask, cv2.DIST_L2, 5).max() * 2)
        kk = int(ew * 1.4) | 1
        rmask |= cv2.morphologyEx(rmask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (kk, kk))) & emask
        # 两种标记色交界处的抗锯齿像素哪一类都不算，会在路面里留下细缝，骨架会因此碎成一堆 —— 在高架附近再闭一次封住
        near = cv2.dilate(emask, np.ones((9, 9), np.uint8))
        rmask |= cv2.morphologyEx(rmask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)) & near

    AREA_PRIORITY = ["water", "parking", "green", "park", "plaza"]
    area_masks = {}
    taken = bmask_all | rmask
    for kind in AREA_PRIORITY:
        m = np.zeros((H, W), np.uint8)
        for i in area_idx:
            if markers[i].get("kind") == kind:
                m |= area_mask(i)
        m &= ~taken
        if m.any():
            area_masks[kind] = clean_mask(m, max(3, px(1.0) | 1), 3)
            taken |= area_masks[kind]

    if args.site == "full":
        site_mask = np.full((H, W), 255, np.uint8)
    else:
        union = taken | emask
        kk = px(40) | 1
        scale = max(1, kk // 41)  # 大核闭运算很慢，降采样做
        small = cv2.resize(union, (W // scale, H // scale), interpolation=cv2.INTER_NEAREST)
        ks = max(3, (kk // scale) | 1)
        small = cv2.copyMakeBorder(small, ks, ks, ks, ks, cv2.BORDER_CONSTANT, value=0)
        small = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks)))
        small = small[ks:-ks, ks:-ks]
        closed = cv2.resize(small, (W, H), interpolation=cv2.INTER_NEAREST) | union
        cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        site_mask = np.zeros((H, W), np.uint8)
        cv2.drawContours(site_mask, cnts, -1, 255, -1)
        mg = px(args.site_margin_m)
        if mg > 0:
            site_mask = cv2.dilate(site_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * mg + 1, 2 * mg + 1)))

    def mask_to_geom(mask, simp):
        polys = []
        for shell, holes in mask_to_rings(mask, px(3) ** 2):
            p = Polygon(to_m(shell.reshape(-1, 2)), [to_m(h.reshape(-1, 2)) for h in holes if len(h) >= 3])
            p = p.buffer(0)
            if not p.is_empty:
                polys.append(p)
        return unary_union(polys).simplify(simp, preserve_topology=True) if polys else Polygon()

    site = mask_to_geom(site_mask, 1.0)
    roads = mask_to_geom(rmask, 0.8)
    # 圆角: 先开后闭
    site = site.buffer(-5, join_style=1).buffer(5, join_style=1)
    roads = roads.buffer(1.0, join_style=1).buffer(-1.0, join_style=1)
    # 面状区域: 轮廓稍作平滑；绿地/水体本来就是自然形状，圆一点更好看
    areas = {}
    for kind, m in area_masks.items():
        g_ = mask_to_geom(m, 0.6)
        r_ = 1.5 if kind in ("green", "park", "water") else 0.8
        g_ = g_.buffer(r_, join_style=1).buffer(-2 * r_, join_style=1).buffer(r_, join_style=1)
        g_ = g_.difference(roads.buffer(0.2)).difference(b_union.buffer(0.2)) if kind != "plaza" else g_.difference(roads.buffer(0.2))
        g_ = g_.simplify(0.2, preserve_topology=True)
        if not g_.is_empty:
            areas[kind] = g_
    empty = Polygon()
    # 水体和停车场在路面标高（从人行铺装里挖掉），绿化/公园/广场盖在铺装上面
    sunk = unary_union([areas.get("water", empty), areas.get("parking", empty)])
    pavement = site.difference(roads).difference(sunk)
    pavement = pavement.buffer(-2.5, join_style=1).buffer(2.5, join_style=1)  # 路口处人行道转角变圆
    pavement = pavement.simplify(0.15, preserve_topology=True)
    site = site.simplify(0.15, preserve_topology=True)
    blocked = unary_union([b_union.buffer(0.3), areas.get("green", empty), areas.get("water", empty)])
    walk_free = unary_union([pavement, areas.get("parking", empty)]).difference(blocked)
    walk_prep = prep(walk_free)
    if areas:
        log("面状区域: " + ", ".join(f"{k} {v.area:.0f}㎡" for k, v in areas.items()))

    # ---------------- 环岛检测 ----------------
    islands = []  # (中心 px, 内半径 px, 轮廓)
    if rmask.any():
        cnts, hier = cv2.findContours(rmask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        for i, c in enumerate(cnts):
            if hier[0][i][3] == -1:
                continue
            area = cv2.contourArea(c)
            peri = cv2.arcLength(c, True)
            if not (math.pi * px(3) ** 2 < area < math.pi * px(28) ** 2) or 4 * math.pi * area / max(peri * peri, 1) < 0.72:
                continue
            m_ = cv2.moments(c)
            ctr = np.array([m_["m10"] / m_["m00"], m_["m01"] / m_["m00"]])
            hole = np.zeros((H, W), np.uint8)
            cv2.drawContours(hole, [c], -1, 255, -1)
            if (hole & bmask_all).sum() > 0.2 * hole.sum():
                continue
            islands.append((ctr, math.sqrt(area / math.pi), c))
        if islands:
            log(f"环岛 {len(islands)} 个")

    # ---------------- 道路中心线 / 斑马线 ----------------
    lanes, crosswalks = [], []
    road_graph = {"nodes": {}, "edges": []}
    sk = skeletonize_mask(rmask) if rmask.any() else None
    if sk is not None and sk.any():
        dt = cv2.distanceTransform(rmask, cv2.DIST_L2, 5)
        nodes, edges = skeleton_graph(sk)
        edges, deg, width_of = prune_and_merge(nodes, edges, dt)
        CW_DEPTH, CORNER = 3.2, 2.5

        def ring_of(pts):
            """这条边是不是某个环岛的环道；是则返回行驶方向（+1 = 沿点序，-1 = 逆点序），环内一律逆时针（靠右行驶）"""
            for ctr, r_in, _ in islands:
                d = np.hypot(pts[:, 0] - ctr[0], pts[:, 1] - ctr[1])
                if d.min() > r_in * 0.7 and d.max() < r_in + px(18):
                    k = len(pts) // 2
                    a_, b_ = pts[max(0, k - 1)], pts[min(len(pts) - 1, k + 1)]
                    cross = (a_[0] - ctr[0]) * (b_[1] - a_[1]) - (a_[1] - ctr[1]) * (b_[0] - a_[0])
                    return 1 if cross < 0 else -1  # 图像坐标 y 向下: 叉积为负 = 屏幕上逆时针
            return 0

        # 路口沿某条路方向的范围 = 与它相交（不共线）的那些路的半宽，而不是它自己的半宽。
        # 窄支路接宽主干路时差别很大: 按自己路宽算，斑马线会画到主干路（甚至高架桥面）底下去。
        edge_w = [width_of(e[2]) * mpp for e in edges]

        def arm_dir(pts, at_start):
            q = pts if at_start else pts[::-1]
            k = min(len(q) - 1, 20)
            d = q[k] - q[0]
            return d / max(np.hypot(*d), 1e-9)

        incident = {}
        for ei, (a_, b_, pts_) in enumerate(edges):
            if a_ == b_:
                continue
            incident.setdefault(a_, []).append((ei, arm_dir(pts_, True)))
            incident.setdefault(b_, []).append((ei, arm_dir(pts_, False)))

        def box_extent(nid, ei):
            arms = incident.get(nid, [])
            me = next((d for i, d in arms if i == ei), None)
            others = [(i, d) for i, d in arms if i != ei]
            if me is None or not others:
                return edge_w[ei] / 2
            if len(others) >= 2:  # 去掉和自己最接近反向的那条（同一条路穿过路口的延续）
                cont = min(others, key=lambda t: float(np.dot(t[1], me)))
                if float(np.dot(cont[1], me)) < -0.7:
                    others = [t for t in others if t[0] != cont[0]]
            return max(edge_w[i] for i, _ in others) / 2

        # 桥下的路: 中心线大部分压在高架下面。桥面正下方是桥墩和隔离带，不走车，前端据此把车道排在桥面投影两侧
        deck_half = float(cv2.distanceTransform(emask, cv2.DIST_L2, 5).max()) * mpp if emask.any() else 0.0

        def under_deck(pts):
            if deck_half <= 0:
                return 0.0
            ix = np.clip(pts[:, 0].round().astype(int), 0, W - 1)
            iy = np.clip(pts[:, 1].round().astype(int), 0, H - 1)
            return round(deck_half, 2) if (emask[iy, ix] > 0).mean() > 0.6 else 0.0

        ring_nodes = set()
        for a, b, pts in edges:
            if ring_of(pts):
                ring_nodes.update((a, b))
        for ei, (a, b, pts) in enumerate(edges):
            w_m = edge_w[ei]
            oneway = ring_of(pts)
            median = under_deck(pts)
            sp = cv2.approxPolyDP(pts.astype(np.float32).reshape(-1, 1, 2), max(1.5, 0.8 / mpp), False).reshape(-1, 2).astype(np.float64)
            pm = to_m(sp)
            total = poly_len(pm)
            for nid in (a, b):
                nx_, ny_ = nodes[nid]
                rad = float(dt[min(H - 1, max(0, int(round(ny_)))), min(W - 1, max(0, int(round(nx_))))]) * mpp
                road_graph["nodes"][str(nid)] = {"pos": [round(float(v), 2) for v in to_m([nx_, ny_])], "radius": round(rad, 2), "degree": int(deg.get(nid, 0)),
                                                 **({"roundabout": True} if nid in ring_nodes else {})}
            road_graph["edges"].append({"a": str(a), "b": str(b), "width": round(w_m, 2), "points": [[round(float(x), 2), round(float(y), 2)] for x, y in pm],
                                        **({"oneway": oneway, "roundabout": True} if oneway else {}), **({"median": median} if median else {}),
                                        # ext: 路口沿这条路方向伸进来多深（两端各一个），车道据此截短；比用路口半径准，宽路接窄路时差很多
                                        "ext": [round(box_extent(a, ei), 2) if deg.get(a, 0) >= 3 else 0, round(box_extent(b, ei), 2) if deg.get(b, 0) >= 3 else 0]})
            if oneway:  # 环道: 不设斑马线，只画车道分隔线（点序调成行驶方向，前端按「行驶方向右侧」算偏移）
                if total > 8:
                    piece = cut_polyline(pm, 3.0, total - 3.0)
                    lanes.append(dict(points=piece if oneway == 1 else piece[::-1], width=w_m, oneway=True))
                continue
            trim = [0.0, 0.0]
            for end, nid in ((0, a), (1, b)):
                is_junction = deg.get(nid, 0) >= 3
                if is_junction:
                    d0 = box_extent(nid, ei) + CORNER + 0.5
                    if total > 2 * (d0 + CW_DEPTH) + 4:
                        s = d0 + CW_DEPTH / 2
                        c, t = point_at(pm, s if end == 0 else total - s)
                        # node/edge: 这条斑马线属于哪个路口的哪条路，前端据此挂红绿灯
                        crosswalks.append(dict(center=c, dir=t, span=w_m + 1.0, depth=CW_DEPTH, node=str(nid), edge=len(road_graph["edges"]) - 1))
                    trim[end] = d0 + CW_DEPTH + 1.5
                else:
                    trim[end] = 1.0
            usable = total - trim[0] - trim[1]
            if usable < 6:
                continue
            # 长路段中途补斑马线
            mids = []
            if args.crosswalk_spacing_m > 0 and usable > args.crosswalk_spacing_m * 1.6:
                k = int(usable // args.crosswalk_spacing_m)
                mids = []
                for j in range(k):
                    s0 = trim[0] + usable * (j + 1) / (k + 1)
                    for off in (0, 15, -15, 30, -30):  # 避开弯道: 前后 8m 切向基本一致才放
                        s = s0 + off
                        if s - 10 < trim[0] or s + 10 > total - trim[1]:
                            continue
                        t0, t1 = point_at(pm, s - 8)[1], point_at(pm, s + 8)[1]
                        if float(np.dot(t0, t1)) > 0.985:
                            mids.append(s)
                            break
                mids.sort()
                for s in mids:
                    c, t = point_at(pm, s)
                    crosswalks.append(dict(center=c, dir=t, span=w_m + 1.0, depth=CW_DEPTH))
            cuts = [trim[0]] + [v for s in mids for v in (s - CW_DEPTH / 2 - 1, s + CW_DEPTH / 2 + 1)] + [total - trim[1]]
            for j in range(0, len(cuts), 2):
                if cuts[j + 1] - cuts[j] > 5:
                    lanes.append(dict(points=cut_polyline(pm, cuts[j], cuts[j + 1]), width=w_m, median=median))
        log(f"道路中心线 {len(lanes)} 段, 斑马线 {len(crosswalks)} 处")

    # ---------------- 高架 ----------------
    elevated = Polygon()
    if emask.any():
        elevated = mask_to_geom(emask, 1.0).buffer(0.8, join_style=2).buffer(-0.8, join_style=2).simplify(0.6, preserve_topology=True)
        esk = skeletonize_mask(emask)
        if esk is not None and esk.any():
            edt = cv2.distanceTransform(emask, cv2.DIST_L2, 5)
            enodes, eedges = skeleton_graph(esk)
            eedges, edeg, ewidth = prune_and_merge(enodes, eedges, edt)
            for a, b, pts in eedges:
                w_m = ewidth(pts) * mpp
                sp = cv2.approxPolyDP(pts.astype(np.float32).reshape(-1, 1, 2), max(1.5, 0.8 / mpp), False).reshape(-1, 2).astype(np.float64)
                pm = to_m(sp)
                if poly_len(pm) < 20:
                    continue
                for nid in (a, b):
                    road_graph["nodes"][f"e{nid}"] = {"pos": [round(float(v), 2) for v in to_m(enodes[nid])], "radius": round(w_m / 2, 2), "degree": int(edeg.get(nid, 0)), "level": 1}
                road_graph["edges"].append({"a": f"e{a}", "b": f"e{b}", "width": round(w_m, 2), "level": 1, "points": [[round(float(x), 2), round(float(y), 2)] for x, y in pm]})
                lanes.append(dict(points=cut_polyline(pm, 1.0, poly_len(pm) - 1.0), width=w_m, level=1))
        log(f"高架 {elevated.area:.0f}㎡")

    # 环岛中心岛做成绿地
    if islands:
        isl = unary_union([Polygon(to_m(c.reshape(-1, 2))).buffer(0).simplify(0.4).buffer(-0.6, join_style=1) for _, _, c in islands])
        areas["green"] = unary_union([areas["green"], isl]) if "green" in areas else isl
        walk_free = walk_free.difference(isl)
        walk_prep = prep(walk_free)

    # ---------------- 店门 ----------------
    doors = []

    def edge_normal_outward(poly, a, b):
        d = np.array(b) - np.array(a)
        n = np.array([d[1], -d[0]]) / max(np.hypot(*d), 1e-9)
        mid = (np.array(a) + np.array(b)) / 2
        if poly.contains(Point(*(mid + n * 0.4))):
            n = -n
        return n

    def snap_door(p_m):
        pt = Point(*p_m)
        best = min(buildings, key=lambda b: b["geom"].exterior.distance(pt))
        if best["geom"].exterior.distance(pt) > 15:
            return None
        ext = best["geom"].exterior
        s = ext.project(pt)
        q = np.array(ext.interpolate(s).coords[0])
        q2 = np.array(ext.interpolate((s + 0.2) % ext.length).coords[0])
        q1 = np.array(ext.interpolate((s - 0.2) % ext.length).coords[0])
        n = edge_normal_outward(best["geom"], q1, q2)
        return dict(building=best["id"], pos=q, normal=n)

    for p in door_px:
        d = snap_door(to_m(p))
        if d:
            doors.append(d)
        else:
            log(f"警告: 店门标记 {p.round()} 离任何建筑都超过 15m，已忽略")
    marked = {d["building"] for d in doors}
    auto_n = 0
    for b in buildings:
        if b["kind"] != "shop" or b["id"] in marked:
            continue
        co = np.asarray(b["geom"].exterior.coords)
        for a, c in zip(co[:-1], co[1:]):
            L = float(np.hypot(*(c - a)))
            if L < 6:
                continue
            n = edge_normal_outward(b["geom"], a, c)
            mid = (a + c) / 2
            if not walk_prep.contains(Point(*(mid + n * 2.5))):
                continue
            k = max(1, int(round(L / args.door_spacing_m)))
            for j in range(k):
                doors.append(dict(building=b["id"], pos=a + (c - a) * ((j + 0.5) / k), normal=n))
                auto_n += 1
    log(f"店门 {len(doors)} 个（手工标记 {len(doors) - auto_n}，自动 {auto_n}）")

    # ---------------- 人流出入口 ----------------
    portals = []
    for p in portal_px:
        q = to_m(p)
        if not walk_prep.contains(Point(*q)):
            q = np.array(nearest_points(walk_free, Point(*q))[0].coords[0])
        portals.append(dict(pos=q, weight=1.0))
    if not portals and not walk_free.is_empty:
        minx, miny, maxx, maxy = site.bounds
        mx, my = (minx + maxx) / 2, (miny + maxy) / 2
        for tx, ty in [(minx, miny), (mx, miny), (maxx, miny), (maxx, my), (maxx, maxy), (mx, maxy), (minx, maxy), (minx, my)]:
            q = np.array(nearest_points(walk_free, Point(tx, ty))[0].coords[0])
            portals.append(dict(pos=q, weight=1.0))
        log("未标记出入口，已在地块四周自动放置 8 个")

    # ---------------- 输出 ----------------
    r2 = lambda v: [round(float(v[0]), 2), round(float(v[1]), 2)]
    minx, miny, maxx, maxy = site.bounds
    scene = {
        "version": 3,
        "units": "m",
        "source": Path(args.image).name,
        "angle": round(g_ang, 5),
        "bounds": {"minX": round(minx, 2), "minY": round(miny, 2), "maxX": round(maxx, 2), "maxY": round(maxy, 2)},
        "site": geom_to_json(site),
        "pavement": geom_to_json(pavement),
        "buildings": [
            {"id": b["id"], "kind": b["kind"], "floors": b["floors"], "angle": round(b["angle"], 5), "attraction": 1.0,
             **geom_to_json(b["geom"])[0]}
            for b in buildings if geom_to_json(b["geom"])
        ],
        "areas": [{"kind": k, **poly} for k, g_ in areas.items() for poly in geom_to_json(g_)],
        "roadGraph": road_graph,
        "elevated": geom_to_json(elevated),
        "lanes": [{"points": [r2(p) for p in l["points"]], "width": round(l["width"], 2),
                   **({"oneway": True} if l.get("oneway") else {}), **({"level": 1} if l.get("level") else {}),
                   **({"median": l["median"]} if l.get("median") else {})} for l in lanes],
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
    base = img[..., :3] if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    gray = cv2.cvtColor(cv2.cvtColor(base, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    vis = cv2.addWeighted(gray, 0.35, np.full_like(gray, 255), 0.65, 0)
    P = lambda pts: to_px(pts).round().astype(np.int32).reshape(-1, 1, 2)
    for pv in scene["pavement"]:
        lay = vis.copy()
        cv2.fillPoly(lay, [P(pv["polygon"])] + [P(h) for h in pv["holes"]], (225, 235, 225))
        vis = cv2.addWeighted(lay, 0.6, vis, 0.4, 0)
        cv2.polylines(vis, [P(pv["polygon"])] + [P(h) for h in pv["holes"]], True, (90, 160, 90), 1, cv2.LINE_AA)
    AREA_COL = {"green": (120, 200, 120), "park": (80, 160, 80), "water": (230, 170, 90), "plaza": (210, 180, 230), "parking": (200, 140, 170)}
    for a in scene.get("areas", []):
        lay = vis.copy()
        cv2.fillPoly(lay, [P(a["polygon"])] + [P(h) for h in a["holes"]], AREA_COL.get(a["kind"], (180, 180, 180)))
        vis = cv2.addWeighted(lay, 0.7, vis, 0.3, 0)
        cv2.polylines(vis, [P(a["polygon"])], True, tuple(int(c * 0.6) for c in AREA_COL.get(a["kind"], (180, 180, 180))), 2, cv2.LINE_AA)
    for e_ in scene.get("elevated", []):
        lay = vis.copy()
        cv2.fillPoly(lay, [P(e_["polygon"])], (150, 90, 230))
        vis = cv2.addWeighted(lay, 0.45, vis, 0.55, 0)
    for s in scene["site"]:
        cv2.polylines(vis, [P(s["polygon"])], True, (60, 60, 60), 2, cv2.LINE_AA)
    for l in scene["lanes"]:
        cv2.polylines(vis, [P(l["points"])], False, (200, 120, 0), 2, cv2.LINE_AA)
    for c in scene["crosswalks"]:
        ctr, t = np.array(c["center"]), np.array(c["dir"])
        n = np.array([-t[1], t[0]])
        q = [ctr + t * c["depth"] / 2 + n * c["span"] / 2, ctr - t * c["depth"] / 2 + n * c["span"] / 2,
             ctr - t * c["depth"] / 2 - n * c["span"] / 2, ctr + t * c["depth"] / 2 - n * c["span"] / 2]
        cv2.polylines(vis, [P(q)], True, (0, 140, 255), 2, cv2.LINE_AA)
    for b in scene["buildings"]:
        col = (60, 60, 220) if b["kind"] == "shop" else (180, 60, 180)
        lay = vis.copy()
        cv2.fillPoly(lay, [P(b["polygon"])], col)
        vis = cv2.addWeighted(lay, 0.35, vis, 0.65, 0)
        cv2.polylines(vis, [P(b["polygon"])] + [P(h) for h in b["holes"]], True, col, 2, cv2.LINE_AA)
        for v in P(b["polygon"]).reshape(-1, 2):
            cv2.circle(vis, tuple(int(x) for x in v), 3, (0, 0, 0), -1, cv2.LINE_AA)
    for d in scene["doors"]:
        p = to_px(d["pos"])
        q = to_px(np.array(d["pos"]) + np.array(d["normal"]) * 3)
        cv2.line(vis, tuple(p.round().astype(int)), tuple(q.round().astype(int)), (0, 180, 230), 2, cv2.LINE_AA)
        cv2.circle(vis, tuple(p.round().astype(int)), 4, (0, 200, 255), -1, cv2.LINE_AA)
    for p in scene["portals"]:
        c = tuple(to_px(p["pos"]).round().astype(int))
        cv2.circle(vis, c, 8, (200, 180, 0), 2, cv2.LINE_AA)
    imwrite_unicode(path, vis)
    log(f"预览图 {path}")


if __name__ == "__main__":
    main()
