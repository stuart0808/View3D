#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成「城区」示例: 2.4km x 1.7km，0.5 m/px。输出两个文件:
    district_marked.png   标记图（和街区示例同一套颜色约定）
    district.sidecar.json 标记图上画不了的东西: 地铁/铁路线路与车站、场馆信息、逐人仿真的核心区范围

内容: 格网主次干路；环形高架 + 横贯的高架快速路（下面是带桥下隔离带的主干路，匝道由前端自动生成）；
中央嵌入街区示例（make_demo_map.draw_demo 缩小 0.4 倍）；体育场、大剧院两个活动场馆；
其余地块按类型（住宅 / 写字楼 / 商业 / 公园）自动填充；一条斜向弯曲的高架铁路；三条地铁（南北线、东西线、环线）。

    python tools/make_district_map.py tools/samples
    python tools/map2scene.py tools/samples/district_marked.png --sidecar tools/samples/district.sidecar.json \\
        -o public/scenes/district.json --mpp 0.5 --debug tools/samples/district_preview.png
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_demo_map import (BLUE, ELEVATED, GREEN, MAGENTA, ORANGE, PARK, PARKING, PLAZA, RED, WATER, draw_demo)  # noqa: E402

RESIDENTIAL = (128, 255, 0)  # BGR of #00FF80
VENUE = (0, 255, 128)        # BGR of #80FF00

# 画布尺寸（像素）和比例尺；下面所有坐标都是像素
W, H, MPP = 4800, 3400, 0.5
CORE_S, CORE_X, CORE_Y = 0.4, 1800, 1260           # 街区示例的缩放和左上角
CORE_W, CORE_H = int(3000 * CORE_S), int(2200 * CORE_S)
RING = (900, 800, 3900, 2600)                       # 环形高架的中心线 x0,y0,x1,y1
ACTIVE = [1510, 810, 3290, 2150]                    # 逐人仿真的核心区（含体育场、大剧院）


def rounded_rect_path(x0, y0, x1, y1, r, n=10):
    """圆角矩形的闭合折线（顺时针，从右上角圆弧开始），每个圆角 n 段；环形高架 / 环线地铁共用"""
    pts = []
    for cx, cy, a0 in ((x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
        for k in range(n + 1):
            a = np.radians(a0 + 90 * k / n)
            pts.append([cx + r * np.cos(a), cy + r * np.sin(a)])
    return np.array(pts)


def smooth(points, rounds=4):
    """Chaikin 切角: 把几个控制点变成一条顺滑的曲线"""
    p = np.array(points, np.float64)
    for _ in range(rounds):
        q = [p[0]]
        for a, b in zip(p[:-1], p[1:]):
            q += [0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b]
        q.append(p[-1])
        p = np.array(q)
    return p


def main():
    """画标记图 + 写 sidecar。顺序: 道路 → 嵌入核心区 → 场馆 → 铁路走廊 → 自动填楼 → 高架（最后画，盖在路上）"""
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "tools/samples")
    rng = np.random.default_rng(11)
    img = np.full((H, W, 3), (232, 234, 236), np.uint8)

    def R(x, y, w, h, col):
        """填一个矩形"""
        cv2.rectangle(img, (int(x), int(y)), (int(x + w), int(y + h)), col, -1)

    # ------------------------------------------------------------------ 道路
    road = np.zeros((H, W), np.uint8)

    def road_rect(x, y, w, h):
        """画一段矩形道路，同时记进道路掩膜（后面退让人行道用）"""
        R(x, y, w, h, BLUE)
        cv2.rectangle(road, (int(x), int(y)), (int(x + w), int(y + h)), 255, -1)

    G0, GX1, GY1 = 330, 4470, 3070  # 格网道路的外框
    for x in (330, 1500, 3300, 4470):                       # 主干路 24m
        road_rect(x - 24, G0 - 24, 48, GY1 - G0 + 48)
    for y in (330, 3070):
        road_rect(G0 - 24, y - 24, GX1 - G0 + 48, 48)
    for x in (RING[0], RING[2]):                            # 环路下方的主干路 42m（中间 20m 在桥下）
        road_rect(x - 42, G0, 84, GY1 - G0)
    for y in (RING[1], RING[3]):
        road_rect(G0, y - 42, GX1 - G0, 84)
    art_y = CORE_Y + int(992 * CORE_S)                      # 横贯的主干路，和核心区里那条对齐
    road_rect(G0, art_y, CORE_X + 52 - G0, 86)
    road_rect(CORE_X + CORE_W - 52, art_y, GX1 - (CORE_X + CORE_W - 52), 86)
    for x in (615, 1200, 3600, 4185):                       # 次干路 10m
        road_rect(x - 10, G0, 20, GY1 - G0)
    for y in (565, 2835):
        road_rect(G0, y - 10, GX1 - G0, 20)
    for y in (1030, 2370):
        road_rect(G0, y - 10, 1500 - G0, 20)
        road_rect(3300, y - 10, GX1 - 3300, 20)
    # 核心区的街道向外接到格网上
    ax, bx, cx = CORE_X + 360, CORE_X + 680, CORE_X + 920
    road_rect(ax, RING[1], 19, CORE_Y + 60 - RING[1])
    road_rect(bx, RING[1], 32, CORE_Y + 60 - RING[1])
    for x, w in ((ax, 19), (bx, 32), (cx, 19)):
        road_rect(x, CORE_Y + CORE_H - 60, w, RING[3] - (CORE_Y + CORE_H - 60))
    road_rect(1500, CORE_Y + 248, CORE_X + 60 - 1500, 19)
    road_rect(CORE_X + CORE_W - 60, CORE_Y + 624, 3300 - (CORE_X + CORE_W - 60), 19)

    # ------------------------------------------------------------------ 核心区: 街区示例缩小后嵌进来
    sx = lambda v: int(round(CORE_X + v * CORE_S))
    sy = lambda v: int(round(CORE_Y + v * CORE_S))
    sl = lambda v: max(1, int(round(v * CORE_S)))
    draw_demo(
        R=lambda x, y, w, h, col: R(sx(x), sy(y), sl(w), sl(h), col),
        clear=lambda x, y, w, h: R(sx(x), sy(y), sl(w), sl(h), (232, 234, 236)),
        disc=lambda x, y, r, col, on=255: cv2.circle(img, (sx(x), sy(y)), max(3, sl(r)), col if on else (232, 234, 236), -1),
        ellipse=lambda x, y, rx, ry, ang, col: cv2.ellipse(img, (sx(x), sy(y)), (sl(rx), sl(ry)), ang, 0, 360, col, -1),
        elevated=False,
    )
    core_rect = (CORE_X + 20, CORE_Y + 20, CORE_X + CORE_W - 20, CORE_Y + CORE_H - 20)

    # ------------------------------------------------------------------ 场馆
    reserved = np.zeros((H, W), np.uint8)  # 场馆及其广场占的地，自动填楼时跳过
    # 体育场: 核心区正北的大地块
    R(2560, 862, 690, 392, PLAZA)
    cv2.ellipse(img, (2905, 1058), (285, 165), 0, 0, 360, VENUE, -1)
    cv2.rectangle(reserved, (2512, 842), (3276, 1300), 255, -1)
    # 大剧院: 核心区西侧，临水
    R(1545, 1300, 215, 190, PLAZA)
    cv2.ellipse(img, (1652, 1395), (88, 66), 0, 0, 360, VENUE, -1)
    R(1545, 1545, 215, 90, PARK)
    cv2.ellipse(img, (1652, 1590), (80, 28), 0, 0, 360, WATER, -1)
    cv2.rectangle(reserved, (1524, 1260), (1790, 1657), 255, -1)

    # ------------------------------------------------------------------ 铁路走廊（高架铁路下面留成绿廊，不盖楼）
    rail = smooth([(100, 180), (700, 480), (1400, 690), (2300, 715), (3100, 735), (3620, 920), (4050, 1500), (4330, 2300), (4700, 3260)])
    corridor = np.zeros((H, W), np.uint8)
    cv2.polylines(corridor, [rail.round().astype(np.int32).reshape(-1, 1, 2)], False, 255, 70)

    # ------------------------------------------------------------------ 其余地块自动填充
    # free = 还能盖楼的地: 格网内 − 道路（含退让）− 核心区 − 场馆 − 环路弯角下方 − 铁路走廊
    free = np.zeros((H, W), np.uint8)
    cv2.rectangle(free, (G0, G0), (GX1, GY1), 255, -1)
    free[cv2.dilate(road, np.ones((25, 25), np.uint8)) > 0] = 0                      # 退让人行道
    cv2.rectangle(free, core_rect[:2], core_rect[2:], 0, -1)
    free[reserved > 0] = 0
    ring_path = rounded_rect_path(*RING, 170)
    deck = np.zeros((H, W), np.uint8)
    cv2.polylines(deck, [ring_path.round().astype(np.int32).reshape(-1, 1, 2)], True, 255, 40)
    free[cv2.dilate(deck, np.ones((31, 31), np.uint8)) > 0] = 0                      # 环路弯角从街区上空切过，下面不盖楼
    green_under_rail = (corridor > 0) & (free > 0)
    img[green_under_rail] = GREEN
    free[corridor > 0] = 0

    n, lab, stats, cent = cv2.connectedComponentsWithStats(free, connectivity=4)
    used = np.zeros((H, W), np.uint8)

    def try_rect(block, x, y, w, h, col):
        """在地块 block 里放一栋矩形楼: 必须整个落在地块内、和已放的楼隔 6px 以上"""
        x, y, w, h = int(x), int(y), int(w), int(h)
        if x < 0 or y < 0 or x + w >= W or y + h >= H:
            return False
        if (lab[y:y + h, x:x + w] != block).any() or used[y - 6:y + h + 6, x - 6:x + w + 6].any():
            return False
        R(x, y, w, h, col)
        used[y:y + h, x:x + w] = 255
        return True

    # 每个地块按位置抽一种用途: 环路内以写字楼 / 商业为主，环路外以住宅为主；然后逐行逐个放楼
    inside_ring = lambda c: RING[0] < c[0] < RING[2] and RING[1] < c[1] < RING[3]
    for b in range(1, n):
        x0, y0, bw, bh, area = stats[b]
        if area < 6000:
            continue
        kind = rng.choice(["office", "commercial", "mixed", "park"], p=[0.4, 0.3, 0.22, 0.08]) if inside_ring(cent[b]) \
            else rng.choice(["residential", "residential", "commercial", "park", "mixed"], p=[0.42, 0.2, 0.14, 0.1, 0.14])
        # 核心区里留两个住宅小区（街区正北 A、B 两条街之间，和街区东侧的长条地块），住户的日常出行要从这里出发
        cxb, cyb = cent[b]
        if (2179 < cxb < 2490 and 830 < cyb < 1300) or (2990 < cxb < 3290 and 1250 < cyb < 2150):
            kind = "residential"
        if kind == "park":
            m = cv2.erode((lab == b).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
            img[m] = PARK
            cv2.ellipse(img, (int(cent[b][0]), int(cent[b][1])), (int(bw * 0.22), int(bh * 0.16)), rng.integers(0, 40), 0, 360, WATER, -1)
            continue
        y = y0 + 8
        while y < y0 + bh - 30:
            x = x0 + 8
            row_h = 30
            while x < x0 + bw - 30:
                t = kind if kind != "mixed" else rng.choice(["office", "commercial", "residential"])
                if t == "residential":
                    w, h, col = rng.integers(120, 180), 28, RESIDENTIAL
                elif t == "office":
                    w, h, col = rng.integers(70, 120), rng.integers(70, 110), MAGENTA
                else:
                    w, h, col = rng.integers(130, 230), rng.integers(80, 130), RED if rng.random() < 0.8 else ORANGE
                if try_rect(b, x, y, w, h, col):
                    row_h = max(row_h, h)
                    if t == "residential" and rng.random() < 0.5:
                        try_rect(b, x, y + h + 10, w, 22, GREEN)
                    x += w + rng.integers(28, 46)
                else:
                    x += 24
            y += row_h + (62 if kind == "residential" else rng.integers(34, 52))

    # ------------------------------------------------------------------ 高架（画在最后，盖在地面道路上）
    exp_y = art_y + 43  # 横贯的高架快速路压在主干路正中
    cv2.rectangle(img, (60, exp_y - 20), (W - 60, exp_y + 20), ELEVATED, -1)
    cv2.polylines(img, [ring_path.round().astype(np.int32).reshape(-1, 1, 2)], True, ELEVATED, 40)

    # ------------------------------------------------------------------ sidecar: 轨道交通 + 场馆 + 核心区
    P = lambda pts: [[round(float(x), 1), round(float(y), 1)] for x, y in pts]  # 像素坐标保留 1 位小数
    mx = bx + 16  # 南北线走核心区次干路 B 的正下方
    sidecar = {
        "mpp": MPP,
        "activeRegion": ACTIVE,
        "venues": [
            {"name": "奥体中心体育场", "type": "stadium", "at": [2905, 1058], "capacity": 9000},
            {"name": "大剧院", "type": "opera", "at": [1652, 1395], "capacity": 1600},
        ],
        "transit": {"lines": [
            {"id": "M1", "name": "1号线", "kind": "metro", "color": "#f2c230", "points": P([(mx, 150), (mx, 3250)]), "stations": [
                {"name": "北苑", "at": [mx, 565]}, {"name": "体育中心", "at": [mx, 800]}, {"name": "中心站", "at": [mx, CORE_Y + 258]},
                {"name": "南广场", "at": [mx, CORE_Y + 700]}, {"name": "南环", "at": [mx, 2600]}, {"name": "南郊", "at": [mx, 3070]}]},
            {"id": "M2", "name": "2号线", "kind": "metro", "color": "#2fa66a", "points": P(smooth([(150, 1610), (900, 1580), (1500, CORE_Y + 258), (3300, CORE_Y + 258), (3900, 1580), (4650, 1540)], 3)), "stations": [
                {"name": "西郊", "at": [330, 1603]}, {"name": "西环", "at": [900, 1580]}, {"name": "大剧院", "at": [1652, CORE_Y + 258]},
                {"name": "中心站", "at": [mx, CORE_Y + 258]}, {"name": "东门", "at": [3000, CORE_Y + 258]}, {"name": "东环", "at": [3900, 1580]}, {"name": "东郊", "at": [4400, 1552]}]},
            {"id": "M3", "name": "3号线（环线）", "kind": "metro", "color": "#3b7ddd", "loop": True, "points": P(ring_path), "stations": [
                {"name": "体育中心", "at": [mx, 800]}, {"name": "东北角", "at": [3560, 800]}, {"name": "东环", "at": [3900, 1580]}, {"name": "东南角", "at": [3900, 2300]},
                {"name": "南环", "at": [mx, 2600]}, {"name": "西南角", "at": [1300, 2600]}, {"name": "西环", "at": [900, 1580]}, {"name": "北站", "at": [1400, 800]}]},
            {"id": "R1", "name": "城际铁路", "kind": "rail", "color": "#7b3fb5", "points": P(rail), "stations": [
                {"name": "北站", "at": [1400, 690]}, {"name": "东站", "at": [4180, 1850]}]},
        ]},
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    cv2.imencode(".png", img)[1].tofile(str(out_dir / "district_marked.png"))
    (out_dir / "district.sidecar.json").write_text(json.dumps(sidecar, ensure_ascii=False, indent=1), "utf-8")
    print("wrote", out_dir / "district_marked.png", "and district.sidecar.json")


if __name__ == "__main__":
    main()
