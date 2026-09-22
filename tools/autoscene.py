#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
autoscene.py —— 卫星图 → scene.json 的全自动流水线（不需要人工标注）。前端「导入卫星图」调的就是它。

步骤:
    1. 地理参考（可选）: GeoTIFF 自带；网络地图截图给 中心经纬度 + 缩放级别；都没有就只用图像
    2. 建筑: roofnet（训练好的屋顶分割网络，见 roofnet.py）> SAM > 颜色连通块，按可用性自动降级
    3. 植被: 过绿指数（sat2marks.auto_vegetation）
    4. OSM（有地理参考时）: 道路（按等级给路宽，长桥快速路当高架）、河道 / 水面、绿地 / 公园、停车场、广场、建筑；
       路网先和图像自动对齐（osm.align_roads）。OSM 里有的建筑用 OSM 的轮廓和层数，图像识别的只补 OSM 缺的
    5. 层数: OSM 的 building:levels > 按占地面积的默认值（国内常见: 独栋民房 3 层、多层住宅 6 层、大型厂房 / 商场 2 层）
    6. 标记图 + sidecar → map2scene（整张图都算地块）→ scene.json；场景里记下卫星底图的尺寸，前端可以铺在地面上对照

    python tools/autoscene.py 图.jpg --mpp 0.3 -o public/scenes/imported/x.json
    python tools/autoscene.py 截图.png --lat 31.23 --lon 121.47 --zoom 18 --scale 2 --datum gcj02 -o ...
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import osm  # noqa: E402
import satgeo as sg  # noqa: E402
from sat2marks import BUILDING_IDS, CLASSES, auto_vegetation, hex_bgr, imwrite_unicode  # noqa: E402

CID = {c["key"]: c["id"] for c in CLASSES}  # 类别名 → 标记图里的类别 id


def default_floors(area_m2, kind):
    """
    没有层数信息时按占地面积猜: 50~250㎡ 独栋民房 3 层；250~1200㎡ 多层住宅 / 小办公 6 层；
    1200㎡ 以上多半是厂房、仓库、商场，2 层（以 shop 类出场，前端画成大商场的样子）。

    Args:
        area_m2: 占地面积（平方米，按像素数 × mpp² 算的屋顶投影面积）
        kind: "shop" / "block" / "residential"；OSM 标了商业的直接按 shop 处理

    Returns:
        int: 层数。宁可偏低: 猜高了会出现「铅笔楼」，比猜低了难看得多
    """
    if kind == "shop":
        return 2
    if area_m2 < 250:
        return 3
    if area_m2 < 1200:
        return 6
    return 2


def read_image(path):
    """读图 + （如果是 GeoTIFF）地理参考。16 位影像按 2%~98% 拉伸成 8 位

    Args:
        path: 图片路径（jpg / png / tif），可以含中文

    Returns:
        (img, geo): img 是 BGR uint8 (H,W,3)；geo 是 {"type": "lonlat", lon0, lat0, dlon, dlat}
                    （左上角经纬度 + 每像素度数），读不出地理参考时是 None

    Raises:
        ValueError: 普通图片解码失败（格式不支持 / 文件损坏）
    """
    path = Path(path)
    geo = None
    if path.suffix.lower() in (".tif", ".tiff"):
        # GeoTIFF 用 tifffile 而不是 OpenCV: OpenCV 读不了多波段 / 16 位遥感影像，也拿不到 GeoKey 标签
        import tifffile
        t = tifffile.TiffFile(str(path))
        a = t.pages[0].asarray()  # 只读第一页（后面的页通常是金字塔缩略图）
        if a.ndim == 3 and a.shape[0] in (3, 4) and a.shape[-1] not in (3, 4):
            a = np.moveaxis(a, 0, -1)  # 波段在前的存法
        a = a[..., :3]  # 只要前三个波段（假定 RGB 顺序）；第四个常是近红外或 alpha
        # 16 位 / 浮点影像: 每个波段单独按 2%~98% 分位数拉伸到 0~255。
        # 不用最大最小值: 几个过曝像素（玻璃反光）会把整张图压暗；> 0 排除 nodata 黑边
        if a.dtype != np.uint8:
            out = np.empty(a.shape, np.uint8)
            for c in range(3):
                lo, hi = np.percentile(a[..., c][a[..., c] > 0], [2, 98])
                out[..., c] = np.clip((a[..., c].astype(np.float32) - lo) / max(1.0, hi - lo) * 255, 0, 255)
            a = out
        img = np.ascontiguousarray(a[..., ::-1])  # RGB → BGR
        # 地理参考: Tiepoint = (像素 i, j, k, 地理 X, Y, Z)，这里只处理 (0,0) 对应左上角的常见写法；
        # PixelScale = (每像素 X 跨度, Y 跨度, Z)。Y 向下增大时纬度减小，dlat 取正值由 GeoRef 负责方向
        tags = t.pages[0].tags
        if "ModelTiepointTag" in tags and "ModelPixelScaleTag" in tags:
            tp, ps = tags["ModelTiepointTag"].value, tags["ModelPixelScaleTag"].value
            if abs(tp[3]) <= 180 and abs(tp[4]) <= 90:  # 只认经纬度网格（EPSG:4326）；投影坐标系的 GeoTIFF 当普通图
                geo = {"type": "lonlat", "lon0": tp[3], "lat0": tp[4], "dlon": ps[0], "dlat": ps[1]}
        return img, geo
    # 普通图片: fromfile + imdecode 支持 Windows 中文路径；带 alpha 的 png 按 IMREAD_COLOR 丢掉透明通道
    img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"读不了图片: {path}")
    return img, None


def square_pixels(img, geo):
    """经纬度网格的图东西向像素比南北向短（×cos 纬度），缩成正方形像素；返回 (图, 地理参考)

    后面的检测、map2scene 都假定像素是正方形（一个 mpp 管两个方向），不修正的话
    上海（北纬 31°）的楼会被拉宽约 17%。只缩东西向，南北向分辨率不变。
    Web 墨卡托截图本身就是正方形像素，原样返回。

    Returns:
        (img, geo): 缩放后的图；geo 里的 dlon 同步改成新的每像素经度
    """
    if not geo or geo["type"] != "lonlat":
        return img, geo
    # sx = 一个像素东西向的米数 / 南北向的米数（纬度用左上角的，小范围内够准）
    sx = geo["dlon"] * np.cos(np.radians(geo["lat0"])) / geo["dlat"]
    if abs(sx - 1) < 0.02:  # 差不到 2% 就不重采样，省一次插值模糊
        return img, geo
    img = cv2.resize(img, (int(round(img.shape[1] * sx)), img.shape[0]), interpolation=cv2.INTER_AREA)
    return img, dict(geo, dlon=geo["dlon"] / sx)


def detect_buildings(img, mpp, method="auto", progress=None):
    """建筑检测，按 method 或可用性选: roofnet / sam / color。返回 (裁剪块列表, 实际用的方法)

    Args:
        img: BGR uint8 (H,W,3)，已经是正方形像素
        mpp: 米/像素
        method: "auto" = 能用 roofnet 就用，否则 SAM，再否则颜色法；指定某个方法而它不可用时也会往下降级
        progress: 可选回调 progress(已完成, 总数)

    Returns:
        (crops, used, road_prob): crops = [(x0, y0, bool 掩码)]，每栋楼一个；used = 实际用的方法名，写进摘要；
        road_prob = 道路概率图（float32 (H,W)），只有第二版屋顶网络（带道路通道）才有，否则 None
    """
    import roofnet  # 这里才 import: roofnet 模块本身不依赖 torch，available() 里再探测
    # 首选 roofnet: 专门训练的屋顶分割 + 分水岭拆楼，村镇密集民房上比 SAM 好得多
    if method in ("auto", "roofnet") and roofnet.available():
        probs = roofnet.predict(img, mpp, progress=progress)  # [建筑, 边界] 或 [建筑, 边界, 道路]
        return roofnet.instances(probs[0], probs[1], mpp), "roofnet", (probs[2] if len(probs) > 2 else None)
    # 其次 SAM: 作为 find_buildings 的「分割一切」后端；seg 留 None 时 find_buildings 只用颜色连通块
    seg = None
    if method in ("auto", "sam"):
        try:
            import sat2marks
            # 本地有 mobile_sam.pt 就用本地的，否则按设备选: 有 GPU 用大模型 sam2.1_l（准），CPU 用 MobileSAM（快）
            model = str(HERE / "mobile_sam.pt") if (HERE / "mobile_sam.pt").exists() else None
            import torch
            dev = "cuda" if torch.cuda.is_available() else "cpu"
            # SamBackend 构造时要一张图，这里给个 8×8 占位，真正的图由 segment_all 在 find_buildings 里传入
            seg = sat2marks.SamBackend(np.zeros((8, 8, 3), np.uint8), model or ("sam2.1_l.pt" if dev == "cuda" else "mobile_sam.pt"), dev).make_segment_all()
        except Exception:
            seg = None  # 没装 SAM: 颜色连通块兜底
    # find_buildings 返回候选 dict（含评分等），这里只要裁剪块
    found = sg.find_buildings(img, mpp, seg, progress=progress)
    return [c["crop"] for c in found], "sam" if seg else "color", None


def clean_roads(prob, mpp, thr=0.5, min_len_m=40.0, min_area_m2=150.0):
    """
    网络给的道路概率图 → 干净的路面掩膜: 二值化 → 闭运算连上被车 / 树冠遮断的缺口（约 3m）→
    开运算去掉毛刺 → 丢掉又短又小的碎块（停车场里的通道、院子里的水泥地）。

    Args:
        prob: 道路概率 float32 (H,W)，0~1
        mpp: 米/像素（形态学核、长度 / 面积门槛都按米换算）
        thr: 概率阈值
        min_len_m / min_area_m2: 连通块外接框长边、面积的下限

    Returns: bool 掩膜
    """
    m = (prob > thr).astype(np.uint8)
    k = max(3, int(round(3.0 / mpp)) | 1)  # 核 ≈ 3m，奇数
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        keep[i] = max(w, h) * mpp >= min_len_m and area * mpp * mpp >= min_area_m2  # 够长也够大才算路
    return keep[lab]


def poly_px(pts):
    """浮点像素折线 → OpenCV 要的 int32 (N,1,2)

    OSM 坐标经 GeoRef 换算后是浮点像素，fillPoly / polylines 只收整数点，四舍五入即可
    （误差半个像素，0.3 m/px 下 15 cm，看不出来）。
    """
    return np.round(np.asarray(pts)).astype(np.int32).reshape(-1, 1, 2)


def build_labels(img, mpp, bld_crops, feats=None, img_roads=None, bld_floors=None):
    """
    拼类别图（和 sat2marks 的 labels 一样的编码）。画的顺序决定谁盖谁:
        植被（图像）→ OSM 绿地 / 公园 / 停车场 / 广场 → 水 → 道路 / 高架 → 建筑
    图像识别的建筑: 和 OSM 建筑重叠超过 30% 的丢掉（OSM 的轮廓更准），压在道路上的像素抠掉。
    Returns: (labels, 楼列表 [{mask_crop, cls, floors}])

    Args:
        img: BGR uint8 (H,W,3)
        mpp: 米/像素
        bld_crops: detect_buildings 的裁剪块 [(x0, y0, bool 掩码)]
        feats: osm.features 的结果（已对齐到图像像素坐标），None = 没有 OSM
        img_roads: 网络识别的路面 bool 掩膜（第二版屋顶网络才有），None = 没有；
                   只在 OSM 路网不到 3 条时使用（OSM 的拓扑和路宽更可靠）
        bld_floors: 和 bld_crops 一一对应的层数（影子估出来的，satgeo.auto_heights），None 的按面积给默认值

    labels 是 uint8 (H,W)，每像素一个 CLASSES 里的类别 id，0 = 空地；
    楼列表里 crop = (x0, y0, 掩码)，cls = 建筑类别 id，floors = 层数。
    """
    h, w = img.shape[:2]
    lab = np.zeros((h, w), np.uint8)
    # 第一层: 图像里的植被（草地 / 树冠成片的算公园），后面的 OSM 要素会盖掉一部分
    green, park = auto_vegetation(img, mpp)
    lab[green] = CID["green"]
    lab[park] = CID["park"]
    road = np.zeros((h, w), np.uint8)  # 地面道路掩码，用来从图像识别的楼里抠掉压路的部分
    osm_bld = np.zeros((h, w), np.uint8)  # OSM 建筑占的像素，用来判断图像识别的楼是不是重复
    blds = []
    if feats:
        # 面状要素: 顺序即覆盖顺序，水放最后，河边绿地不会盖住水面
        for key, cls in (("green", "green"), ("park", "park"), ("parking", "parking"), ("plaza", "plaza"), ("water", "water")):
            for p in feats[key]:
                m = np.zeros((h, w), np.uint8)
                cv2.fillPoly(m, [poly_px(p)], 1)
                lab[m > 0] = CID[cls]
        for wv in feats["waterways"]:  # 河道线按宽度画成水面
            cv2.polylines(lab, [poly_px(wv["pts"])], False, CID["water"], max(2, int(round(wv["width_m"] / mpp))))
        for r in sorted(feats["roads"], key=lambda r: r["elevated"]):  # 高架最后画，盖在地面路上（map2scene 会补回桥下的路）
            wpx = max(2, int(round(r["width_m"] / mpp)))  # 路宽换成像素线宽，至少 2 像素，否则 map2scene 提不出中心线
            cv2.polylines(lab, [poly_px(r["pts"])], False, CID["elevated"] if r["elevated"] else CID["road"], wpx)
            # 只记地面路: 高架下面可以有楼（桥下空间），不从楼里抠
            if not r["elevated"]:
                cv2.polylines(road, [poly_px(r["pts"])], False, 1, wpx)
        # OSM 建筑: 轮廓和层数都比图像识别可靠，先画，图像识别的只补空缺
        for b in feats["buildings"]:
            m = np.zeros((h, w), np.uint8)
            cv2.fillPoly(m, [poly_px(b["poly"])], 1)
            if m.sum() < 8:  # 不到 8 个像素: 多半只擦到图边，或者是 OSM 里的小亭子
                continue
            osm_bld |= m
            area = float(m.sum()) * mpp * mpp
            # OSM 没写用途（building=yes）时按面积猜: 1200㎡ 以上当商场 / 厂房
            kind = b["kind"] if b["kind"] != "auto" else ("shop" if area >= 1200 else "residential")
            cls = {"shop": CID["shop2"], "block": CID["block"], "residential": CID["residential"]}[kind]
            lab[m > 0] = cls
            blds.append({"crop": sg.crop(m > 0), "cls": cls, "floors": b["floors"] or default_floors(area, kind)})  # 层数: OSM 的 building:levels 优先
    # 图像识别的路（第二版屋顶网络才有）: OSM 没给出像样的路网（没坐标 / 那片 OSM 没画）时才用，
    # 画在植被之上、建筑之下；也记进 road，后面图像识别的楼压在上面的部分会被抠掉
    osm_has_roads = bool(feats and len(feats["roads"]) >= 3)
    if img_roads is not None and not osm_has_roads:
        lab[img_roads] = CID["road"]
        road |= img_roads.astype(np.uint8)
    # 图像识别的楼: 去重 → 抠路 → 去碎块，剩下的补进标签图
    for k, c in enumerate(bld_crops):
        x0, y0, sub = c
        win_o = osm_bld[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]]  # 同一外接框里的 OSM 建筑
        # 30%: 对齐误差让同一栋楼的两个轮廓错开一两米，重叠不会到 100%；低于 30% 多半只是挨着的另一栋
        if (sub & (win_o > 0)).sum() > 0.3 * sub.sum():
            continue  # OSM 里已经有这栋
        sub = sub & (road[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]] == 0)  # 压在路上的部分抠掉
        if sub.sum() * mpp * mpp < 12:  # 抠完路剩不到 12㎡（和 roofnet.instances 的下限一致）: 丢掉
            continue
        area = float(sub.sum()) * mpp * mpp
        kind = "shop" if area >= 1200 else "residential"
        cls = CID["shop2"] if kind == "shop" else CID["residential"]
        # 只写掩码内的像素（布尔索引），外接框里原有的绿地 / 路保持不变
        lab[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]][sub] = cls
        est = bld_floors[k] if bld_floors else None  # 影子估的层数（大厂房 / 商场不信它: 影子多半被遮挡或连成一片）
        blds.append({"crop": (x0, y0, sub), "cls": cls, "floors": est if (est and kind != "shop") else default_floors(area, kind)})
    return lab, blds


def run(image, out_json, mpp=None, geo=None, use_osm=True, method="auto", progress=None, work_dir=None, ref_floors=None, sun_elev=50.0):
    """
    全流程。progress(阶段名, 0~1 进度) 回调给服务端显示。
    Args:
        image:    图片路径
        out_json: scene.json 输出路径（旁边会放同名 .jpg 卫星底图和 _preview.png 识别预览）
        mpp:      米/像素；有地理参考时可以不给
        geo:      地理参考 dict（见 osm.GeoRef），None 时读 GeoTIFF 自带的
    Returns: 摘要 dict（楼数、路数、用时、用了什么方法……）

    其余参数:
        use_osm:  False = 不联网取 OpenStreetMap（离线 / 测试用），只有图像识别的楼和植被
        method:   建筑检测方法，见 detect_buildings
        work_dir: 中间文件（标记图 _marks.png、_sidecar.json）放哪；None = 和 out_json 同目录

    进度分配（大致按耗时）: 读图 0~5%，识别建筑 5~55%，OSM 60~70%，拼标注 70~80%，map2scene 80~100%。
    """
    t0 = time.time()
    say = progress or (lambda *a: None)  # 没给回调就什么也不做，下面不用到处判断
    out_json = Path(out_json)
    work = Path(work_dir) if work_dir else out_json.parent
    work.mkdir(parents=True, exist_ok=True)

    # ---- 1. 读图 + 地理参考 + 比例尺 ----
    say("读图", 0.02)
    img, geo_tif = read_image(image)
    geo = geo or geo_tif  # 调用方显式给的地理参考优先于 GeoTIFF 自带的
    img, geo = square_pixels(img, geo)
    h, w = img.shape[:2]
    gr = osm.GeoRef(geo, w, h) if geo else None  # 像素 ↔ 经纬度换算
    # 手填的 mpp 优先（用户可能知道得更准）；否则由地理参考算（Web 墨卡托按纬度和缩放级别）
    if gr and not mpp:
        mpp = gr.mpp()
    if not mpp:
        raise ValueError("不知道比例尺: 给 mpp，或者给地理参考（中心经纬度 + 缩放级别）")
    summary = {"width": w, "height": h, "mpp": round(mpp, 4), "geo": bool(gr)}

    # ---- 2. 建筑检测（最耗时，占进度 5%~55%）----
    say("识别建筑", 0.05)
    crops, used, road_prob = detect_buildings(img, mpp, method, progress=lambda a, b: say("识别建筑", 0.05 + 0.5 * a / max(1, b)))
    img_roads = clean_roads(road_prob, mpp) if road_prob is not None else None  # 网络识别的路面（第二版才有）
    # 影子估层数: 方向自动找，长度 ↔ 高度按太阳高度角（默认 50°）；给了参考层数就按它定整体比例
    say("估算楼高", 0.56)
    bld_floors, hinfo = sg.auto_heights(crops, img, mpp, sun_elev_deg=sun_elev, ref_floors=ref_floors) if crops else ([], {})
    summary["heights"] = hinfo
    summary.update(method=used, detected=len(crops), image_roads=img_roads is not None)

    # ---- 3. OSM（只有知道经纬度时才取）----
    feats = None
    if gr and use_osm:
        say("取 OpenStreetMap", 0.6)
        try:
            # 范围四周多取 60 m: 从图外穿进来的路也要拿到完整的一段，否则图边的路会断
            feats = osm.features(osm.fetch(gr.bbox(pad_px=int(60 / mpp))), gr)
            # 截图坐标和 OSM 常差几米到十几米（偏移 / 火星坐标残差），用路网和图像的匹配找整体平移（像素）
            dx, dy, gain = osm.align_roads(img, feats, mpp)
            feats = osm.shift(feats, dx, dy)
            summary.update(osm_roads=len(feats["roads"]), osm_buildings=len(feats["buildings"]), osm_shift_m=[round(dx * mpp, 1), round(dy * mpp, 1)])
        except Exception as e:  # 网络不通 / Overpass 忙: 不影响出场景，只是没有路
            summary["osm_error"] = str(e)
            feats = None

    # ---- 4. 类别图 → 彩色标记图 + 层数 sidecar（map2scene 的输入格式，和手工 sat2marks 导出的一样）----
    say("拼标注", 0.7)
    lab, blds = build_labels(img, mpp, crops, feats, img_roads, bld_floors)
    # 类别 id → BGRA 颜色查找表；map2scene 按颜色认类别，所以颜色必须和 CLASSES 完全一致（不能有抗锯齿）
    lut = np.zeros((256, 4), np.uint8)
    for c in CLASSES:
        lut[c["id"]] = (*hex_bgr(c["color"]), 255)
    stem = out_json.stem
    marks = work / f"{stem}_marks.png"
    imwrite_unicode(marks, lut[lab])  # lut[lab]: (H,W) → (H,W,4)，PNG 无损保证颜色不变
    side = work / f"{stem}_sidecar.json"
    at = []
    for b in blds:  # sidecar: 每栋楼一个落在楼里的点 + 层数
        x0, y0, sub = b["crop"]
        # 取离边最远的像素（距离变换最大值）当代表点: 凹形 / L 形楼的外接框中心可能落在楼外；
        # 四周补一圈 0，让贴着裁剪框边的像素也算到「边」的距离
        d = cv2.distanceTransform(np.pad(sub, 1).astype(np.uint8), cv2.DIST_L2, 3)[1:-1, 1:-1]
        j = int(d.argmax())  # 展平后的下标，下面换回 (列, 行) 再加上裁剪框偏移
        at.append({"at": [x0 + j % sub.shape[1], y0 + j // sub.shape[1]], "floors": b["floors"]})
    side.write_text(json.dumps({"buildings": at}), "utf-8")

    # ---- 5. map2scene: 标记图 → scene.json ----
    # 用子进程而不是 import: map2scene 是独立的命令行工具，出错 / 内存峰值不影响常驻的 sat_server；
    # --site full = 整张图都算地块；--debug 顺便出一张识别预览
    say("生成场景", 0.8)
    preview = out_json.with_name(f"{stem}_preview.jpg")
    cmd = [sys.executable, str(HERE / "map2scene.py"), str(marks), "-o", str(out_json), "--mpp", str(mpp), "--site", "full",
           "--sidecar", str(side), "--debug", str(preview.with_suffix(".png"))]
    # PYTHONIOENCODING=utf-8: Windows 下子进程默认按 GBK 输出，中文日志会乱码或直接编码报错
    pr = subprocess.run(cmd, capture_output=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    log = pr.stderr.decode("utf-8", "replace")
    if pr.returncode != 0:
        raise RuntimeError("map2scene 失败:\n" + log[-2000:])  # 只带最后 2000 字符（traceback 在末尾），前端显示得下
    # 预览缩成 jpg（png 太大），卫星底图存一份给前端铺地面
    pv = cv2.imdecode(np.fromfile(str(preview.with_suffix(".png")), np.uint8), cv2.IMREAD_COLOR)
    if pv is not None:
        k = min(1.0, 1600 / max(pv.shape[:2]))  # 长边最多 1600 像素；k ≤ 1，小图不放大
        cv2.imencode(".jpg", cv2.resize(pv, None, fx=k, fy=k, interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tofile(str(preview))
        preview.with_suffix(".png").unlink()
    base = out_json.with_suffix(".jpg")
    k = min(1.0, 4096 / max(h, w))  # 贴图最大 4096，浏览器都吃得下
    cv2.imencode(".jpg", cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tofile(str(base))
    # ---- 6. 往 map2scene 的输出里补底图和来源信息 ----
    scene = json.loads(out_json.read_text("utf-8"))
    # map2scene 的坐标原点在图中心、单位米；卫星图覆盖 [-w/2, w/2] × [-h/2, h/2] 个像素 × mpp
    scene["imagery"] = {"url": base.name, "widthM": round(w * mpp, 2), "heightM": round(h * mpp, 2)}
    # 摘要要在写文件之前补全: 场景列表（index.json）读的是文件里这份
    summary.update(buildings=len(scene["buildings"]), lanes=len(scene.get("lanes", [])), seconds=round(time.time() - t0, 1))
    # origin 给 sat_server 的场景列表用（来源文件名 + 摘要），geo 留着以后能再对 OSM
    scene["origin"] = {"source": Path(image).name, "geo": geo, "summary": summary}
    # 紧凑 JSON（无空格）: 大场景的 lanes 很多，能小三成
    out_json.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), "utf-8")
    say("完成", 1.0)
    return summary


def main():
    """命令行入口

    进度打到 stderr（[auto] 百分比 阶段），最后把摘要 JSON 打到 stdout，方便脚本解析。
    比例尺三选一: --mpp；--lat/--lon/--zoom（网络地图截图）；--geo-json；GeoTIFF 可以都不给。
    """
    ap = argparse.ArgumentParser(description="卫星图 → scene.json（全自动）", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("image")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--mpp", type=float)  # 米/像素
    ap.add_argument("--lat", type=float)  # 截图中心纬度
    ap.add_argument("--lon", type=float)  # 截图中心经度
    ap.add_argument("--zoom", type=float)  # 瓦片缩放级别，可以是小数（浏览器缩放后的截图）
    ap.add_argument("--scale", type=float, default=1)  # 设备像素比: 高分屏截图填 2
    ap.add_argument("--datum", choices=["wgs84", "gcj02"], default="wgs84")  # 国内地图（高德 / 腾讯）是 gcj02 火星坐标
    ap.add_argument("--geo-json", help="从 json 文件的 geo 字段读地理参考（比如 fetch_samples 的 sn_*_gt.json）")
    ap.add_argument("--no-osm", action="store_true")
    ap.add_argument("--method", choices=["auto", "roofnet", "sam", "color"], default="auto")
    ap.add_argument("--ref-floors", type=float, help="这一片的楼大多几层（按它定影子估高的整体比例）")
    ap.add_argument("--sun-elev", type=float, default=50.0, help="太阳高度角（度），不给参考层数时用它换算影子长度")
    a = ap.parse_args()
    # 纬度可以是 0（赤道），所以判 is not None；缩放级别不会是 0，直接判真
    geo = {"type": "webmerc", "lat": a.lat, "lon": a.lon, "zoom": a.zoom, "scale": a.scale, "datum": a.datum} if a.zoom and a.lat is not None else None
    if a.geo_json:
        geo = json.loads(Path(a.geo_json).read_text("utf-8"))["geo"]
    res = run(a.image, a.out, a.mpp, geo, not a.no_osm, a.method, ref_floors=a.ref_floors, sun_elev=a.sun_elev, progress=lambda s, p: print(f"[auto] {p:4.0%} {s}", file=sys.stderr, flush=True))
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
