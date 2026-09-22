#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
drawscene.py —— 场景编辑器（editor/，地址 /editor/）画的矢量图 → scene.json。

不另写一套「矢量 → 路网」的逻辑，而是把矢量图画成和手工标记完全一样的标记图，交给现成的 map2scene:
路网骨架、路口归正、斑马线、红绿灯、人行区域、店门、停车位……全部复用，行为和其他来源的场景一致。
标记图表达不了的信息走 sidecar:
    footprints   每栋楼的轮廓 + 类型 + 层数 + 编号和属性（挨着画的楼不会被涂色合并成一栋，层数也不会被随机化；
                 编号沿用原场景的，实地标注按编号挂的数据重新生成后还对得上）
    junctions    路口设置: 有没有红绿灯、两个方向的绿灯时长、禁止左转（map2scene 按位置对到路口节点上）
    roads        每条路的中心线 + 路宽 + 每方向车道数 + 是否单行（map2scene 按几何重合对到骨架边上）

矢量图格式（坐标都是场景米: 原点在画布中心，x 向东、y 向南，和 scene.json 一致）:
    {
      "version": 1, "widthM": 400, "heightM": 300,
      "roads":     [{"points": [[x, y], ...], "lanes": 每方向车道数, "oneway": 布尔（按点序行驶）,
                     "width": 路宽米（可省，按车道数算）, "elevated": 布尔}],
      "buildings": [{"polygon": [[x, y], ...], "kind": shop|block|residential|venue, "floors": 层数,
                     "id": 可选，沿用原场景的楼编号, "venue": 可选 {name, type, capacity},
                     "attraction" / "shops" / "name": 可选，原样写进场景（实地标注写回的数据）}],
      "areas":     [{"polygon": [[x, y], ...], "kind": green|park|water|plaza|parking}],
      "doors":     [{"pos": [x, y]}],
      "portals":   [{"pos": [x, y]}],
      "junctions": [{"pos": [x, y], "control": "signal" | "none", "green": [东西向秒, 南北向秒] 可选, "noLeft": 布尔}],
      "background": 可选 {"url": 同目录的底图文件名} 或 {"dataUrl": "data:image/...;base64,..."},
      "origin":    可选，从带经纬度的场景改出来时原样带上（{geo, summary: {width, height, mpp}}），实地标注的定位还能用
    }
"""
import base64
import json  # 矢量图 / sidecar / 场景都是 JSON
import math  # 向上取整算像素尺寸
import os  # 子进程环境变量
import re  # 校验底图 data URL 和文件名
import subprocess  # 跑 map2scene 子进程
import sys  # 当前 Python 解释器
import time  # 计时
from pathlib import Path

import cv2  # 画标记图
import numpy as np  # 坐标数组

TOOLS = Path(__file__).resolve().parents[2] / "tools"  # 仓库的 tools/: map2scene.py 和标记调色板在那里
LANE_W = 3.5  # 按车道数算路宽时每条车道的宽度（米）
MAX_PX = 4000  # 标记图长边最多这么多像素，大画布自动降分辨率
BUILDING_KINDS = {"shop", "block", "residential", "venue"}  # 和 map2scene / 前端 buildings.js 的 kind 一致
AREA_KINDS = {"green", "park", "water", "plaza", "parking"}


def palette():
    """标记调色板: (layer, kind) → BGR 颜色；和 map2scene 读的是同一个文件，改颜色两边自动一致"""
    out = {}  # (layer, kind) → BGR
    for m in json.loads((TOOLS / "markers.default.json").read_text("utf-8")):
        h = m["color"].lstrip("#")
        rgb = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))  # 十六进制颜色 → RGB
        out[(m["layer"], m.get("kind"))] = rgb[::-1]  # OpenCV 用 BGR
    return out  # 调色板


def road_width(r):
    """路宽（米）: 画的时候给了就用，否则 = 车道数 × 3.5 米（双向乘 2）"""
    if r.get("width"):
        return float(r["width"])
    n = max(1, int(r.get("lanes") or 1))  # 每方向车道数，至少 1 条
    return n * LANE_W * (1 if r.get("oneway") else 2)


def _pts(v, need, what):
    """校验一串坐标: 至少 need 个点、每个点两个有限数；返回 (N, 2) float 数组"""
    a = np.asarray(v, np.float64)  # 统一成数组
    if a.ndim != 2 or a.shape[1] != 2 or len(a) < need or not np.isfinite(a).all():
        raise ValueError(f"{what} 至少要 {need} 个点")
    return a


def validate(d):
    """检查矢量图，不合法抛 ValueError（中文提示直接给前端）"""
    if not isinstance(d, dict):
        raise ValueError("格式不对")
    w, h = d.get("widthM"), d.get("heightM")  # 画布宽高（米）
    if not all(isinstance(v, (int, float)) and 20 <= v <= 3000 for v in (w, h)):
        raise ValueError("画布宽高要在 20 ~ 3000 米之间")
    if not d.get("roads") and not d.get("buildings"):
        raise ValueError("至少画一条路或一栋楼")
    for r in d.get("roads", []):
        _pts(r.get("points"), 2, "道路")
    for b in d.get("buildings", []):
        _pts(b.get("polygon"), 3, "建筑")
        if b.get("kind") not in BUILDING_KINDS:
            raise ValueError(f"不认识的建筑类型 {b.get('kind')}")
    for a in d.get("areas", []):
        _pts(a.get("polygon"), 3, "区域")
        if a.get("kind") not in AREA_KINDS:
            raise ValueError(f"不认识的区域类型 {a.get('kind')}")
    for p in d.get("doors", []) + d.get("portals", []) + d.get("junctions", []):
        _pts([p.get("pos")], 1, "点")
    for j in d.get("junctions", []):
        if j.get("control", "signal") not in ("signal", "none"):
            raise ValueError("路口控制方式只能是 signal / none")
        g = j.get("green")
        if g is not None and not (isinstance(g, (list, tuple)) and len(g) == 2 and all(isinstance(v, (int, float)) and 5 <= v <= 180 for v in g)):
            raise ValueError("绿灯时长要在 5 ~ 180 秒之间")


def canvas(d):
    """画布 → 标记图尺寸: 默认 0.25 米/像素，长边超过 MAX_PX 时放粗。返回 (W, H, mpp)"""
    mpp = max(0.25, max(d["widthM"], d["heightM"]) / MAX_PX)
    return int(math.ceil(d["widthM"] / mpp)), int(math.ceil(d["heightM"] / mpp)), mpp


def rasterize(d):
    """
    矢量图 → (标记图 BGR, sidecar, mpp)

    画的顺序决定谁盖谁: 区域 → 地面道路 → 高架 → 店门 / 出入口。建筑不画进标记图，全部走 sidecar footprints
    （map2scene 读 footprints 时自己会把楼的范围从路面 / 铺装里扣掉）。
    背景是黑色: 饱和度为 0，map2scene 当作「未标记」。
    """
    validate(d)
    W, H, mpp = canvas(d)  # 标记图尺寸
    pal = palette()  # 调色板颜色
    img = np.zeros((H, W, 3), np.uint8)  # 黑色底 = 未标记

    def px(p):
        """场景米 → 标记图像素（原点从画布中心挪到左上角）"""
        return np.asarray(p, np.float64) / mpp + [W / 2.0, H / 2.0]

    def ipts(p):
        """cv2 画图要的 int32 点列"""
        return np.round(px(p)).astype(np.int32).reshape(-1, 1, 2)

    for a in d.get("areas", []):
        cv2.fillPoly(img, [ipts(a["polygon"])], pal[("area", a["kind"])])
    side_roads = []  # sidecar 里的道路属性
    # 地面路先画、高架后画: 高架要盖在地面路上（map2scene 据此知道哪段地面路在桥下）
    for elevated in (False, True):
        for r in d.get("roads", []):
            if bool(r.get("elevated")) != elevated:
                continue
            w = road_width(r)  # 路宽（米）
            # OpenCV 的粗线两端和拐角都是圆的，路口处几条路自然连成一片，不会有缺口
            cv2.polylines(img, [ipts(r["points"])], False, pal[("elevated" if elevated else "road", None)], max(2, int(round(w / mpp))), cv2.LINE_8)
            if not elevated:
                side_roads.append({"points": np.round(px(r["points"]), 2).tolist(), "width_m": round(w, 2),
                                   "lanes": int(r.get("lanes") or 0), "oneway": bool(r.get("oneway"))})
    # 点状标记: 半径至少 2 像素（map2scene 少于 4 像素的连通块当噪点丢掉），两个点挨太近会被合成一个
    for key, rad_m, items in ((("door", None), 0.8, d.get("doors", [])), (("portal", None), 1.5, d.get("portals", []))):
        for p in items:
            c = np.round(px(p["pos"])).astype(int)
            cv2.circle(img, (int(c[0]), int(c[1])), max(2, int(round(rad_m / mpp))), pal[key], -1)
    side = {
        # 每栋楼: 轮廓（像素）、类型、层数（没给就交给 map2scene 按类型定）、编号和要原样保留的属性
        "footprints": [{"poly": np.round(px(b["polygon"]), 2).tolist(), "kind": b["kind"], "floors": int(b.get("floors") or 0) or None,
                        "id": b.get("id"), "attrs": {k: b[k] for k in ("venue", "attraction", "shops", "name") if b.get(k) not in (None, "", [])}}
                       for b in d.get("buildings", [])],
        "roads": side_roads,
        "junctions": [{**j, "pos": np.round(px(j["pos"]), 2).tolist()} for j in d.get("junctions", [])],
    }
    return img, side, mpp


def build(d, out_json, work_dir=None):
    """
    生成场景: 画标记图 → map2scene → 补底图 / 来源信息；同目录另存一份矢量图（<名字>_drawing.json），下次接着改

    Args:
        d: 矢量图（见文件头）
        out_json: 输出 scene.json 路径（文件名即场景名）
        work_dir: 标记图 / sidecar 放哪（默认和输出同目录下的 _work）
    Returns:
        summary dict: {buildings, lanes, roads, seconds, ...}
    Raises:
        ValueError: 矢量图不合法；RuntimeError: map2scene 失败（带日志末尾）
    """
    t0 = time.time()
    out_json = Path(out_json)
    stem = out_json.stem
    work = Path(work_dir) if work_dir else out_json.parent / "_work"
    work.mkdir(parents=True, exist_ok=True)
    img, side, mpp = rasterize(d)  # 画标记图和 sidecar
    marks, side_f = work / f"{stem}_drawmarks.png", work / f"{stem}_drawside.json"
    cv2.imencode(".png", img)[1].tofile(str(marks))  # tofile: Windows 中文路径也能写
    side_f.write_text(json.dumps(side), "utf-8")
    # 子进程跑 map2scene（和 autoscene 一样）: --site full 整张画布都是地块
    cmd = [sys.executable, str(TOOLS / "map2scene.py"), str(marks), "-o", str(out_json), "--mpp", str(mpp), "--site", "full", "--sidecar", str(side_f)]
    pr = subprocess.run(cmd, capture_output=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    if pr.returncode != 0:
        raise RuntimeError("map2scene 失败:\n" + pr.stderr.decode("utf-8", "replace")[-2000:])
    scene = json.loads(out_json.read_text("utf-8"))  # map2scene 的输出
    # 底图: 上传的图存成 <名字>_bg.<扩展名>；已有的底图（从导入场景改出来的）只认同目录下的文件名
    bg = d.get("background") or {}  # 底图参数
    url = None  # 底图文件名（相对场景文件）
    if bg.get("dataUrl"):
        m = re.fullmatch(r"data:image/(png|jpeg|jpg|webp);base64,(.+)", bg["dataUrl"], re.S)
        if not m:
            raise ValueError("底图只支持 png / jpg / webp")
        url = f"{stem}_bg.{'jpg' if m.group(1) in ('jpeg', 'jpg') else m.group(1)}"
        (out_json.parent / url).write_bytes(base64.b64decode(m.group(2)))
    elif bg.get("url"):
        if not re.fullmatch(r"[A-Za-z0-9_\-.]+", bg["url"]) or not (out_json.parent / bg["url"]).exists():
            raise ValueError("底图文件不存在")
        url = bg["url"]
    if url:
        scene["imagery"] = {"url": url, "widthM": d["widthM"], "heightM": d["heightM"]}  # 底图拉伸铺满画布
    summary = {"buildings": len(scene["buildings"]), "lanes": len(scene.get("lanes", [])), "roads": len(d.get("roads", [])),
               "drawn": True, "seconds": round(time.time() - t0, 1)}
    origin = d.get("origin") or {}  # 从带经纬度的场景改出来时才有
    # 从带经纬度的场景改出来的: 原图的宽高 / 米每像素要留着（前端 makeGeo 靠它换算经纬度），其余用新的摘要
    keep = {k: origin["summary"][k] for k in ("width", "height", "mpp") if isinstance(origin.get("summary"), dict) and k in origin["summary"]}
    scene["origin"] = {"source": "drawing", "geo": origin.get("geo"), "summary": {**summary, **keep}}
    out_json.write_text(json.dumps(scene, ensure_ascii=False), "utf-8")  # 写回场景文件
    # 矢量图另存一份（底图的 dataUrl 换成已保存的文件名，文件小、下次打开也能显示）
    saved = {**d, "background": ({"url": url} if url else None)}
    out_json.with_name(f"{stem}_drawing.json").write_text(json.dumps(saved, ensure_ascii=False), "utf-8")
    return summary
