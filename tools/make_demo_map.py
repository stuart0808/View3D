#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成一张示例「标记图」，用来验证 map2scene.py 的完整流程，也顺便当作标记画法的参考。
约 600m x 440m 的城区: 环路（双向六车道 + 中央隔离带）、横贯的主干路及其上方的高架、
次干路、支路、一个环岛，商场/商铺/高楼/公园/水池/广场/停车场/绿化带。
故意加了整体旋转、抗锯齿、噪点和灰色底图，模拟真实地图截图上手工涂色的情况。

    python tools/make_demo_map.py tools/samples/demo_marked.png
    python tools/map2scene.py tools/samples/demo_marked.png -o public/scenes/demo.json --width-m 600 --debug tools/samples/demo_preview.png
"""
import sys
from pathlib import Path

import cv2
import numpy as np

# 标记色（BGR，OpenCV 的通道顺序），和 map2scene.py 的 DEFAULT_MARKERS 一一对应
RED, ORANGE, MAGENTA = (0, 0, 255), (0, 128, 255), (255, 0, 255)  # 商铺 2 层 / 商铺 1 层 / 写字楼
BLUE, YELLOW, CYAN = (255, 0, 0), (0, 255, 255), (255, 255, 0)  # 车行道 / 店门点 / 出入口点
GREEN, PARK, WATER, PLAZA, PARKING = (0, 255, 0), (0, 128, 0), (255, 128, 0), (255, 128, 255), (255, 0, 128)  # 绿化 / 公园 / 水 / 广场 / 停车场
ELEVATED = (128, 0, 255)  # 高架

W, H = 3000, 2200  # 画布像素；按 0.2 m/px 即 600m x 440m


def draw_demo(R, clear, disc, ellipse, elevated=True):
    """
    画示例街区。只通过 R / clear / disc / ellipse 四个图元作画，所以别的脚本（make_district_map.py）
    可以传入带缩放和平移的图元，把整个街区嵌到更大的地图里。坐标按 3000x2200、0.2 m/px。
    """
    # ---- 道路 ----
    # 坐标都是像素（0.2 m/px）。R(x, y, w, h, 颜色) 填矩形，clear 挖空，disc 画圆点，ellipse 画椭圆
    o, rw = 130, 120                      # 环路: 离边 130px，宽 120px ≈ 22m，双向六车道
    R(o, o, W - 2 * o, rw, BLUE)
    R(o, H - o - rw, W - 2 * o, rw, BLUE)
    R(o, o, rw, H - 2 * o, BLUE)
    R(W - o - rw, o, rw, H - 2 * o, BLUE)
    R(o, 992, W - 2 * o, 216, BLUE)       # 东西向主干路: 约 39m。中间 18m 在高架正下方（桥墩 + 隔离带），两侧各 3 车道
    R(900, o, 48, H - 2 * o, BLUE)        # 支路 A
    R(1700, o, 80, H - 2 * o, BLUE)       # 次干路 B: 双向四车道
    R(2300, o, 48, H - 2 * o, BLUE)       # 支路 C
    R(o, 620, 1700 - o, 48, BLUE)         # 北侧支路（到 B 为止）
    R(900, 1560, W - o - 900, 48, BLUE)   # 南侧支路（从 A 开始）
    # 环岛: A 与北侧支路相交处，画一个圆环即可（脚本按「道路里的圆形孔洞」识别）
    disc(924, 644, 118, BLUE)  # 外圆 ≈ 24m 半径
    disc(924, 644, 52, (0, 0, 0), on=0)  # 挖掉中心岛（alpha 也清掉，露出底图）
    # 高架: 盖在主干路正上方，两端伸出环路
    if elevated:
        R(30, 1050, W - 60, 100, ELEVATED)

    # ---- 北半区 ----
    # 西北上: L 形商铺 + 高楼
    R(295, 295, 420, 140, RED)
    R(295, 435, 160, 140, RED)
    R(520, 470, 200, 105, MAGENTA)
    # 西北下: 一排商铺 + 绿化带
    R(295, 713, 440, 140, RED)
    R(295, 880, 440, 24, GREEN)
    R(295, 915, 200, 35, ORANGE)
    # 中北上: 带内院的大商场（避开左下角的环岛）
    R(1090, 295, 565, 280, RED)
    clear(1260, 380, 220, 110)
    # 中北下: 两栋商铺 + 小广场
    R(1090, 713, 250, 235, RED)
    R(1380, 713, 275, 120, RED)
    R(1380, 850, 275, 98, PLAZA)
    # 东北: 公园 + 水池
    R(1825, 295, 430, 655, PARK)
    ellipse(2040, 600, 130, 190, 15, WATER)
    # 最东北: 三栋住宅高楼 + 绿地
    for y in (295, 520, 745):
        R(2393, y, 312, 110, MAGENTA)
        R(2393, y + 125, 312, 60, GREEN)

    # ---- 南半区 ----
    # 西南: 大商场 + 停车场
    R(295, 1250, 560, 285, RED)
    R(295, 1590, 560, 315, PARKING)
    # 中南上: U 形商铺围着广场
    R(993, 1250, 130, 265, RED)
    R(1123, 1385, 402, 130, RED)
    R(1525, 1250, 130, 265, RED)
    R(1123, 1250, 402, 135, PLAZA)
    # 中南下: 一排商铺 + 单层铺
    R(993, 1653, 400, 120, RED)
    R(993, 1800, 180, 105, ORANGE)
    R(1210, 1800, 183, 105, RED)
    R(1430, 1653, 225, 252, PARKING)
    # 东南上: 商铺 + 高楼
    R(1825, 1250, 430, 115, RED)
    R(1825, 1400, 200, 115, MAGENTA)
    R(2055, 1400, 200, 115, GREEN)
    # 东南下: 写字楼 + 绿地
    R(1825, 1653, 200, 252, MAGENTA)
    R(2055, 1653, 200, 252, PARK)
    # 最东南
    R(2393, 1250, 312, 265, RED)
    clear(2480, 1320, 140, 110)
    R(2393, 1653, 312, 110, RED)
    R(2393, 1790, 312, 115, GREEN)

    # 手工店门（只给西北 L 形标，其余自动）
    for x, y in [(390, 295), (600, 435), (455, 510)]:
        disc(x, y, 7, YELLOW)
    # 出入口: 环路外侧的人行边上
    e = 112
    for x, y in [(e, e), (W - e, e), (e, H - e), (W - e, H - e), (924, e), (924, H - e), (1740, e), (1740, H - e), (2324, e), (2324, H - e), (e, 644), (e, 1584), (W - e, 1584), (W - e, 644)]:
        disc(x, y, 7, CYAN)



def main():
    """画一张带底图噪声和整体旋转的示例标记图，模拟手工涂色的真实情况"""
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "tools/samples/demo_marked.png")
    rng = np.random.default_rng(7)

    # 灰色底图 + 一些无关线条（模拟地图上的杂项）
    base = np.full((H, W, 3), (232, 234, 236), np.uint8)
    for _ in range(60):
        p = rng.integers(0, H, 4)
        cv2.line(base, (int(p[0]) * W // H, int(p[1])), (int(p[2]) * W // H, int(p[3])), (215, 218, 220), int(rng.integers(1, 4)), cv2.LINE_AA)

    mk = np.zeros((H, W, 3), np.uint8)  # 标记层颜色
    a = np.zeros((H, W), np.uint8)  # 标记层 alpha（哪里有标记）

    def R(x, y, w, h, col):
        """填一个矩形（同时写 alpha）"""
        cv2.rectangle(mk, (x, y), (x + w, y + h), col, -1)
        cv2.rectangle(a, (x, y), (x + w, y + h), 255, -1)

    def clear(x, y, w, h):
        """挖空一个矩形（内院、环岛中心）"""
        cv2.rectangle(mk, (x, y), (x + w, y + h), (0, 0, 0), -1)
        cv2.rectangle(a, (x, y), (x + w, y + h), 0, -1)

    def disc(cx, cy, r, col, on=255):
        """画圆；on=0 时是挖空"""
        cv2.circle(mk, (cx, cy), r, col, -1)
        cv2.circle(a, (cx, cy), r, on, -1)

    def ellipse(cx, cy, rx, ry, ang, col):
        """填椭圆（水池）"""
        cv2.ellipse(mk, (cx, cy), (rx, ry), ang, 0, 360, col, -1)
        cv2.ellipse(a, (cx, cy), (rx, ry), ang, 0, 360, 255, -1)

    draw_demo(R, clear, disc, ellipse)

    # 整体旋转 6°（带抗锯齿），再叠到底图上
    M = cv2.getRotationMatrix2D((W / 2, H / 2), 6, 0.9)  # 转 6°、缩到 0.9 倍，四角不会裁掉
    mk = cv2.warpAffine(mk, M, (W, H), flags=cv2.INTER_LINEAR)
    a = cv2.warpAffine(a, M, (W, H), flags=cv2.INTER_LINEAR).astype(np.float32)[..., None] / 255
    img = (mk * a + base * (1 - a)).astype(np.float32)  # 按 alpha 混合到底图上
    img += rng.normal(0, 4, img.shape)  # 高斯噪点，模拟压缩 / 扫描
    img = np.clip(img, 0, 255).astype(np.uint8)

    out.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".png", img)
    buf.tofile(str(out))
    print("wrote", out)


if __name__ == "__main__":
    main()
