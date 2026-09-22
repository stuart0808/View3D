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
import base64
import json
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent

# id 0 = 未标记。颜色必须与 map2scene.py 的 DEFAULT_MARKERS 一致。
CLASSES = [
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
DOT_COLORS = {"door": "#FFFF00", "portal": "#00FFFF"}
BUILDING_IDS = {1, 2, 3, 11, 12}


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
    name = "漫水填充（未检测到 torch/ultralytics）"

    def __init__(self, img):
        self.lab = cv2.cvtColor(cv2.bilateralFilter(img, 9, 40, 9), cv2.COLOR_BGR2Lab)

    def segment(self, points, tol=10):
        """每个正样本点漫水填充后并进结果，负样本点填充的区域从结果里减掉；tol 是 Lab 三通道的容差"""
        h, w = self.lab.shape[:2]
        out = np.zeros((h, w), bool)
        for x, y, lab in points:
            m = np.zeros((h + 2, w + 2), np.uint8)
            cv2.floodFill(self.lab.copy(), m, (int(x), int(y)), 0, (tol,) * 3, (tol,) * 3, 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8))
            m = m[1:-1, 1:-1] > 0
            out = (out | m) if lab else (out & ~m)
        return out


class SamBackend:
    """
    ultralytics 封装的 SAM / SAM2 / MobileSAM。
    SAM 内部会把长边缩到 1024，整张大卫星图直接喂进去小房子就糊了，
    所以按点击位置取 tile×tile 的窗口做推理；窗口的图像编码会缓存，同一窗口内的后续点击只跑轻量解码器。
    """

    def __init__(self, img, model, device, tile=1024):
        import torch  # noqa: F401
        from ultralytics.models import sam as usam

        self.img = img
        self.tile = tile
        self.win = None
        is_sam2 = "sam2" in Path(model).name.lower()
        cls = usam.SAM2Predictor if is_sam2 and hasattr(usam, "SAM2Predictor") else usam.Predictor
        self.predictor = cls(overrides=dict(conf=0.25, task="segment", mode="predict", imgsz=1024, model=model, device=device, save=False, verbose=False))
        self.name = f"{Path(model).stem} @ {device}"

    def _window_for(self, points):
        """决定推理窗口: 图不大就整张；点都落在当前窗口内部（留 12% 边）就复用；否则以第一个点为中心开新窗"""
        h, w = self.img.shape[:2]
        t = self.tile
        if max(h, w) <= t * 1.4:
            return (0, 0, w, h)
        if self.win:
            x0, y0, x1, y1 = self.win
            mx, my = (x1 - x0) * 0.12, (y1 - y0) * 0.12
            if all(x0 + mx <= p[0] <= x1 - mx and y0 + my <= p[1] <= y1 - my for p in points):
                return self.win
        px, py = points[0][0], points[0][1]
        x0 = int(min(max(px - t / 2, 0), max(0, w - t)))
        y0 = int(min(max(py - t / 2, 0), max(0, h - t)))
        return (x0, y0, min(w, x0 + t), min(h, y0 + t))

    def segment(self, points, tol=None):
        """窗口变了才重新编码图像；多个候选掩膜取置信度最高的；结果放回整图坐标"""
        win = self._window_for(points)
        if win != self.win:
            x0, y0, x1, y1 = win
            self.predictor.reset_image()
            self.predictor.set_image(np.ascontiguousarray(self.img[y0:y1, x0:x1]))
            self.win = win
        x0, y0, x1, y1 = self.win
        pts = [[[float(p[0] - x0), float(p[1] - y0)] for p in points]]
        labs = [[int(p[2]) for p in points]]
        res = self.predictor(points=pts, labels=labs)
        out = np.zeros(self.img.shape[:2], bool)
        if res and res[0].masks is not None and len(res[0].masks.data):
            data = res[0].masks.data
            k = 0
            conf = getattr(res[0].boxes, "conf", None)
            if conf is not None and len(conf) == len(data):
                k = int(conf.argmax())
            m = data[k].cpu().numpy().astype(bool)
            if m.shape != (y1 - y0, x1 - x0):
                m = cv2.resize(m.astype(np.uint8), (x1 - x0, y1 - y0), interpolation=cv2.INTER_NEAREST) > 0
            out[y0:y1, x0:x1] = m
        return out


def make_backend(img, args):
    """按环境选后端: --no-sam / 没装 torch → 漫水填充；有 CUDA → sam2.1_l，只有 CPU → mobile_sam；SAM 初始化失败也退回漫水填充"""
    if args.no_sam:
        return FloodBackend(img)
    try:
        import torch
        import ultralytics  # noqa: F401
    except ImportError:
        print("[sat2marks] 未安装 torch/ultralytics → 退化为漫水填充。需要 SAM 请: pip install torch ultralytics")
        return FloodBackend(img)
    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    model = args.model or ("sam2.1_l.pt" if device.startswith("cuda") else "mobile_sam.pt")
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
        return mask
    n, lab = cv2.connectedComponents(m, connectivity=8)
    keep = {int(lab[int(p[1]), int(p[0])]) for p in points if p[2] and 0 <= int(p[1]) < lab.shape[0] and 0 <= int(p[0]) < lab.shape[1]} - {0}
    if keep:
        m = np.isin(lab, list(keep)).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    m = cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_CLOSE, k), cv2.MORPH_OPEN, k)
    if is_building:  # 屋顶上的天窗、设备会在掩膜里留洞，建筑一律填实
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        m = np.zeros_like(m)
        cv2.drawContours(m, cnts, -1, 1, -1)
    return m > 0


def auto_vegetation(img, mpp, thr=0.06, min_area_m2=25.0, park_area_m2=1500.0, park_width_m=18.0):
    """
    过绿指数 ExG = 2g - r - b（色度归一化后）提植被。大而宽的连通块算公园，其余算绿化带。
    返回 (green_mask, park_mask)。秋天变黄/变红的树会漏，阴影里的会漏一部分 —— 这是初稿，需要人看一眼。
    """
    f = img.astype(np.float32) + 1.0
    s = f.sum(-1)
    b, g, r = f[..., 0] / s, f[..., 1] / s, f[..., 2] / s
    exg = 2 * g - r - b
    veg = ((exg > thr) & (g > r) & (g > b) & (img.max(-1) > 28)).astype(np.uint8)
    k1 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    kc = max(3, int(round(1.5 / mpp)) | 1)
    veg = cv2.morphologyEx(cv2.morphologyEx(veg, cv2.MORPH_OPEN, k1), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kc, kc)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(veg, connectivity=8)
    green = np.zeros(veg.shape, bool)
    park = np.zeros(veg.shape, bool)
    dt = cv2.distanceTransform(veg, cv2.DIST_L2, 3)
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA] * mpp * mpp
        if area < min_area_m2:
            continue
        comp = lab == i
        if area >= park_area_m2 and float(dt[comp].max()) * 2 * mpp >= park_width_m:
            park |= comp
        else:
            green |= comp
    return green, park


# ----------------------------------------------------------------------------
# 会话状态
# ----------------------------------------------------------------------------
class Session:
    """一张图的标注状态。labels 是 uint8 类别图（0 = 未标记），所有编辑都经过 paint() 以便撤销"""

    def __init__(self, image_path, args):
        self.path = Path(image_path)
        self.img = imread_unicode(self.path)
        self.h, self.w = self.img.shape[:2]
        self.mpp = args.mpp or ((args.width_m / self.w) if args.width_m else 0.3)
        self.out_dir = Path(args.out_dir) if args.out_dir else self.path.parent
        self.stem = self.path.stem
        self.labels = np.zeros((self.h, self.w), np.uint8) # 每像素类别 id
        self.dots = [] # [{kind: door|portal, x, y}]
        self.undo = [] # 撤销栈: ('patch', x0, y0, 旧像素块) 或 ('dot',)
        self.preview = None # 分割出来但还没提交的掩膜
        self.preview_points = []
        self.lock = threading.Lock()
        self.backend = make_backend(self.img, args)
        self._load()
        self.lut = np.zeros((256, 4), np.uint8) # 类别 id → BGRA，未标记透明
        for c in CLASSES:
            self.lut[c["id"]] = (*hex_bgr(c["color"]), 255)

    # --- 断点续标 ---
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
            lab = cv2.imdecode(np.fromfile(str(self.labels_file), np.uint8), cv2.IMREAD_GRAYSCALE)
            if lab is not None and lab.shape == self.labels.shape:
                self.labels = lab
                meta = json.loads(self.meta_file.read_text("utf-8"))
                self.dots = meta.get("dots", [])
                self.mpp = meta.get("mpp", self.mpp)
                print(f"[sat2marks] 已载入上次的标注 {self.labels_file.name}")

    def save(self):
        """写 labels.png / marks.json，并渲染 map2scene 用的标记图（类别色 + 门 / 出入口圆点），返回标记图路径"""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        imwrite_unicode(self.labels_file, self.labels)
        self.meta_file.write_text(json.dumps({"mpp": self.mpp, "dots": self.dots, "image": self.path.name}, ensure_ascii=False, indent=2), "utf-8")
        rgba = self.lut[self.labels]
        r = max(5, int(round(1.4 / self.mpp)))
        for d in self.dots:
            cv2.circle(rgba, (int(d["x"]), int(d["y"])), r, (*hex_bgr(DOT_COLORS[d["kind"]]), 255), -1, cv2.LINE_8)
        imwrite_unicode(self.marks_file, rgba)
        return self.marks_file

    # --- 编辑 ---
    def _push_undo(self, x0, y0, x1, y1):
        """把即将被改的矩形块存进撤销栈（最多 60 步）"""
        self.undo.append(("patch", x0, y0, self.labels[y0:y1, x0:x1].copy()))
        del self.undo[:-60]

    def paint(self, mask, cls, protect_buildings=False):
        """把掩膜范围涂成类别 cls（0 = 擦除）。protect_buildings: 涂道路 / 绿地时不覆盖已标的建筑。返回被改区域的 patch"""
        ys, xs = np.nonzero(mask)
        if not len(xs):
            return None
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        self._push_undo(x0, y0, x1, y1)
        sub = mask[y0:y1, x0:x1]
        if protect_buildings and cls not in BUILDING_IDS and cls != 0:
            sub = sub & ~np.isin(self.labels[y0:y1, x0:x1], list(BUILDING_IDS))
        self.labels[y0:y1, x0:x1][sub] = cls
        return self.patch(x0, y0, x1, y1)

    def patch(self, x0, y0, x1, y1):
        """一块矩形区域的标记层渲染成 PNG（base64），前端只重绘这一块"""
        ok, buf = cv2.imencode(".png", self.lut[self.labels[y0:y1, x0:x1]])
        return {"bbox": [x0, y0, x1 - x0, y1 - y0], "png": base64.b64encode(buf).decode()}

    def full_png(self):
        """整张标记层 PNG（页面初始化 / 整体重载时用）"""
        return cv2.imencode(".png", self.lut[self.labels])[1].tobytes()

    def do_undo(self):
        """撤销一步: 点 → 弹出最后一个点；像素块 → 写回旧值并返回 patch"""
        if not self.undo:
            return {"ok": False}
        item = self.undo.pop()
        if item[0] == "dot":
            self.dots.pop()
            return {"ok": True, "dots": self.dots}
        _, x0, y0, old = item
        self.labels[y0:y0 + old.shape[0], x0:x0 + old.shape[1]] = old
        return {"ok": True, "patch": self.patch(x0, y0, x0 + old.shape[1], y0 + old.shape[0])}


# ----------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------
def make_handler(S: Session, args):
    """生成绑定了会话的请求处理类。所有 POST 在会话锁内执行（分割和涂色都会改状态）"""
    project = HERE.parent

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, body, ctype="application/json", code=200):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            p = self.path.split("?")[0]
            if p == "/":
                return self._send((HERE / "sat2marks_ui.html").read_bytes(), "text/html; charset=utf-8")
            if p == "/image":
                return self._send(cv2.imencode(".jpg", S.img, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tobytes(), "image/jpeg")
            if p == "/labels.png":
                with S.lock:
                    return self._send(S.full_png(), "image/png")
            if p == "/preview.png":
                f = S.out_dir / f"{S.stem}_scene_preview.png"
                return self._send(f.read_bytes(), "image/png") if f.exists() else self._send({"error": "no preview"}, code=404)
            if p == "/state":
                return self._send({"name": S.stem, "width": S.w, "height": S.h, "mpp": S.mpp, "classes": CLASSES, "dots": S.dots,
                                   "dotColors": DOT_COLORS, "backend": S.backend.name, "isSam": isinstance(S.backend, SamBackend)})
            self._send({"error": "not found"}, code=404)

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            q = json.loads(self.rfile.read(n) or b"{}")
            p = self.path
            try:
                with S.lock:
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
                pts = [(min(max(x, 0), S.w - 1), min(max(y, 0), S.h - 1), int(l)) for x, y, l in q["points"]]
                if not any(l for *_, l in pts):
                    return {"empty": True}
                t0 = time.time()
                mask = S.backend.segment(pts, tol=q.get("tol", 10))
                mask = tidy_mask(mask, pts, int(q.get("cls", 0)) in BUILDING_IDS)
                S.preview = mask
                ys, xs = np.nonzero(mask)
                if not len(xs):
                    return {"empty": True, "ms": int((time.time() - t0) * 1000)}
                x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
                rgba = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
                rgba[mask[y0:y1, x0:x1]] = (255, 255, 255, 255)
                png = cv2.imencode(".png", rgba)[1]
                return {"bbox": [x0, y0, x1 - x0, y1 - y0], "png": base64.b64encode(png).decode(), "ms": int((time.time() - t0) * 1000),
                        "area_m2": round(float(mask.sum()) * S.mpp ** 2, 1)}
            if p == "/commit":
                if S.preview is None:
                    return {"ok": False}
                out = S.paint(S.preview, int(q["cls"]), q.get("protect", True))
                S.preview = None
                return {"ok": True, "patch": out}
            if p in ("/polygon", "/polyline"):
                mask = np.zeros((S.h, S.w), np.uint8)
                pts = np.array(q["points"], np.float64).round().astype(np.int32).reshape(-1, 1, 2)
                if p == "/polygon":
                    cv2.fillPoly(mask, [pts], 1)
                else:
                    cv2.polylines(mask, [pts], False, 1, max(1, int(round(q["width_m"] / S.mpp))), cv2.LINE_8)
                return {"ok": True, "patch": S.paint(mask > 0, int(q["cls"]), q.get("protect", True))}
            if p == "/dot":
                S.dots.append({"kind": q["kind"], "x": float(q["x"]), "y": float(q["y"])})
                S.undo.append(("dot",))
                return {"ok": True, "dots": S.dots}
            if p == "/undo":
                return S.do_undo()
            if p == "/mpp":
                S.mpp = float(q["mpp"])
                return {"ok": True, "mpp": S.mpp}
            if p == "/auto_veg":
                green, park = auto_vegetation(S.img, S.mpp, thr=float(q.get("thr", 0.06)))
                free = S.labels == 0
                S._push_undo(0, 0, S.w, S.h)
                S.labels[green & free] = 5
                S.labels[park & free] = 6
                return {"ok": True, "reload": True, "green_m2": round(float((green & free).sum()) * S.mpp ** 2), "park_m2": round(float((park & free).sum()) * S.mpp ** 2)}
            if p == "/clear_class":
                cls = int(q["cls"])
                S._push_undo(0, 0, S.w, S.h)
                S.labels[S.labels == cls] = 0
                return {"ok": True, "reload": True}
            if p == "/export":
                marks = S.save()
                res = {"ok": True, "marks": str(marks)}
                if q.get("scene"):
                    name = q.get("name") or S.stem
                    scene = project / "public" / "scenes" / f"{name}.json"
                    preview = S.out_dir / f"{S.stem}_scene_preview.png"
                    cmd = [sys.executable, str(HERE / "map2scene.py"), str(marks), "-o", str(scene), "--mpp", str(S.mpp), "--debug", str(preview), "--site", q.get("site", "auto")]
                    pr = subprocess.run(cmd, capture_output=True)
                    log = (pr.stderr or b"").decode("utf-8", "replace") if b"\xe5" in (pr.stderr or b"") else (pr.stderr or b"").decode("gbk", "replace")
                    res.update({"scene": str(scene), "sceneName": name, "log": log, "returncode": pr.returncode, "preview": preview.exists()})
                return res
            return {"error": "unknown route"}

    return H


def main():
    """命令行入口: 建会话、起本地 HTTP 服务、打开浏览器"""
    ap = argparse.ArgumentParser(description="卫星图半自动标注 → 标记图层（供 map2scene.py 使用）", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("image")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--mpp", type=float, help="米/像素。不知道的话先随便给，进界面用「标尺」量一段已知距离来校准")
    g.add_argument("--width-m", type=float, help="整张图宽度对应的米数")
    ap.add_argument("--out-dir", help="标注输出目录，默认与图片同目录")
    ap.add_argument("--model", help="ultralytics 支持的 SAM 权重名或路径: mobile_sam.pt / sam_b.pt / sam_l.pt / sam2.1_t.pt / sam2.1_l.pt …")
    ap.add_argument("--device", help="cuda / cuda:0 / cpu，默认自动")
    ap.add_argument("--no-sam", action="store_true", help="强制使用漫水填充")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    S = Session(args.image, args)
    print(f"[sat2marks] 图片 {S.w}x{S.h}px, {S.mpp:.3f} m/px, 分割后端: {S.backend.name}")
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(S, args))
    url = f"http://127.0.0.1:{args.port}/"
    print(f"[sat2marks] 打开 {url}   (Ctrl+C 退出，标注会在「导出」时保存到 {S.out_dir})")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[sat2marks] 退出")


if __name__ == "__main__":
    main()
