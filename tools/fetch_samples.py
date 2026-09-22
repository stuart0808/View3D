#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_samples.py —— 下载公开授权的卫星样例图（带人工标注的建筑轮廓真值），拼成街区大小的测试场景。

数据来源: SpaceNet 2（WorldView-3，0.3 m/px，授权 CC BY-SA 4.0，© SpaceNet / Maxar），托管在 AWS 开放数据:
    https://spacenet-dataset.s3.amazonaws.com/spacenet/SN2_buildings/train/<AOI>/PS-RGB/*.tif        三波段 16 位 GeoTIFF
    https://spacenet-dataset.s3.amazonaws.com/spacenet/SN2_buildings/train/<AOI>/geojson_buildings/*  建筑轮廓（经纬度）
原始瓦片 650×650 像素（约 200m 见方），太小，这里把相邻瓦片拼成 cols × rows 块的场景。

做法:
    1. 列出该区域所有瓦片（S3 列表接口，分页）
    2. 每张瓦片只用 HTTP Range 取前 8KB，解析 TIFF 头里的 GeoTIFF 坐标（不下载整张图）→ 得到网格位置
    3. 用 geojson 文件大小近似「这张瓦片里有多少楼」，在网格上找建筑最密、且块块都在的 cols × rows 窗口
    4. 下载窗口里的瓦片 → 拼接 → 按全图 2%~98% 分位拉伸成 8 位 → 存 JPG；建筑轮廓换成像素坐标存 json

产物（tools/samples/，不进仓库）:
    sn_<名字>.jpg        拼好的卫星图
    sn_<名字>_gt.json    {"mpp": 0.3, "source": ..., "geo": {...}, "buildings": [[[x, y], ...], ...]}（像素坐标，给评测脚本用）
                         geo = {"type": "lonlat", "lon0", "lat0", "dlon", "dlat"}: 像素 (x, y) → 经度 lon0 + x·dlon、纬度 lat0 − y·dlat
                         （WGS84；osm.py 用它去取 OpenStreetMap 的道路 / 水系）

    python tools/fetch_samples.py                      # 下载默认的几块
    python tools/fetch_samples.py --aoi AOI_4_Shanghai --name sh_dense --size 4x3 --rank 0
"""
import argparse
import concurrent.futures as cf
import json
import re
import struct
import sys
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

BUCKET = "https://spacenet-dataset.s3.amazonaws.com"  # 公开桶，匿名 HTTP 即可访问，不用 AWS 凭据
PREFIX = "spacenet/SN2_buildings/train"  # 只用训练集: 测试集没有公开建筑真值
OUT = Path(__file__).resolve().parent / "samples"  # 产物目录（.gitignore 里排除）

# 默认下载的场景: (名字, 区域, 拼几块, 第几密的窗口)。上海多取几块（和项目的目标城市一致），巴黎 / 拉斯维加斯各一块看不同屋顶
DEFAULTS = [
    ("sh_dense", "AOI_4_Shanghai", "4x3", 0),  # 上海: 建筑最密的一块
    ("sh_dense2", "AOI_4_Shanghai", "4x3", 1),  # 第二密（和第一块不重叠）
    ("sh_mid", "AOI_4_Shanghai", "4x3", 6),  # 中等密度
    ("sh_town", "AOI_4_Shanghai", "4x3", 3),  # 另一块镇区
    ("sh_edge", "AOI_4_Shanghai", "4x3", 10),  # 镇区边缘（楼少一些，农田 / 厂房多）
    ("paris", "AOI_3_Paris", "3x3", 0),  # 欧洲老城: 连排坡屋顶、内院
    ("vegas", "AOI_2_Vegas", "3x3", 0),  # 美国郊区: 独栋小屋、灰色平屋顶和地面难分
]


def log(*a):
    """进度写 stderr"""
    print("[fetch]", *a, file=sys.stderr, flush=True)


def http(url, rng=None, timeout=60, retries=4):
    """
    GET 一个 URL，可选 Range（字节区间 (a, b)），返回 bytes。连接被断开 / 超时时重试，间隔递增。

    Args:
        url: 完整 URL
        rng: (起始字节, 结束字节)，两端都包含（HTTP Range 的语义）；None 取整个文件
        timeout: 单次请求超时（秒）
        retries: 总尝试次数（含第一次）
    Returns:
        响应体 bytes；最后一次仍失败时把异常原样抛出
    """
    for k in range(retries):
        try:
            # S3 支持 Range，返回 206 Partial Content，只传需要的那一段
            req = urllib.request.Request(url, headers={"Range": f"bytes={rng[0]}-{rng[1]}"} if rng else {})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception:
            if k == retries - 1:
                raise  # 用完次数，交给调用方
            time.sleep(2 * (k + 1))  # 2, 4, 6 秒: S3 偶发断连，稍等就好


def list_keys(prefix):
    """S3 列表（每页 1000 个，按 continuation-token 翻页）→ [(key, size)]"""
    out, token = [], None
    while True:
        # ListObjectsV2 接口；token 里有 + / = 等字符，要 URL 编码
        url = f"{BUCKET}/?list-type=2&prefix={prefix}" + (f"&continuation-token={urllib.parse.quote(token)}" if token else "")
        xml = http(url).decode()
        # 返回的是 XML，结构固定，正则直接抠 <Contents> 里的 Key 和 Size（字节），不值得引入 XML 解析
        out += [(k, int(s)) for k, s in re.findall(r"<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", xml)]
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not m:
            return out  # 没有下一页 token = 列完了
        token = m.group(1)


def tile_origin(url):
    """
    只取 TIFF 文件头（前 8KB），解析 GeoTIFF 的 ModelTiepoint（33922）和 ModelPixelScale（33550），
    返回 (左上角经度, 左上角纬度, 每像素经度, 每像素纬度)。SpaceNet 的文件 IFD 紧跟在文件头后面，8KB 足够。

    GeoTIFF 标签含义: ModelTiepoint = (i, j, k, X, Y, Z)，把像素 (i, j) = (0, 0) 钉到地理坐标 (X, Y) = (经度, 纬度)；
    ModelPixelScale = (每像素经度, 每像素纬度, 0)，纬度那个取正值，向下是减。
    """
    b = http(url, (0, 8191))  # Range 0-8191 共 8192 字节
    if b[:2] != b"II":
        raise ValueError("不是小端 TIFF")  # "MM" 是大端；BigTIFF 也不支持（SpaceNet 都是经典小端 TIFF）
    ifd = struct.unpack_from("<I", b, 4)[0]  # 第一个 IFD 的偏移
    n = struct.unpack_from("<H", b, ifd)[0]  # 条目数
    vals = {}  # 标签号 → double 元组
    # 逐条扫 IFD；这两个标签的值是多个 double，放不进 4 字节的值字段，所以 off 是指向数据的文件偏移
    for i in range(n):
        tag, typ, cnt, off = struct.unpack_from("<HHII", b, ifd + 2 + 12 * i)  # 每条 12 字节: 标签、类型、个数、值 / 偏移
        if tag in (33922, 33550) and typ == 12:  # 12 = DOUBLE，值在 off 指向的位置
            vals[tag] = struct.unpack_from(f"<{cnt}d", b, off)
    tp, ps = vals[33922], vals[33550]  # 缺标签时 KeyError: 说明不是 GeoTIFF，直接报错即可
    return tp[3], tp[4], ps[0], ps[1]  # tiepoint 的 X、Y 是 (0,0) 像素左上角的经、纬度


def stretch(img16):
    """
    16 位 → 8 位: 每个波段按 2%~98% 分位线性拉伸（卫星原始值只占 11 位里的一小段，直接截断会一片灰）。

    Args:
        img16: (H, W, C) uint16，SpaceNet PS-RGB 的原始值
    Returns:
        (H, W, C) uint8，通道顺序不变（仍是 RGB）
    分位点按整张拼图算，而不是每块瓦片各算: 否则拼缝两边明暗不一致。
    每个波段单独拉伸会顺带做一点白平衡，卫星图偏蓝的色调会被拉正。
    """
    out = np.empty(img16.shape, np.uint8)
    for c in range(img16.shape[2]):
        lo, hi = np.percentile(img16[..., c][img16[..., c] > 0], [2, 98])  # 0 是无数据的黑边
        # 两头各丢 2%: 高光（白屋顶、反光）和阴影里的极值不占用色阶；max(1, …) 防整块同值时除零
        out[..., c] = np.clip((img16[..., c].astype(np.float32) - lo) / max(1.0, hi - lo) * 255, 0, 255)
    return out


def fetch_scene(name, aoi, size, rank, index_cache, geo_only=False):
    """
    下载一个场景（见文件头的做法）。index_cache: 区域 → 瓦片网格索引，多个场景共用同一区域时不重复列目录。
    geo_only: 图已经下过了，只把地理参考补进 _gt.json（只读左上角那块的文件头，几秒钟）

    Args:
        name: 输出名，产物是 sn_<name>.jpg / sn_<name>_gt.json
        aoi: SpaceNet 区域目录名，如 AOI_4_Shanghai
        size: "列x行"，如 "4x3"（每块 650 像素 ≈ 200m）
        rank: 取第几密的不重叠窗口，0 = 最密
    """
    import tifffile  # noqa: F401  这里没直接用；好处是没装时在列目录（很慢）之前就报错

    cols, rows = map(int, size.lower().split("x"))  # "4x3" → 4 列 3 行，大小写 X 都行
    grid = tile_grid(aoi, index_cache)
    sc, gx, gy = pick_window(grid, cols, rows, rank, name)
    log(f"{name}: 窗口 ({gx},{gy}) {cols}×{rows}，geojson 共 {sc // 1024} KB")  # KB 数只是密度的粗略参考
    return _fetch_window(name, aoi, grid, gx, gy, cols, rows, geo_only)


def tile_grid(aoi, index_cache):
    """
    区域的瓦片网格索引 {(列, 行): (key, 编号, geojson 字节数)}，按区域缓存在 index_cache 里。

    列、行是按瓦片宽度量化的整数网格坐标，相邻瓦片差 1；可以是负数，只用来找邻居，没有绝对意义。
    编号是文件名里 img<数字> 的那串数字，图像和 geojson 靠它对上。
    """
    if aoi not in index_cache:
        log(f"{aoi}: 列目录…")
        tifs = [k for k, _ in list_keys(f"{PREFIX}/{aoi}/PS-RGB/") if k.endswith(".tif")]  # 目录里还有 .aux.xml 之类，滤掉
        # 编号 → geojson 字节数；没楼的瓦片 geojson 也有（空 FeatureCollection，几十字节）
        gj = {re.search(r"img(\d+)", k).group(1): s for k, s in list_keys(f"{PREFIX}/{aoi}/geojson_buildings/")}
        log(f"{aoi}: {len(tifs)} 张瓦片，读坐标…")
        with cf.ThreadPoolExecutor(24) as ex:  # 几千个小请求，并发取
            origins = list(ex.map(lambda k: tile_origin(f"{BUCKET}/{k}"), tifs))
        # 网格化: 左上角经纬度 / (650 像素 × 每像素度数) 取整
        # 同一区域所有瓦片分辨率相同，拿第一张的每像素度数 × 650 当瓦片步长（度）；
        # 用 round 而不是 floor: 瓦片原点有亚像素的浮点误差，四舍五入才稳
        step_x, step_y = origins[0][2] * 650, origins[0][3] * 650
        grid = {}
        for k, (lon, lat, _, _) in zip(tifs, origins):
            gid = re.search(r"img(\d+)", k).group(1)
            grid[(round(lon / step_x), round(-lat / step_y))] = (k, gid, gj.get(gid, 0))  # 纬度向南增大 → 行号
        index_cache[aoi] = grid
    return index_cache[aoi]


def pick_window(grid, cols, rows, rank, name=""):
    """
    在网格上挑第 rank 密的 cols × rows 窗口（窗口之间不重叠），返回 (分数, 左上列, 左上行)。

    Args:
        grid: tile_grid() 的结果
        cols, rows: 窗口大小（瓦片数）
        rank: 第几密，0 起；超出实际窗口数时退到最后一个
        name: 只用于日志
    同样的 grid + 参数永远挑出同一个窗口（排序确定），所以 --geo-only 和训练集排除都能复现下载时的窗口。
    """
    # 窗口打分: 所有瓦片都在，geojson 字节数之和（≈ 楼数）越大越好；按分数排序后贪心挑不重叠的窗口，取第 rank 个
    wins = []
    for (gx, gy) in grid:
        cells = [grid.get((gx + i, gy + j)) for j in range(rows) for i in range(cols)]
        if all(cells):  # 缺任何一块（区域边缘 / 数据空洞）拼出来会有黑洞，整窗不要
            wins.append((sum(c[2] for c in cells), gx, gy))
    wins.sort(reverse=True)  # 分数相同时按坐标排，结果确定
    picked, used = [], set()  # used: 已被选中窗口占用的格子
    for sc, gx, gy in wins:
        cells = {(gx + i, gy + j) for j in range(rows) for i in range(cols)}
        if cells & used:
            continue  # 和更密的窗口有重叠，跳过；否则 rank 0 / 1 会是几乎同一块地方
        picked.append((sc, gx, gy))
        used |= cells
    if rank >= len(picked):  # 完整的窗口没那么多: 取最后一个（最稀的）
        log(f"{name}: 只有 {len(picked)} 个完整窗口，第 {rank} 个不存在，改取最后一个")
        rank = len(picked) - 1
    return picked[rank]


def _fetch_window(name, aoi, grid, gx, gy, cols, rows, geo_only):
    """
    下载并拼接一个窗口（fetch_scene 的后半）。

    Args:
        grid, gx, gy, cols, rows: 窗口在瓦片网格上的位置和大小
        geo_only: True 时不下载，只给已有的 _gt.json 补 geo（老文件还要补正方形像素校正）
    """
    import tifffile

    # 补地理参考分支: 只读左上角瓦片的文件头
    if geo_only:
        lon0, lat0, dlon, dlat = tile_origin(f"{BUCKET}/{grid[(gx, gy)][0]}")  # 左上角那块的左上角 = 整张图的原点
        f = OUT / f"sn_{name}_gt.json"
        gt = json.loads(f.read_text("utf-8"))
        sx = dlon * np.cos(np.radians(lat0)) / dlat  # 和下载时一样的正方形像素缩放（见 fetch_scene 后半）
        if not gt.get("square"):  # 老文件: 图和真值都缩一下
            jp = OUT / f"sn_{name}.jpg"
            im = cv2.imdecode(np.fromfile(str(jp), np.uint8), cv2.IMREAD_COLOR)
            im = cv2.resize(im, (int(round(im.shape[1] * sx)), im.shape[0]), interpolation=cv2.INTER_AREA)
            cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tofile(str(jp))
            gt["buildings"] = [[[round(x * sx, 1), y] for x, y in p] for p in gt["buildings"]]
            gt["square"] = True  # 标记已校正，重复运行 --geo-only 不会再缩一次
            gt["mpp"] = dlat * 111320.0  # 同下面下载分支: 1 度纬度 ≈ 111.32km
        gt["geo"] = {"type": "lonlat", "lon0": lon0, "lat0": lat0, "dlon": dlon / sx, "dlat": dlat}  # dlon 按缩放后的像素算
        f.write_text(json.dumps(gt), "utf-8")
        log(f"{name}: 已补地理参考 ({lon0:.5f}, {lat0:.5f})")
        return
    # 下载 + 拼接
    mosaic = np.zeros((rows * 650, cols * 650, 3), np.uint16)  # 保持 16 位，拼完整张一起拉伸
    polys = []  # 所有瓦片的建筑多边形，像素坐标（拼图坐标系）
    lon0 = lat0 = dlon = dlat = None  # 拼图原点和分辨率，读到第一块时确定
    for j in range(rows):
        for i in range(cols):
            key, gid, _ = grid[(gx + i, gy + j)]
            data = http(f"{BUCKET}/{key}", timeout=120)
            tif = tifffile.TiffFile(__import__("io").BytesIO(data))  # 整张在内存里解析，不落盘
            a = tif.pages[0].asarray()  # (650, 650, 3) uint16
            tp, ps = tif.pages[0].tags["ModelTiepointTag"].value, tif.pages[0].tags["ModelPixelScaleTag"].value
            if lon0 is None:  # 第一块（左上）定整张图的原点
                lon0, lat0, dlon, dlat = tp[3] - i * 650 * ps[0], tp[4] + j * 650 * ps[1], ps[0], ps[1]
            x0, y0 = int(round((tp[3] - lon0) / dlon)), int(round((lat0 - tp[4]) / dlat))  # 这块在拼图里的像素偏移
            h, w = a.shape[:2]
            # 右侧 / 下侧超出拼图的部分切掉（取整误差可能让最后一块多出一两像素）
            mosaic[y0:y0 + h, x0:x0 + w] = a[: mosaic.shape[0] - y0, : mosaic.shape[1] - x0]
            # 这块的建筑真值: GeoJSON FeatureCollection，坐标是 [经度, 纬度, 高度?]（EPSG:4326）
            g = json.loads(http(f"{BUCKET}/{PREFIX}/{aoi}/geojson_buildings/SN2_buildings_train_{aoi}_geojson_buildings_img{gid}.geojson"))
            for f in g["features"]:
                geo = f["geometry"]
                # Polygon 取外环；MultiPolygon 取每个子多边形的外环；内环（天井）都忽略
                rings = [geo["coordinates"][0]] if geo["type"] == "Polygon" else [p[0] for p in geo["coordinates"]]
                for ring in rings:  # 跨瓦片边界的楼在两个 geojson 里各有一半，拼起来也就接上了
                    polys.append([[round((x - lon0) / dlon, 1), round((lat0 - y) / dlat, 1)] for x, y, *_ in ring])  # 经纬度 → 像素
    img = stretch(mosaic)[..., ::-1]  # RGB → OpenCV 的 BGR
    # 正方形像素: 经纬度网格上每像素的经度差和纬度差相等，但一度经度只有一度纬度的 cos(纬度) 那么长，
    # 上海（北纬 31°）东西向每像素 0.26m、南北向 0.30m —— 不校正的话所有楼横向被压扁 14%。按南北向的分辨率把宽度缩回去
    sx = dlon * np.cos(np.radians(lat0)) / dlat
    img = cv2.resize(img, (int(round(img.shape[1] * sx)), img.shape[0]), interpolation=cv2.INTER_AREA)  # INTER_AREA: 缩小时抗锯齿
    polys = [[[round(x * sx, 1), y] for x, y in p] for p in polys]  # 真值同样只缩 x，保留 0.1 像素精度
    dlon /= sx  # 缩放后每像素对应的经度
    OUT.mkdir(parents=True, exist_ok=True)
    # 质量 92: 屋顶边缘的细节够用，文件比 PNG 小一个数量级；imencode + tofile 绕开 Windows 中文路径问题
    cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tofile(str(OUT / f"sn_{name}.jpg"))
    mpp = dlat * 111320.0  # 南北向每像素的米数（1 度纬度约 111.32km），缩放后东西向也是它
    geo = {"type": "lonlat", "lon0": lon0, "lat0": lat0, "dlon": dlon, "dlat": dlat}  # 经纬度网格（SpaceNet 的 PS-RGB 就是 EPSG:4326）
    (OUT / f"sn_{name}_gt.json").write_text(json.dumps({"mpp": mpp, "source": f"SpaceNet 2 {aoi} (CC BY-SA 4.0)", "geo": geo, "square": True, "buildings": polys}), "utf-8")
    log(f"{name}: {img.shape[1]}×{img.shape[0]} 像素，{len(polys)} 栋楼 → {OUT / f'sn_{name}.jpg'}")


def fetch_train(per_aoi, index_cache):
    """
    训练集: 每个区域随机取 per_aoi 张「有楼」的瓦片（geojson > 1KB），跳过评测场景（DEFAULTS）用到的瓦片，
    存成 tools/samples/train/<区域>_<编号>.jpg（正方形像素、8 位）+ _mask.png（0 背景 / 1 建筑 / 2 建筑边界）。
    边界画 2 像素宽: 挨着的两栋楼中间那条缝就是边界，分割网络学会它才能把连成一片的房子分开。
    """
    import io
    import random

    import tifffile

    out = OUT / "train"
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(0)  # 固定种子，可复现
    by_aoi = {}  # 区域 → 评测场景占用的瓦片编号集合
    for name, aoi, size, rank in DEFAULTS:  # 评测窗口里的瓦片不许进训练集
        cols, rows = map(int, size.lower().split("x"))
        grid = tile_grid(aoi, index_cache)
        _, gx, gy = pick_window(grid, cols, rows, rank, name)
        by_aoi.setdefault(aoi, set()).update(grid[(gx + i, gy + j)][1] for j in range(rows) for i in range(cols))
    # 四个区域都要: 喀土穆没有评测场景，但土房子 / 沙地的样本能让网络见识更多屋顶
    for aoi in ["AOI_4_Shanghai", "AOI_2_Vegas", "AOI_3_Paris", "AOI_5_Khartoum"]:
        grid = tile_grid(aoi, index_cache)
        pool = [v for v in grid.values() if v[2] > 1024 and v[1] not in by_aoi.get(aoi, set())]  # > 1KB ≈ 至少几栋楼
        rng.shuffle(pool)  # 同一种子 + 同一顺序的 pool → 每次抽到同一批，加大 per_aoi 时前面的仍在
        todo = [v for v in pool[:per_aoi] if not (out / f"{aoi}_{v[1]}.jpg").exists()]  # 已下过的跳过，可断点续传
        log(f"训练集 {aoi}: 可选 {len(pool)} 张，取 {per_aoi}（新下载 {len(todo)}）")

        def one(v):
            """下载一张瓦片 → 8 位正方形像素图 + 掩膜"""
            key, gid, _ = v
            tif = tifffile.TiffFile(io.BytesIO(http(f"{BUCKET}/{key}", timeout=120)))
            a = tif.pages[0].asarray()
            tp, ps = tif.pages[0].tags["ModelTiepointTag"].value, tif.pages[0].tags["ModelPixelScaleTag"].value
            lon0, lat0, dlon, dlat = tp[3], tp[4], ps[0], ps[1]  # 单块瓦片，原点就是它自己的左上角
            sx = dlon * np.cos(np.radians(lat0)) / dlat  # 正方形像素缩放（同 fetch_scene）
            img = stretch(a)[..., ::-1]  # 单块各自拉伸（训练集不拼接，没有拼缝问题）；RGB → BGR
            img = cv2.resize(img, (int(round(img.shape[1] * sx)), img.shape[0]), interpolation=cv2.INTER_AREA)
            mask = np.zeros(img.shape[:2], np.uint8)  # 编码: 0 背景 / 1 建筑 / 2 边界，和缩放后的图同尺寸
            g = json.loads(http(f"{BUCKET}/{PREFIX}/{aoi}/geojson_buildings/SN2_buildings_train_{aoi}_geojson_buildings_img{gid}.geojson"))
            rings = []
            for f in g["features"]:
                geo = f["geometry"]
                for ring in ([geo["coordinates"][0]] if geo["type"] == "Polygon" else [q[0] for q in geo["coordinates"]]):
                    pts = np.array([[(x - lon0) / dlon * sx, (lat0 - y) / dlat] for x, y, *_ in ring])  # 经纬度 → 缩放后像素
                    rings.append(np.round(pts).astype(np.int32).reshape(-1, 1, 2))
            cv2.fillPoly(mask, rings, 1)  # 所有楼一次填
            cv2.polylines(mask, rings, True, 2, 2)  # 边界盖在上面（闭合折线，值 2，线宽 2 像素 ≈ 0.6m）
            cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tofile(str(out / f"{aoi}_{gid}.jpg"))
            cv2.imencode(".png", mask)[1].tofile(str(out / f"{aoi}_{gid}_mask.png"))  # 掩膜必须无损，所以用 PNG

        with cf.ThreadPoolExecutor(8) as ex:  # 并发下载；整张 tif 约 2.5MB，8 路够把带宽跑满
            list(ex.map(one, todo))  # list() 把结果取完，线程里的异常才会在这里抛出来


def fetch_train_roads(per_aoi):
    """
    道路训练集: SpaceNet 3（SN3_roads，1300×1300 像素的瓦片，道路中心线 + 车道数 lane_number）。
    每个区域随机取 per_aoi 张有路的瓦片，中心线按「车道数 × 3.5m」画成路面宽度（没写车道数按 2 车道），
    存成 tools/samples/train_roads/<区域>_<编号>.jpg + _road.png（0 / 1）。
    和建筑训练集分开放: 这批瓦片上的楼没有标注，训练时只拿它监督「道路」通道（见 roofnet.py）。
    """
    import io
    import random

    import tifffile

    out = OUT / "train_roads"
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(1)
    for aoi in ["AOI_4_Shanghai", "AOI_2_Vegas", "AOI_3_Paris", "AOI_5_Khartoum"]:
        pre = f"spacenet/SN3_roads/train/{aoi}"
        gj = {re.search(r"img(\d+)", k).group(1): s for k, s in list_keys(f"{pre}/geojson_roads/")}
        pool = [gid for gid, size in gj.items() if size > 2048]  # 有几条路以上的瓦片
        rng.shuffle(pool)
        todo = [g for g in pool[:per_aoi] if not (out / f"{aoi}_{g}.jpg").exists()]
        log(f"道路训练集 {aoi}: 可选 {len(pool)} 张，取 {per_aoi}（新下载 {len(todo)}）")

        def one(gid):
            """下载一张 SN3 瓦片 → 8 位正方形像素图 + 路面掩膜"""
            tif = tifffile.TiffFile(io.BytesIO(http(f"{BUCKET}/{pre}/PS-RGB/SN3_roads_train_{aoi}_PS-RGB_img{gid}.tif", timeout=300)))
            a = tif.pages[0].asarray()
            tp, ps = tif.pages[0].tags["ModelTiepointTag"].value, tif.pages[0].tags["ModelPixelScaleTag"].value
            lon0, lat0, dlon, dlat = tp[3], tp[4], ps[0], ps[1]
            sx = dlon * np.cos(np.radians(lat0)) / dlat  # 正方形像素（同 fetch_scene）
            img = stretch(a[..., :3])[..., ::-1]
            img = cv2.resize(img, (int(round(img.shape[1] * sx)), img.shape[0]), interpolation=cv2.INTER_AREA)
            mpp = dlat * 111320.0
            mask = np.zeros(img.shape[:2], np.uint8)
            g = json.loads(http(f"{BUCKET}/{pre}/geojson_roads/SN3_roads_train_{aoi}_geojson_roads_img{gid}.geojson"))
            for f in g["features"]:
                geo = f["geometry"]
                lines = [geo["coordinates"]] if geo["type"] == "LineString" else geo["coordinates"] if geo["type"] == "MultiLineString" else []
                try:
                    lanes = max(1, int(f["properties"].get("lane_number") or 2))
                except (TypeError, ValueError):
                    lanes = 2
                wpx = max(3, int(round(lanes * 3.5 / mpp)))  # 路面宽（像素）
                for ln in lines:
                    pts = np.array([[(x - lon0) / dlon * sx, (lat0 - y) / dlat] for x, y, *_ in ln])
                    cv2.polylines(mask, [np.round(pts).astype(np.int32).reshape(-1, 1, 2)], False, 1, wpx)
            cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tofile(str(out / f"{aoi}_{gid}.jpg"))
            cv2.imencode(".png", mask)[1].tofile(str(out / f"{aoi}_{gid}_road.png"))

        with cf.ThreadPoolExecutor(6) as ex:
            list(ex.map(one, todo))


def main():
    """命令行: 不带参数下载 DEFAULTS 里的全部场景；带 --aoi 只下一个"""
    ap = argparse.ArgumentParser(description="下载 SpaceNet 卫星样例图并拼成场景", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--aoi", help="AOI_2_Vegas / AOI_3_Paris / AOI_4_Shanghai / AOI_5_Khartoum")
    ap.add_argument("--name", help="输出名（sn_<name>.jpg）")
    ap.add_argument("--size", default="4x3", help="拼几块，列x行")
    ap.add_argument("--rank", type=int, default=0, help="取建筑第几密的窗口（0 = 最密）")
    ap.add_argument("--geo-only", action="store_true", help="图已下载，只补地理参考")
    ap.add_argument("--train", type=int, default=0, help="下载训练集: 每个区域多少张瓦片（给 roofnet.py 训练用）")
    ap.add_argument("--train-roads", type=int, default=0, help="下载道路训练集（SpaceNet 3）: 每个区域多少张")
    args = ap.parse_args()
    cache = {}  # 区域瓦片网格索引，几个场景 / 训练集共用
    if args.train:
        return fetch_train(args.train, cache)
    if args.train_roads:
        return fetch_train_roads(args.train_roads)
    jobs = [(args.name or args.aoi.lower(), args.aoi, args.size, args.rank)] if args.aoi else DEFAULTS
    for job in jobs:
        fetch_scene(*job, cache, geo_only=args.geo_only)


if __name__ == "__main__":
    import urllib.parse  # noqa: F401  list_keys 里用
    main()
