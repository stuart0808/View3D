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
产物: <图名>_labels.png（类别 id 图，续标用）、<图名>_marks.json（点 + 比例尺 + 校准 + 层数）、
      <图名>_marks.png（给 map2scene 的标记图）、<图名>_marks.sidecar.json（逐栋层数）、<图名>_cands.pkl（候选缓存）

推荐流程（高层小区这类图最省事）:
    1. 比例尺: 知道截图的缩放级别就填「纬度 + 级别」，否则用标尺量一段已知长度
    2. 「自动找建筑」→ 候选工具里点一下接受 / 右键丢掉，或者「全部接受」
    3. 植被一键提取；路用画线工具描
    4. 「校准」: 选一栋看得清的楼，依次点 墙脚角 → 对应的屋顶角 → 那个屋顶角的影子尖，填它的层数
    5. 「估算楼高」: 每栋楼按影子估层数；不对的用「层数」工具点楼改
    6. 生成场景: 导出时自动把 屋顶 + 立面 校正成墙脚，层数写进 sidecar
"""
import argparse
import base64  # 掩膜 / 补丁图以 base64 PNG 发给前端
import json
import math
import os
import pickle  # 自动建筑候选的缓存
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
sys.path.insert(0, str(HERE))
import satgeo as sg  # noqa: E402  自动候选 / 倾斜校正 / 影子估高

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
        self.overrides = dict(conf=0.25, task="segment", mode="predict", imgsz=1024, model=model, device=device, save=False, verbose=False)  # 不存文件、不打日志
        self.predictor_cls = cls
        self.predictor = cls(overrides=self.overrides)
        self.name = f"{Path(model).stem} @ {device}"  # 如 mobile_sam @ cpu

    def make_segment_all(self):
        """
        给 satgeo.find_buildings 用的分割函数: (块图像, 提示点 (N,2)) → 掩膜列表。
        另建一个 predictor —— 交互点选那个缓存着当前窗口的图像编码，共用会互相冲掉。
        提示点换成 SAM 要的归一化坐标: 图先按长边缩放到 1024 再补边成正方形，所以统一除以长边。
        """
        pred = self.predictor_cls(overrides=self.overrides)

        def run(tile, pts):
            th, tw = tile.shape[:2]
            r = pred(source=np.ascontiguousarray(tile), point_grids=[np.asarray(pts, np.float64) / max(th, tw)], points_batch_size=128)
            if not r or r[0].masks is None:
                return []
            return [m[:th, :tw] for m in (r[0].masks.data.cpu().numpy() > 0)]  # 保险: 裁到块大小

        return run

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
    """
    一张图的标注状态。labels 是 uint8 类别图（0 = 未标记），所有编辑都经过 paint() 以便撤销。
    除了逐像素的类别，还有几样「矢量」信息（都存在 marks.json 里，续标时恢复）:
        dots    门 / 出入口点
        calib   倾斜 / 影子校准: 一栋楼的 墙脚点 base、屋顶点 roof、影子尖 tip、层数 floors
        floors  逐栋层数 [{x, y, floors, src: 'auto' 影子估的 | 'manual' 手填的}]，按点落在哪栋楼里对应
    自动建筑候选（cands）算一次要几十秒，单独缓存在 <图名>_cands.pkl。
    """

    def __init__(self, image_path, args):
        self.path = Path(image_path)
        self.img = imread_unicode(self.path)
        self.h, self.w = self.img.shape[:2]  # 图片尺寸（像素）
        self.mpp = args.mpp or ((args.width_m / self.w) if args.width_m else 0.3)  # 米/像素，默认 0.3（常见卫星图级别）
        self.out_dir = Path(args.out_dir) if args.out_dir else self.path.parent  # 产物默认和图片放一起
        self.stem = self.path.stem  # 产物文件名前缀
        self.labels = np.zeros((self.h, self.w), np.uint8)  # 每像素类别 id
        self.dots = []  # [{kind: door|portal, x, y}]
        self.undo = []  # 撤销栈: ('patch', x0, y0, 旧像素块) 或 ('dot',)
        self.preview = None  # 分割出来但还没提交的掩膜
        self.preview_points = []
        self.calib = None  # 倾斜 / 影子校准，见类说明
        self.floor_h = 3.0  # 层高（米），层数 ↔ 楼高换算
        self.floors = []  # 逐栋层数
        self.cands = []  # 自动建筑候选 [{id, crop, score, area_m2, state: pending|accepted|rejected}]
        self.job = {"name": None, "running": False, "done": 0, "total": 0, "msg": "", "error": None}  # 后台任务进度
        self.lock = threading.Lock()  # HTTP 是多线程的，编辑操作串行化
        self.backend = make_backend(self.img, args)
        self._load()  # 续标
        self.lut = np.zeros((256, 4), np.uint8)  # 类别 id → BGRA，未标记透明
        for c in CLASSES:
            self.lut[c["id"]] = (*hex_bgr(c["color"]), 255)

    # --- 断点续标: 产物文件的路径 ---
    @property
    def labels_file(self):
        return self.out_dir / f"{self.stem}_labels.png"

    @property
    def meta_file(self):
        return self.out_dir / f"{self.stem}_marks.json"

    @property
    def marks_file(self):
        return self.out_dir / f"{self.stem}_marks.png"

    @property
    def sidecar_file(self):
        """给 map2scene 的 sidecar（逐栋层数），导出时写"""
        return self.out_dir / f"{self.stem}_marks.sidecar.json"

    @property
    def cands_file(self):
        return self.out_dir / f"{self.stem}_cands.pkl"

    def _load(self):
        """同目录下有上次的 labels.png + marks.json 且尺寸一致就载入，断点续标；候选缓存另外读"""
        if self.labels_file.exists() and self.meta_file.exists():
            lab = cv2.imdecode(np.fromfile(str(self.labels_file), np.uint8), cv2.IMREAD_GRAYSCALE)  # 类别 id 图是单通道 png
            if lab is not None and lab.shape == self.labels.shape:  # 尺寸对不上说明换了图，不载入
                self.labels = lab
                meta = json.loads(self.meta_file.read_text("utf-8"))
                self.dots = meta.get("dots", [])  # 门 / 出入口点
                self.mpp = meta.get("mpp", self.mpp)  # 上次校准过的比例尺
                self.calib = meta.get("calib")
                self.floor_h = meta.get("floorH", self.floor_h)
                self.floors = meta.get("floors", [])
                print(f"[sat2marks] 已载入上次的标注 {self.labels_file.name}")
        if self.cands_file.exists():
            try:
                with open(self.cands_file, "rb") as f:
                    data = pickle.load(f)
                if data.get("shape") == (self.h, self.w):  # 换了图就作废
                    self.cands = data["cands"]
                    print(f"[sat2marks] 已载入 {len(self.cands)} 个建筑候选")
            except Exception as e:  # 缓存坏了不影响标注
                print(f"[sat2marks] 候选缓存读不了（{e}），忽略")

    def _save_meta(self):
        """只写 marks.json（矢量信息）；校准、层数改了之后立刻存，不用等导出"""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.meta_file.write_text(json.dumps({"mpp": self.mpp, "dots": self.dots, "image": self.path.name, "calib": self.calib,
                                              "floorH": self.floor_h, "floors": self.floors}, ensure_ascii=False, indent=2), "utf-8")

    def save(self, correct=True):
        """
        写 labels.png / marks.json，渲染 map2scene 用的标记图（类别色 + 门 / 出入口圆点），再写 sidecar（逐栋层数）。
        correct: 有倾斜校准时，把每栋楼的剪影（屋顶 + 立面）换成推算出的墙脚。labels 本身不动 —— 界面上看到的
                 始终是和卫星图对得上的剪影，校正只发生在导出的标记图里。
        Returns: (标记图路径, sidecar 路径)
        """
        self.out_dir.mkdir(parents=True, exist_ok=True)
        imwrite_unicode(self.labels_file, self.labels)  # 类别图（无损）
        self._save_meta()
        lab, blds = self.corrected_labels() if correct else (self.labels, self.building_list())
        rgba = self.lut[lab]  # 类别图 → 彩色标记图（未标记透明）
        r = max(5, int(round(1.4 / self.mpp)))  # 圆点半径 ≈ 1.4m，至少 5px（map2scene 要求点面积 ≥ 4px）
        for d in self.dots:  # 门 / 出入口画成实心圆点，不抗锯齿（颜色要纯）
            cv2.circle(rgba, (int(d["x"]), int(d["y"])), r, (*hex_bgr(DOT_COLORS[d["kind"]]), 255), -1, cv2.LINE_8)
        imwrite_unicode(self.marks_file, rgba)
        # sidecar: 知道层数的楼，给 map2scene 一个落在墙脚里的点 + 层数
        side = {"buildings": [{"at": b["at"], "floors": b["floors"]} for b in blds if b["floors"]]}
        self.sidecar_file.write_text(json.dumps(side, ensure_ascii=False, indent=1), "utf-8")
        return self.marks_file, self.sidecar_file

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

    # --- 后台任务 ---
    def start_job(self, name, fn):
        """
        在后台线程里跑 fn(progress)。自动找建筑要几十秒，不能卡住 HTTP 请求；界面轮询 /job 看进度。
        同一时间只跑一个任务。fn 返回的字符串作为完成消息。
        """
        if self.job["running"]:
            return {"error": f"「{self.job['name']}」还在跑，等它结束"}
        self.job = {"name": name, "running": True, "done": 0, "total": 0, "msg": "", "error": None}  # 新任务从零开始

        def progress(done, total, msg=""):
            """任务里调它更新进度"""
            self.job.update(done=done, total=total, msg=msg)

        def run():
            try:
                self.job["msg"] = fn(progress) or ""
            except Exception as e:  # 出错也要把 running 置回去，界面才能再点
                import traceback
                traceback.print_exc()
                self.job["error"] = f"{type(e).__name__}: {e}"
            finally:
                self.job["running"] = False

        threading.Thread(target=run, daemon=True).start()  # daemon: 关掉工具时不用等它
        return {"started": True}

    # --- 自动建筑候选 ---
    def run_auto_buildings(self, progress, stride=40):
        """
        全图自动找建筑候选（后台任务）。有 SAM 用 SAM 的「按提示点分割」，没有就用颜色连通块兜底。
        交互点选用的 predictor 缓存着当前窗口的图像编码，这里另开一个，互不干扰。
        """
        seg = self.backend.make_segment_all() if isinstance(self.backend, SamBackend) else None  # None = 颜色连通块兜底
        t0 = time.time()  # 计时，完成消息里报用时
        found = sg.find_buildings(self.img, self.mpp, seg, stride=stride, progress=lambda a, b: progress(a, b, f"第 {a}/{b} 块"))
        # 只存界面和接受时用得到的字段；crop 是 (x0, y0, 子掩膜)，几百个候选也就几 MB
        cands = [dict(id=i, crop=c["crop"], score=round(c["score"], 3), area_m2=round(c["feats"]["area_m2"]), state="pending")
                 for i, c in enumerate(found)]
        with self.lock:
            self.cands = cands
            with open(self.cands_file, "wb") as f:  # 缓存，下次打开直接用
                pickle.dump({"shape": (self.h, self.w), "cands": cands}, f)
        return f"找到 {len(cands)} 个候选，用时 {time.time() - t0:.0f}s"

    def cand_list(self):
        """
        给界面画的候选轮廓: 只列 pending 的，而且已经被标成建筑的（超过一半像素）不再列出。
        轮廓用 approxPolyDP 简化到 1 像素，几百个候选的 json 也就几十 KB。
        """
        bld = np.isin(self.labels, list(BUILDING_IDS))  # 当前已标成建筑的像素
        out = []
        for c in self.cands:
            if c["state"] != "pending":
                continue
            x0, y0, sub = c["crop"]
            if (bld[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]] & sub).sum() > 0.5 * sub.sum():
                continue  # 已经标过了
            cnts, _ = cv2.findContours(sub.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not cnts:
                continue
            cnt = cv2.approxPolyDP(max(cnts, key=cv2.contourArea), 1.0, True).reshape(-1, 2) + [x0, y0]  # 转回全图坐标
            out.append({"id": c["id"], "score": c["score"], "area_m2": c["area_m2"], "poly": cnt.tolist()})
        return out

    def cand_accept(self, ids, cls, protect=True):
        """把一批候选涂成类别 cls。并成一个掩膜一次涂完 = 一步撤销（「全部接受」按一次 Ctrl+Z 就能撤回）"""
        want = set(ids)  # 集合查找快
        mask = np.zeros((self.h, self.w), bool)  # 这批候选的并集
        for c in self.cands:
            if c["id"] in want and c["state"] == "pending":
                x0, y0, sub = c["crop"]
                mask[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]] |= sub
                c["state"] = "accepted"
        return self.paint(mask, cls, protect)

    def cand_reject(self, ids):
        """标成 rejected，不再显示"""
        want = set(ids)
        for c in self.cands:
            if c["id"] in want:
                c["state"] = "rejected"

    # --- 楼 / 层数 / 倾斜校正 ---
    def building_list(self, labels=None):
        """
        当前标注里的每栋楼 = 每个建筑类别各自的连通块（面积 ≥ 20 像素）。
        Returns: [{cls, crop: (x0, y0, 子掩膜), at: 块内离边最远的点 [x, y], floors: 层数或 None}]
        层数: 落在这栋楼里的 floors 记录，手填的优先，都有就取最大（两栋挨着的楼连成一块时，按高的算）。
        """
        lab = self.labels if labels is None else labels  # 后台任务传快照进来
        out = []
        for cls in sorted(BUILDING_IDS):  # 各建筑类别分开算连通块: 商铺挨着住宅也算两栋
            m = (lab == cls).astype(np.uint8)
            if not m.any():
                continue
            n, cc, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
            for i in range(1, n):
                x, y, bw, bh, area = stats[i]
                if area < 20:
                    continue
                sub = cc[y:y + bh, x:x + bw] == i
                d = cv2.distanceTransform(np.pad(sub, 1).astype(np.uint8), cv2.DIST_L2, 3)[1:-1, 1:-1]  # 补一圈 0，贴边的也算边界
                j = int(d.argmax())
                out.append({"cls": cls, "crop": (int(x), int(y), sub), "at": [int(x + j % bw), int(y + j // bw)], "floors": None})
        # 层数记录按点归属
        for b in out:
            x0, y0, sub = b["crop"]
            got = {"manual": [], "auto": []}  # 按来源分开收集
            for f in self.floors:
                fx, fy = int(f["x"]) - x0, int(f["y"]) - y0
                if 0 <= fy < sub.shape[0] and 0 <= fx < sub.shape[1] and sub[fy, fx]:
                    got[f.get("src", "manual")].append(int(f["floors"]))
            pick = got["manual"] or got["auto"]  # 手填的覆盖影子估的
            b["floors"] = max(pick) if pick else None
        return out

    def cal_vectors(self):
        """把 calib（点 + 层数）换成 satgeo 用的倾斜 / 影子向量；没校准返回 None"""
        c = self.calib
        if not c:
            return None
        return sg.calibrate(c["base"], c["roof"], c.get("tip"), c["floors"] * self.floor_h)

    def run_heights(self, progress):
        """
        后台任务: 用影子给每栋楼估层数。需要校准里有影子尖点。估出来的记为 src='auto'，
        之前的 auto 记录全部替换，手填的（manual）保留。看不出影子的楼不写记录，导出时按同类中位数补。
        """
        cal = self.cal_vectors()
        if not cal or cal["s"] is None:
            raise ValueError("先用「校准」工具点墙脚 → 屋顶 → 影子尖，并填层数")
        with self.lock:
            labels = self.labels.copy()  # 快照: 估算期间用户继续编辑也不影响
        shadow, thr = sg.shadow_mask(self.img)  # 严格的「真阴影」，背光树冠不算
        occ = np.isin(labels, list(BUILDING_IDS))  # 影子落在楼上的部分不算
        blds = self.building_list(labels)
        res = []  # 新的 auto 记录
        for k, b in enumerate(blds):
            h, _ = sg.estimate_height(b["crop"], shadow, cal, occ)  # 米；看不出影子时是 None
            if h:
                res.append({"x": b["at"][0], "y": b["at"][1], "floors": max(1, int(round(h / self.floor_h))), "src": "auto"})
            progress(k + 1, len(blds), f"{k + 1}/{len(blds)} 栋")
        with self.lock:
            self.floors = [f for f in self.floors if f.get("src") == "manual"] + res
            self._save_meta()
        return f"{len(res)}/{len(blds)} 栋估出了层数（阴影阈值 {thr:.0f}）"

    def set_floors(self, x, y, floors):
        """
        手填某栋楼的层数: 先删掉落在同一栋楼里（或 6 像素内）的所有记录，floors > 0 再加一条 manual。
        floors = 0 就是「清掉这栋的层数」，回到影子估算 / 默认值。
        """
        hit = None
        for b in self.building_list():
            x0, y0, sub = b["crop"]
            if 0 <= y - y0 < sub.shape[0] and 0 <= x - x0 < sub.shape[1] and sub[int(y - y0), int(x - x0)]:
                hit = b
                break

        def same(f):
            """这条记录是不是属于被点的那栋楼"""
            if hit:
                x0, y0, sub = hit["crop"]
                fx, fy = int(f["x"]) - x0, int(f["y"]) - y0
                if 0 <= fy < sub.shape[0] and 0 <= fx < sub.shape[1] and sub[fy, fx]:
                    return True
            return math.hypot(f["x"] - x, f["y"] - y) < 6

        self.floors = [f for f in self.floors if not same(f)]  # 同一栋的旧记录（auto 或 manual）都清掉
        if floors > 0:
            self.floors.append({"x": float(x), "y": float(y), "floors": int(floors), "src": "manual"})
        self._save_meta()
        return self.floors

    def corrected_labels(self):
        """
        倾斜校正: 每栋楼的剪影换成墙脚（satgeo.footprint），立面那一条让出来变成未标记（= 人行 / 地块）。
        楼高 = 层数 × 层高；没有层数的楼用同类楼层数的中位数（一个小区的楼大多差不多高），同类都没有就不校正。
        墙脚被腐蚀得不到剪影 30% 的（层数填错了）也不校正，宁可偏大不要丢楼。
        Returns: (校正后的类别图, building_list，at 点已挪进墙脚)
        """
        blds = self.building_list()
        cal = self.cal_vectors()
        v = cal["v"] if cal else (0.0, 0.0)  # 倾斜向量（像素/米）
        if not (v[0] or v[1]):
            return self.labels, blds  # 没校准 / 正射图: 剪影就是墙脚
        # 同类中位数: 层数和占地面积各一个。中位数只借给「个头差不多」的楼（面积 ≥ 同类中位面积的 40%），
        # 否则一块没接好的碎片（屋顶设备、半栋楼）也会被当成 19 层，出来一根细高的「铅笔楼」
        med, med_area = {}, {}
        for cls in BUILDING_IDS:
            known = [b for b in blds if b["cls"] == cls and b["floors"]]
            med[cls] = int(np.median([b["floors"] for b in known])) if known else None
            med_area[cls] = float(np.median([b["crop"][2].sum() for b in known])) if known else 0.0
        out = self.labels.copy()
        for b in blds:
            fl = b["floors"]
            if not fl and med[b["cls"]] and b["crop"][2].sum() >= 0.4 * med_area[b["cls"]]:
                fl = med[b["cls"]]  # 借同类中位数
            if not fl:
                continue
            x0, y0, sub = b["crop"]
            foot = sg.footprint(sub, v, fl * self.floor_h)  # 沿 −v 腐蚀 楼高 × |v| 像素
            if foot.sum() < 0.3 * sub.sum():
                continue
            win = out[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]]
            win[sub & ~foot] = 0  # 立面让出来
            d = cv2.distanceTransform(np.pad(foot, 1).astype(np.uint8), cv2.DIST_L2, 3)[1:-1, 1:-1]
            j = int(d.argmax())
            b["at"] = [int(x0 + j % sub.shape[1]), int(y0 + j // sub.shape[1])]  # sidecar 的点要落在墙脚里
            b["floors"] = fl
            b["foot"] = (x0, y0, foot)
        return out, blds

    def footprint_polys(self):
        """界面预览用: 校正后每栋楼的墙脚轮廓 + 层数"""
        _, blds = self.corrected_labels()  # 和导出同一套计算，预览看到的就是导出的
        out = []
        for b in blds:
            if "foot" not in b:
                continue
            x0, y0, foot = b["foot"]
            cnts, _ = cv2.findContours(foot.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if cnts:
                out.append({"poly": (cv2.approxPolyDP(max(cnts, key=cv2.contourArea), 1.0, True).reshape(-1, 2) + [x0, y0]).tolist(), "floors": b["floors"]})
        return out


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
                                   "dotColors": DOT_COLORS, "backend": S.backend.name, "isSam": isinstance(S.backend, SamBackend),
                                   "calib": S.calib, "floorH": S.floor_h, "floors": S.floors, "buildingIds": sorted(BUILDING_IDS)})
            if p == "/job":  # 后台任务进度（界面每秒轮询）
                return self._send(S.job)
            if p == "/cands":  # 待确认的建筑候选轮廓
                with S.lock:
                    return self._send({"cands": S.cand_list()})
            if p == "/footprints":  # 倾斜校正后的墙脚轮廓（预览）
                with S.lock:
                    return self._send({"feet": S.footprint_polys()})
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
              /export     保存并（可选）直接调 map2scene 生成 public/scenes/<name>.json；correct=倾斜校正
              /auto_buildings  后台任务: 全图自动找建筑候选；/cand_accept /cand_reject 接受 / 丢掉候选
              /calib      倾斜 / 影子校准；/heights 后台任务: 按影子估每栋楼层数；/floors 手填某栋层数
              /mpp_zoom   按纬度 + 地图缩放级别设比例尺
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
                marks, side = S.save(correct=q.get("correct", True))
                res = {"ok": True, "marks": str(marks)}
                if q.get("scene"):  # 顺带生成场景
                    name = q.get("name") or S.stem
                    scene = project / "public" / "scenes" / f"{name}.json"
                    preview = S.out_dir / f"{S.stem}_scene_preview.png"
                    cmd = [sys.executable, str(HERE / "map2scene.py"), str(marks), "-o", str(scene), "--mpp", str(S.mpp), "--debug", str(preview),
                           "--site", q.get("site", "auto"), "--sidecar", str(side)]
                    pr = subprocess.run(cmd, capture_output=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"})  # 同步跑，几秒钟；子进程输出统一 UTF-8
                    log = (pr.stderr or b"").decode("utf-8", "replace")
                    res.update({"scene": str(scene), "sceneName": name, "log": log, "returncode": pr.returncode, "preview": preview.exists()})
                return res
            if p == "/auto_buildings":  # 后台跑，界面轮询 /job，结束后取 /cands
                stride = int(q.get("stride", 40))
                return S.start_job("自动找建筑", lambda prog: S.run_auto_buildings(prog, stride))
            if p == "/cand_accept":  # ids: 候选编号列表；cls: 涂成哪个建筑类别；返回一个 patch（整批一步撤销）
                return {"ok": True, "patch": S.cand_accept(q["ids"], int(q["cls"]), q.get("protect", True))}
            if p == "/cand_reject":  # 丢掉的候选只是标记为 rejected，缓存里还在，不影响撤销
                S.cand_reject(q["ids"])
                return {"ok": True}
            if p == "/calib":  # 校准存进 marks.json，重开工具还在
                # base / roof / tip 都是图像像素坐标；tip 可以是 null（没有明显影子，只做倾斜校正）
                S.calib = {"base": q["base"], "roof": q["roof"], "tip": q.get("tip"), "floors": int(q["floors"])}
                if q.get("floorH"):
                    S.floor_h = float(q["floorH"])
                S._save_meta()
                return {"ok": True, "calib": S.calib, "vectors": S.cal_vectors()}
            if p == "/heights":  # 几十栋楼 CPU 上十几秒，也放后台
                return S.start_job("估算楼高", S.run_heights)
            if p == "/floors":  # 层数工具: 点哪栋改哪栋，floors=0 清除
                return {"ok": True, "floors": S.set_floors(float(q["x"]), float(q["y"]), int(q["floors"]))}
            if p == "/mpp_zoom":  # 网络地图截图: 纬度 + 缩放级别 → 米/像素
                S.mpp = sg.mpp_from_zoom(float(q["lat"]), float(q["zoom"]), float(q.get("scale", 1)))
                S._save_meta()
                return {"ok": True, "mpp": S.mpp}
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
