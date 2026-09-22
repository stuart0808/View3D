#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sat2marks.py —— 卫星图半自动标注工具（本地网页）。产出与 map2scene.py 完全兼容的「标记图层」。

    python tools/sat2marks.py 卫星图.jpg --mpp 0.3
    # 浏览器自动打开 http://127.0.0.1:8765 ；标完点「生成场景」直接得到 public/scenes/<名字>.json

分割后端按环境自动降级（也可用 --model / --device / --no-sam 强制指定）:
    有 CUDA            → SAM 大模型 (sam2.1_l.pt)，点一下 ~0.1s
    只有 CPU           → MobileSAM (mobile_sam.pt)，首次点某块区域 ~1-3s，之后同一区域几乎即时
    没装 torch/ultralytics → 漫水填充（按颜色相似度扩散），效果差一截，但多边形/画路等手工工具照常可用

依赖: opencv-python-headless numpy  （可选: torch ultralytics）
权重首次使用时由 ultralytics 自动下载到当前目录；国内网络慢的话手动下载后用 --model 指向文件。

结构:
    分割后端   FloodBackend / SamBackend，统一接口 segment(points) → bool 掩膜；points = [(x, y, 1 正样本 / 0 负样本)]
    Session    标注状态: labels（每像素一个类别 id）、dots（门 / 出入口点）、撤销栈；可保存 / 续标；导出标记图
    HTTP       一个极简的本地服务: GET 静态页 / 图片 / 状态，POST 各种编辑动作（见 make_handler.route）
    界面       tools/sat2marks_ui.html（纯前端，画布叠加标记层，逐块 patch 更新）
产物: <图名>_labels.png（类别 id 图，续标用）、<图名>_marks.json（点 + 比例尺）、<图名>_marks.png（给 map2scene 的标记图）
"""
import argparse
import base64  # 掩膜 / 补丁图以 base64 PNG 发给前端
import json
import subprocess  # 导出时调 map2scene.py
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent  # tools/ 目录，找 ui.html 和 map2scene.py 用

# id 0 = 未标记。颜色必须与 map2scene.py 的 DEFAULT_MARKERS 一致。
CLASSES = [  # id 写进 labels.png；key / label 给前端按钮；color 是导出标记图的颜色
    {"id": 1, "key": "shop2", "label": "商铺 2层", "color": "#FF0000"},
    {"id": 2, "key": "shop1", "label": "商铺 1层", "color": "#FF8000"},
    {"id": 3, "key": "block", "label": "高楼/非商铺", "color": "#FF00FF"},
    {"id": 4, "key": "road", "label": "车行道", "color": "#0000FF"},
    {"id": 5, "key": "green", "label": "绿化带", "color": "#00FF00"},
    {"id": 6, "key": "park", "label": "公园", "color": "#008000"},
    {"id": 7, "key": "water", "label": "水体", "color": "#0080FF"},
    {"id": 8, "key": "plaza", "label": "广场", "color": "#FF80FF"},
    {"id": 9, "key": "parking", "label": "停车场", "color": "#8000FF"},
    {"id": 10, "key": "elevated", "label": "高架路", "color": "#FF0080"},
    {"id": 11, "key": "residential", "label": "住宅楼", "color": "#00FF80"},
    {"id": 12, "key": "venue", "label": "活动场馆", "color": "#80FF00"},
]
DOT_COLORS = {"door": "#FFFF00", "portal": "#00FFFF"}  # 点状标记的颜色
BUILDING_IDS = {1, 2, 3, 11, 12}  # 哪些类别是建筑（涂路 / 绿地时可以保护它们不被覆盖）


def hex_bgr(h):
    """'#RRGGBB' → OpenCV 的 (b, g, r)"""
    h = h.lstrip("#")
    return (int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16))


def imread_unicode(path):
    """读图（支持中文路径），失败直接退出"""
    img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"无法读取图片: {path}")
    return img


def imwrite_unicode(path, img):
    """写图（支持中文路径），按扩展名编码"""
    ok, buf = cv2.imencode(Path(path).suffix, img)
    if not ok:
        raise RuntimeError(f"编码失败: {path}")
    buf.tofile(str(path))


# ----------------------------------------------------------------------------
# 分割后端
# ----------------------------------------------------------------------------
class FloodBackend:
    """没有深度学习环境时的兜底: 在平滑后的 Lab 图上做漫水填充。"""
    name = "漫水填充（未检测到 torch/ultralytics）"  # 显示在界面上

    def __init__(self, img):
        # 双边滤波去掉屋顶纹理和噪点但保留边缘，再转 Lab（颜色距离更符合视觉）
        self.lab = cv2.cvtColor(cv2.bilateralFilter(img, 9, 40, 9), cv2.COLOR_BGR2Lab)

    def segment(self, points, tol=10):
        """每个正样本点漫水填充后并进结果，负样本点填充的区域从结果里减掉；tol 是 Lab 三通道的容差"""
        h, w = self.lab.shape[:2]
        out = np.zeros((h, w), bool)  # 累积结果
        for x, y, lab in points:  # lab: 1 正样本 / 0 负样本
            m = np.zeros((h + 2, w + 2), np.uint8)  # floodFill 的掩膜要比图大一圈
            # 只写掩膜不改图；FIXED_RANGE = 和种子点比而不是和邻居比，防止颜色渐变时一路漏出去；填充值 255
            cv2.floodFill(self.lab.copy(), m, (int(x), int(y)), 0, (tol,) * 3, (tol,) * 3, 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8))
            m = m[1:-1, 1:-1] > 0
            out = (out | m) if lab else (out & ~m)  # 正样本并入，负样本减去
        return out


class SamBackend:
    """
    ultralytics 封装的 SAM / SAM2 / MobileSAM。
    SAM 内部会把长边缩到 1024，整张大卫星图直接喂进去小房子就糊了，
    所以按点击位置取 tile×tile 的窗口做推理；窗口的图像编码会缓存，同一窗口内的后续点击只跑轻量解码器。
    """

    def __init__(self, img, model, device, tile=1024):
        import torch  # noqa: F401  # 只是确认装了
        from ultralytics.models import sam as usam

        self.img = img
        self.tile = tile  # 推理窗口边长（像素）
        self.win = None  # 当前已编码的窗口 (x0, y0, x1, y1)
        is_sam2 = "sam2" in Path(model).name.lower()  # SAM2 用另一个 Predictor 类
        cls = usam.SAM2Predictor if is_sam2 and hasattr(usam, "SAM2Predictor") else usam.Predictor
        self.predictor = cls(overrides=dict(conf=0.25, task="segment", mode="predict", imgsz=1024, model=model, device=device, save=False, verbose=False))  # 不存文件、不打日志
        self.name = f"{Path(model).stem} @ {device}"  # 如 mobile_sam @ cpu

    def _window_for(self, points):
        """决定推理窗口: 图不大就整张；点都落在当前窗口内部（留 12% 边）就复用；否则以第一个点为中心开新窗"""
        h, w = self.img.shape[:2]
        t = self.tile
        if max(h, w) <= t * 1.4:
            return (0, 0, w, h)  # 图不比窗口大多少，整张喂进去
        if self.win:
            x0, y0, x1, y1 = self.win
            mx, my = (x1 - x0) * 0.12, (y1 - y0) * 0.12  # 12% 的边距: 贴边的物体切一半效果差
            if all(x0 + mx <= p[0] <= x1 - mx and y0 + my <= p[1] <= y1 - my for p in points):
                return self.win
        px, py = points[0][0], points[0][1]
        x0 = int(min(max(px - t / 2, 0), max(0, w - t)))  # 以点为中心，夹到图内
        y0 = int(min(max(py - t / 2, 0), max(0, h - t)))
        return (x0, y0, min(w, x0 + t), min(h, y0 + t))

    def segment(self, points, tol=None):
        """窗口变了才重新编码图像；多个候选掩膜取置信度最高的；结果放回整图坐标"""
        win = self._window_for(points)
        if win != self.win:  # 换窗口: 重新跑图像编码器（慢的那一步）
            x0, y0, x1, y1 = win
            self.predictor.reset_image()
            self.predictor.set_image(np.ascontiguousarray(self.img[y0:y1, x0:x1]))  # 切片要连续内存
            self.win = win
        x0, y0, x1, y1 = self.win
        pts = [[[float(p[0] - x0), float(p[1] - y0)] for p in points]]  # 转到窗口坐标
        labs = [[int(p[2]) for p in points]]
        res = self.predictor(points=pts, labels=labs)  # 只跑提示解码器
        out = np.zeros(self.img.shape[:2], bool)
        if res and res[0].masks is not None and len(res[0].masks.data):
            data = res[0].masks.data  # 可能有多个候选掩膜
            k = 0
            conf = getattr(res[0].boxes, "conf", None)
            if conf is not None and len(conf) == len(data):
                k = int(conf.argmax())
            m = data[k].cpu().numpy().astype(bool)
            if m.shape != (y1 - y0, x1 - x0):  # 模型输出可能是缩放过的，拉回窗口尺寸
                m = cv2.resize(m.astype(np.uint8), (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST) > 0
            out[y0:y1, x0:x1] = m
        return out


def make_backend(img, args):
    """按环境选后端: --no-sam / 没装 torch → 漫水填充；有 CUDA → sam2.1_l，只有 CPU → mobile_sam；SAM 初始化失败也退回漫水填充"""
    if args.no_sam:
        return FloodBackend(img)  # 强制关掉 SAM
    try:
        import torch
        import ultralytics  # noqa: F401
    except ImportError:  # 没装深度学习环境
        print("[sat2marks] 未安装 torch/ultralytics → 退化为漫水填充。需要 SAM 请: pip install torch ultralytics")
        return FloodBackend(img)
    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")  # 自动选设备
    model = args.model or ("sam2.1_l.pt" if device.startswith("cuda") else "mobile_sam.pt")  # GPU 用大模型，CPU 用轻量版
    print(f"[sat2marks] 加载分割模型 {model} @ {device} …（首次会自动下载权重）")
    try:
        return SamBackend(img, model, device)
    except Exception as e:  # 权重下载失败、显存不够等
        print(f"[sat2marks] SAM 初始化失败（{e}）→ 退化为漫水填充")
        return FloodBackend(img)


def tidy_mask(mask, points, is_building):
    """只保留包含正样本点的连通块，补洞，去毛刺。"""
    m = mask.astype(np.uint8)
    if not m.any():
        return mask  # 空掩膜原样返回
    n, lab = cv2.connectedComponents(m, connectivity=8)
    keep = {int(lab[int(p[1]), int(p[0])]) for p in points if p[2] and 0 <= int(p[1]) < lab.shape[0] and 0 <= int(p[0]) < lab.shape[1]} - {0}  # 正样本点所在的连通块编号（0 是背景）
    if keep:
        m = np.isin(lab, list(keep)).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    m = cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_CLOSE, k), cv2.MORPH_OPEN, k)  # 先闭后开: 补小洞、去毛刺
    if is_building:  # 屋顶上的天窗、设备会在掩膜里留洞，建筑一律填实
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)  # 只取外轮廓再填，洞就没了
        m = np.zeros_like(m)
        cv2.drawContours(m, cnts, -1, 1, -1)
    return m > 0  # 回到 bool


def auto_vegetation(img, mpp, thr=0.06, min_area_m2=25.0, park_area_m2=1500.0, park_width_m=18.0):
    """
    过绿指数 ExG = 2g - r - b（色度归一化后）提植被。大而宽的连通块算公园，其余算绿化带。
    返回 (green_mask, park_mask)。秋天变黄/变红的树会漏，阴影里的会漏一部分 —— 这是初稿，需要人看一眼。
    """
    f = img.astype(np.float32) + 1.0  # +1 防止全黑像素除零
    s = f.sum(-1)
    b, g, r = f[..., 0] / s, f[..., 1] / s, f[..., 2] / s  # 色度归一化: 去掉亮度影响
    exg = 2 * g - r - b  # 过绿指数
    veg = ((exg > thr) & (g > r) & (g > b) & (img.max(-1) > 28)).astype(np.uint8)  # 绿色占优且不是太暗（阴影）
    k1 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    kc = max(3, int(round(1.5 / mpp)) | 1)  # 闭运算核 ≈ 1.5m，把树冠之间的缝合上
    veg = cv2.morphologyEx(cv2.morphologyEx(veg, cv2.MORPH_OPEN, k1), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kc, kc)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(veg, connectivity=8)  # 逐块判断
    green = np.zeros(veg.shape, bool)
    park = np.zeros(veg.shape, bool)
    dt = cv2.distanceTransform(veg, cv2.DIST_L2, 3)  # 到植被边缘的距离，量「宽度」用
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA] * mpp * mpp
        if area < min_area_m2:
            continue
        comp = lab == i
        if area >= park_area_m2 and float(dt[comp].max()) * 2 * mpp >= park_width_m:  # 又大又宽才是公园，细长的是绿化带
            park |= comp
        else:
            green |= comp
    return green, park  # 两个 bool 掩膜


# ----------------------------------------------------------------------------
# 会话状态
# ----------------------------------------------------------------------------
class Session:
    """一张图的标注状态。labels 是 uint8 类别图（0 = 未标记），所有编辑都经过 paint() 以便撤销"""

    def __init__(self, image_path, args):
        self.path = Path(image_path)
        self.img = imread_unicode(self.path)
        self.h, self.w = self.img.shape[:2]  # 图片尺寸（像素）
        self.mpp = args.mpp or ((args.width_m / self.w) if args.width_m else 0.3)  # 米/像素，默认 0.3（常见卫星图级别）
        self.out_dir = Path(args.out_dir) if args.out_dir else self.path.parent  # 产物默认和图片放一起
        self.stem = self.path.stem  # 产物文件名前缀
        self.labels = np.zeros((self.h, self.w), np.uint8) # 每像素类别 id
        self.dots = [] # [{kind: door|portal, x, y}]
        self.undo = [] # 撤销栈: ('patch', x0, y0, 旧像素块) 或 ('dot',)
        self.preview = None # 分割出来但还没提交的掩膜
        self.preview_points = []
        self.lock = threading.Lock()  # HTTP 是多线程的，编辑操作串行化
        self.backend = make_backend(self.img, args)
        self._load()  # 续标
        self.lut = np.zeros((256, 4), np.uint8) # 类别 id → BGRA，未标记透明
        for c in CLASSES:
            self.lut[c["id"]] = (*hex_bgr(c["color"]), 255)

    # --- 断点续标: 三个产物文件的路径 ---
    @property
    def labels_file(self):
        return self.out_dir / f"{self.stem}_labels.png"

    @property
    def meta_file(self):
        return self.out_dir / f"{self.stem}_marks.json"

    @property
    def marks_file(self):
        return self.out_dir / f"{self.stem}_marks.png"

    def _load(self):
        """同目录下有上次的 labels.png + marks.json 且尺寸一致就载入，断点续标"""
        if self.labels_file.exists() and self.meta_file.exists():
            lab = cv2.imdecode(np.fromfile(str(self.labels_file), np.uint8), cv2.IMREAD_GRAYSCALE)  # 类别 id 图是单通道 png
            if lab is not None and lab.shape == self.labels.shape:  # 尺寸对不上说明换了图，不载入
                self.labels = lab
                meta = json.loads(self.meta_file.read_text("utf-8"))
                self.dots = meta.get("dots", [])  # 门 / 出入口点
                self.mpp = meta.get("mpp", self.mpp)  # 上次校准过的比例尺
                print(f"[sat2marks] 已载入上次的标注 {self.labels_file.name}")

    def save(self):
        """写 labels.png / marks.json，并渲染 map2scene 用的标记图（类别色 + 门 / 出入口圆点），返回标记图路径"""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        imwrite_unicode(self.labels_file, self.labels)  # 类别图（无损）
        self.meta_file.write_text(json.dumps({"mpp": self.mpp, "dots": self.dots, "image": self.path.name}, ensure_ascii=False, indent=2), "utf-8")
        rgba = self.lut[self.labels]  # 类别图 → 彩色标记图（未标记透明）
        r = max(5, int(round(1.4 / self.mpp)))  # 圆点半径 ≈ 1.4m，至少 5px（map2scene 要求点面积 ≥ 4px）
        for d in self.dots:  # 门 / 出入口画成实心圆点，不抗锯齿（颜色要纯）
            cv2.circle(rgba, (int(d["x"]), int(d["y"])), r, (*hex_bgr(DOT_COLORS[d["kind"]]), 255), -1, cv2.LINE_8)
        imwrite_unicode(self.marks_file, rgba)
        return self.marks_file

    # --- 编辑 ---
    def _push_undo(self, x0, y0, x1, y1):
        """把即将被改的矩形块存进撤销栈（最多 60 步）"""
        self.undo.append(("patch", x0, y0, self.labels[y0:y1, x0:x1].copy()))
        del self.undo[:-60]  # 只留最近 60 步，控制内存

    def paint(self, mask, cls, protect_buildings=False):
        """把掩膜范围涂成类别 cls（0 = 擦除）。protect_buildings: 涂道路 / 绿地时不覆盖已标的建筑。返回被改区域的 patch"""
        ys, xs = np.nonzero(mask)
        if not len(xs):
            return None  # 空掩膜什么也不做
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1  # 掩膜的外接矩形
        self._push_undo(x0, y0, x1, y1)
        sub = mask[y0:y1, x0:x1]
        if protect_buildings and cls not in BUILDING_IDS and cls != 0:  # 涂非建筑类时跳过已标的建筑像素；擦除（0）不保护
            sub = sub & ~np.isin(self.labels[y0:y1, x0:x1], list(BUILDING_IDS))
        self.labels[y0:y1, x0:x1][sub] = cls  # 只改矩形内被掩膜选中的像素
        return self.patch(x0, y0, x1, y1)

    def patch(self, x0, y0, x1, y1):
        """一块矩形区域的标记层渲染成 PNG（base64），前端只重绘这一块"""
        ok, buf = cv2.imencode(".png", self.lut[self.labels[y0:y1, x0:x1]])  # 类别 → BGRA
        return {"bbox": [x0, y0, x1 - x0, y1 - y0], "png": base64.b64encode(buf).decode()}  # bbox = [x, y, w, h]

    def full_png(self):
        """整张标记层 PNG（页面初始化 / 整体重载时用）"""
        return cv2.imencode(".png", self.lut[self.labels])[1].tobytes()

    def do_undo(self):
        """撤销一步: 点 → 弹出最后一个点；像素块 → 写回旧值并返回 patch"""
        if not self.undo:
            return {"ok": False}  # 没有可撤销的
        item = self.undo.pop()
        if item[0] == "dot":  # 上一步是放点
            self.dots.pop()
            return {"ok": True, "dots": self.dots}
        _, x0, y0, old = item  # 像素块: 写回旧值
        self.labels[y0:y0 + old.shape[0], x0:x0 + old.shape[1]] = old
        return {"ok": True, "patch": self.patch(x0, y0, x0 + old.shape[1], y0 + old.shape[0])}


# ----------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------
def make_handler(S: Session, args):
    """生成绑定了会话的请求处理类。所有 POST 在会话锁内执行（分割和涂色都会改状态）"""
    project = HERE.parent  # 仓库根目录，导出的 scene.json 放到 public/scenes/

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass  # 不打访问日志

        def _send(self, body, ctype="application/json", code=200):
            """发响应: dict / list 自动转 json，bytes 原样发"""
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")  # 标记层随时在变，不许缓存
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            """GET: / 页面、/image 原图（jpg）、/labels.png 整张标记层、/preview.png map2scene 的预览图、/state 会话状态"""
            p = self.path.split("?")[0]  # 去掉 query（前端用时间戳防缓存）
            if p == "/":
                return self._send((HERE / "sat2marks_ui.html").read_bytes(), "text/html; charset=utf-8")
            if p == "/image":  # 原图转 jpg 传给前端（卫星图通常很大）
                return self._send(cv2.imencode(".jpg", S.img, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes(), "image/jpeg")
            if p == "/labels.png":  # 整张标记层（页面加载、整体重载时）
                with S.lock:
                    return self._send(S.full_png(), "image/png")
            if p == "/preview.png":
                f = S.out_dir / f"{S.stem}_scene_preview.png"
                return self._send(f.read_bytes(), "image/png") if f.exists() else self._send({"error": "no preview"}, code=404)
            if p == "/state":
                return self._send({"name": S.stem, "width": S.w, "height": S.h, "mpp": S.mpp, "classes": CLASSES, "dots": S.dots,
                                   "dotColors": DOT_COLORS, "backend": S.backend.name, "isSam": isinstance(S.backend, SamBackend)})
            self._send({"error": "not found"}, code=404)  # 其余路径

        def do_POST(self):
            """POST: 读 json 请求体 → route()；异常转成 500 + 错误文本给前端显示"""
            n = int(self.headers.get("Content-Length") or 0)
            q = json.loads(self.rfile.read(n) or b"{}")
            p = self.path
            try:
                with S.lock:  # 一次只处理一个编辑请求
                    self._send(self.route(p, q))
            except Exception as e:  # 把错误原样给前端显示
                import traceback
                traceback.print_exc()
                self._send({"error": f"{type(e).__name__}: {e}"}, code=500)

        def route(self, p, q):
            """
            POST 路由（q 是请求 json）:
              /sam        用点提示分割 → 预览掩膜（不落到 labels）
              /commit     把预览掩膜涂成某类
              /polygon    手画多边形涂色；/polyline 手画线（按 width_m 米宽）涂色，画路用
              /dot        放一个门 / 出入口点；/undo 撤销；/mpp 改比例尺
              /auto_veg   过绿指数自动提植被（只填未标记像素）；/clear_class 清掉某类
              /export     保存并（可选）直接调 map2scene 生成 public/scenes/<name>.json
            """
            if p == "/sam":
                pts = [(min(max(x, 0), S.w - 1), min(max(y, 0), S.h - 1), int(l)) for x, y, l in q["points"]]  # 点夹到图内
                if not any(l for *_, l in pts):
                    return {"empty": True}  # 一个正样本都没有
                t0 = time.time()  # 计时，界面上显示分割耗时
                mask = S.backend.segment(pts, tol=q.get("tol", 10))
                mask = tidy_mask(mask, pts, int(q.get("cls", 0)) in BUILDING_IDS)  # 按目标类别决定要不要填洞
                S.preview = mask  # 存起来等 /commit
                ys, xs = np.nonzero(mask)
                if not len(xs):
                    return {"empty": True, "ms": int((time.time() - t0) * 1000)}
                x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
                rgba = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)  # 预览: 白色不透明 = 选中
                rgba[mask[y0:y1, x0:x1]] = (255, 255, 255, 255)
                png = cv2.imencode(".png", rgba)[1]
                return {"bbox": [x0, y0, x1 - x0, y1 - y0], "png": base64.b64encode(png).decode(), "ms": int((time.time() - t0) * 1000),
                        "area_m2": round(float(mask.sum()) * S.mpp ** 2, 1)}
            if p == "/commit":
                if S.preview is None:
                    return {"ok": False}  # 没有待提交的分割结果
                out = S.paint(S.preview, int(q["cls"]), q.get("protect", True))
                S.preview = None  # 用掉了
                return {"ok": True, "patch": out}
            if p in ("/polygon", "/polyline"):
                mask = np.zeros((S.h, S.w), np.uint8)
                pts = np.array(q["points"], np.float64).round().astype(np.int32).reshape(-1, 1, 2)  # OpenCV 要的形状
                if p == "/polygon":
                    cv2.fillPoly(mask, [pts], 1)
                else:
                    cv2.polylines(mask, [pts], False, 1, max(1, int(round(q["width_m"] / S.mpp))), cv2.LINE_8)  # 线宽 = 路宽（米）换成像素
                return {"ok": True, "patch": S.paint(mask > 0, int(q["cls"]), q.get("protect", True))}
            if p == "/dot":
                S.dots.append({"kind": q["kind"], "x": float(q["x"]), "y": float(q["y"])})
                S.undo.append(("dot",))  # 放点也能撤销
                return {"ok": True, "dots": S.dots}
            if p == "/undo":
                return S.do_undo()
            if p == "/mpp":  # 界面用标尺校准比例尺
                S.mpp = float(q["mpp"])
                return {"ok": True, "mpp": S.mpp}
            if p == "/auto_veg":
                green, park = auto_vegetation(S.img, S.mpp, thr=float(q.get("thr", 0.06)))
                free = S.labels == 0  # 只填还没标的像素，不覆盖手工标注
                S._push_undo(0, 0, S.w, S.h)  # 整图一步撤销
                S.labels[green & free] = 5  # 绿化带
                S.labels[park & free] = 6  # 公园
                return {"ok": True, "reload": True, "green_m2": round(float((green & free).sum()) * S.mpp ** 2), "park_m2": round(float((park & free).sum()) * S.mpp ** 2)}
            if p == "/clear_class":
                cls = int(q["cls"])
                S._push_undo(0, 0, S.w, S.h)
                S.labels[S.labels == cls] = 0
                return {"ok": True, "reload": True}
            if p == "/export":
                marks = S.save()
                res = {"ok": True, "marks": str(marks)}
                if q.get("scene"):  # 顺带生成场景
                    name = q.get("name") or S.stem
                    scene = project / "public" / "scenes" / f"{name}.json"
                    preview = S.out_dir / f"{S.stem}_scene_preview.png"
                    cmd = [sys.executable, str(HERE / "map2scene.py"), str(marks), "-o", str(scene), "--mpp", str(S.mpp), "--debug", str(preview), "--site", q.get("site", "auto")]
                    pr = subprocess.run(cmd, capture_output=True)  # 同步跑，几秒钟
                    log = (pr.stderr or b"").decode("utf-8", "replace") if b"\xe5" in (pr.stderr or b"") else (pr.stderr or b"").decode("gbk", "replace")  # Windows 控制台可能是 GBK；有 utf-8 中文的特征字节就按 utf-8
                    res.update({"scene": str(scene), "sceneName": name, "log": log, "returncode": pr.returncode, "preview": preview.exists()})
                return res
            return {"error": "unknown route"}  # 前端不该发到这里

    return H


def main():
    """命令行入口: 建会话、起本地 HTTP 服务、打开浏览器"""
    ap = argparse.ArgumentParser(description="卫星图半自动标注 → 标记图层（供 map2scene.py 使用）", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("image")  # 卫星图路径
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--mpp", type=float, help="米/像素。不知道的话先随便给，进界面用「标尺」量一段已知距离来校准")
    g.add_argument("--width-m", type=float, help="整张图宽度对应的米数")
    ap.add_argument("--out-dir", help="标注输出目录，默认与图片同目录")  # labels / marks 三个产物
    ap.add_argument("--model", help="ultralytics 支持的 SAM 权重名或路径: mobile_sam.pt / sam_b.pt / sam_l.pt / sam2.1_t.pt / sam2.1_l.pt …")
    ap.add_argument("--device", help="cuda / cuda:0 / cpu，默认自动")
    ap.add_argument("--no-sam", action="store_true", help="强制使用漫水填充")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")  # 远程 / 无头环境不自动开浏览器
    args = ap.parse_args()

    S = Session(args.image, args)  # 读图、建后端、续标
    print(f"[sat2marks] 图片 {S.w}x{S.h}px, {S.mpp:.3f} m/px, 分割后端: {S.backend.name}")
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(S, args))  # 只监听本机
    url = f"http://127.0.0.1:{args.port}/"  # 界面地址
    print(f"[sat2marks] 打开 {url}   (Ctrl+C 退出，标注会在「导出」时保存到 {S.out_dir})")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()  # 等服务起来再开浏览器
    try:
        srv.serve_forever()  # 阻塞到 Ctrl+C
    except KeyboardInterrupt:
        print("\n[sat2marks] 退出")


if __name__ == "__main__":
    main()
