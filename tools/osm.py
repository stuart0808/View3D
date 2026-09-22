#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
osm.py —— 从 OpenStreetMap 取真实地点的道路 / 水系 / 绿地 / 建筑，换算到卫星图的像素坐标。

为什么: 只看卫星图的颜色，道路很难自动提准（村里的水泥院子和路一样灰，深色沥青主干道又像水），
而 OSM 的路网拓扑准确、带道路等级（→ 车道数 / 路宽），国内城市道路覆盖很好。只要知道图片的地理范围就能用。

地理参考（GeoRef）两种:
    lonlat   经纬度网格（GeoTIFF / SpaceNet）: lon = lon0 + x·dlon，lat = lat0 − y·dlat
    webmerc  网络地图截图（谷歌 / 天地图 / 高德 / 百度卫星图）: 图中心经纬度 + 缩放级别 + 截图倍率，Web 墨卡托投影
国内的高德、腾讯地图用 GCJ-02（「火星坐标」，和 WGS84 差几百米），datum="gcj02" 时先把 OSM 的 WGS84 坐标加密再投影。
天地图用 CGCS2000，和 WGS84 差几厘米，当 WGS84 用。百度用 BD-09，暂不支持。

即使坐标系对了，影像本身也常有十几米的配准误差 —— align_roads() 在 ±30m 里平移 OSM 路网，
找「路网中心线落在灰色路面上最多」的偏移量，自动对齐。

数据用 Overpass API 取，结果按范围缓存在 tools/samples/cache/osm_*.json。OSM 数据授权 ODbL，© OpenStreetMap contributors。
"""
import hashlib
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

import cv2
import numpy as np

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://z.overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter"]  # 公共服务器常忙（504 / 429），依次换着试
USER_AGENT = "View3D/0.1 (+https://github.com/stuart0808/View3D)"  # Overpass 要求带 UA；不带个人信息
CACHE = Path(__file__).resolve().parent / "samples" / "cache"  # 和 SAM 缓存放一起，键是查询语句的 md5
R_EARTH = 6378137.0  # Web 墨卡托用的地球半径（米）

# 道路等级 → (双向总宽 m, 默认是否单行)。按国内城市道路的常见断面取: 主干路双向 6 车道 + 隔离带约 30m，
# 支路两车道 7~8m。有 lanes 标签时按 车道数 × 3.5m 算，覆盖这里的默认值
ROAD_WIDTH = {
    "motorway": 28, "trunk": 28, "primary": 24, "secondary": 18, "tertiary": 13,
    "motorway_link": 8, "trunk_link": 8, "primary_link": 8, "secondary_link": 7, "tertiary_link": 7,
    "unclassified": 8, "residential": 7, "living_street": 6, "service": 5.5,
}
ELEVATED_CLASSES = {"motorway", "trunk", "primary", "motorway_link", "trunk_link"}  # 这几类的长桥当高架
WATERWAY_WIDTH = {"river": 30, "canal": 10, "stream": 4, "drain": 3, "ditch": 2}  # 河道线（没画成面的）按宽度扩成水面


# ----------------------------------------------------------------------------
# 坐标系: GCJ-02（国测局加密）⇄ WGS84，公开的近似公式，精度 1~2m
# ----------------------------------------------------------------------------
_A, _EE = 6378245.0, 0.00669342162296594323  # 克拉索夫斯基椭球长半轴、偏心率平方


def _out_of_china(lon, lat):
    """
    国外不加密。用的是中国大致的经纬度矩形（度），港澳台 / 周边国家边缘会被误判为「国内」，
    这是公开算法本身的约定，和各家地图的实际行为一致，所以照搬不改。
    """
    return not (72.004 <= lon <= 137.8347 and 0.8293 <= lat <= 55.8271)


def _delta(lon, lat):
    """
    GCJ-02 相对 WGS84 的偏移（度）。

    先在以 (105°E, 35°N) 为原点的平面上算出「米级」的扰动量（一串多项式 + 正弦项，常数都是公开算法里的，
    没有物理含义，不要改），再按克拉索夫斯基椭球在当地的曲率半径把米换成度。
    Returns:
        (dlon, dlat)，单位度；加到 WGS84 上就是 GCJ-02
    """
    x, y = lon - 105.0, lat - 35.0  # 相对中国大致中心的经纬度差（度）
    # 纬度方向扰动（米级量）
    dlat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    dlat += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    dlat += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    dlat += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    # 经度方向扰动（米级量）
    dlon = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    dlon += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    dlon += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    dlon += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    # 米 → 度: 除以当地子午圈曲率半径 M（纬度）/ 卯酉圈半径 N·cosφ（经度），再 ×180/π
    rad = lat / 180.0 * math.pi
    magic = 1 - _EE * math.sin(rad) ** 2  # 1 - e²·sin²φ
    sq = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sq) * math.pi)  # M = a(1-e²)/(1-e²sin²φ)^1.5
    dlon = (dlon * 180.0) / (_A / sq * math.cos(rad) * math.pi)  # N·cosφ = a/√(1-e²sin²φ)·cosφ
    return dlon, dlat


def wgs84_to_gcj02(lon, lat):
    """
    WGS84 → GCJ-02。

    Args:
        lon, lat: WGS84 经纬度（度）
    Returns:
        (lon, lat): GCJ-02 经纬度（度）；国外原样返回
    """
    if _out_of_china(lon, lat):
        return lon, lat  # 国外的高德 / 腾讯底图本身就是 WGS84
    dlon, dlat = _delta(lon, lat)
    return lon + dlon, lat + dlat


def gcj02_to_wgs84(lon, lat):
    """
    GCJ-02 → WGS84（迭代两次，误差 < 0.5m）。

    加密没有解析逆，用不动点迭代: 猜一个 WGS84 点，正向加密后和目标比，差多少就往回挪多少。
    偏移量随位置变化很慢，所以收敛很快（实际跑 3 轮，比注释里说的多一轮留余量）。
    """
    if _out_of_china(lon, lat):
        return lon, lat
    wl, wa = lon, lat  # 初值: 直接把 GCJ-02 当 WGS84，误差几百米
    for _ in range(3):
        gl, ga = wgs84_to_gcj02(wl, wa)
        wl, wa = wl - (gl - lon), wa - (ga - lat)  # 正向结果比目标多出多少，猜测值就减多少
    return wl, wa


# ----------------------------------------------------------------------------
# 地理参考
# ----------------------------------------------------------------------------
class GeoRef:
    """
    像素 ⇄ 经纬度。datum 是「图片用的坐标系」: wgs84（默认）或 gcj02（高德 / 腾讯卫星图）。
    to_px 接收 WGS84 经纬度（OSM 就是 WGS84），需要时先换成 GCJ-02 再投影到像素。

    参数字典 d 的两种形式:
        {"type": "lonlat", "lon0", "lat0", "dlon", "dlat"}   左上角像素的经纬度 + 每像素度数（dlat 取正，向下减）
        {"type": "webmerc", "lon", "lat", "zoom", "scale"?}  图中心经纬度 + 缩放级别（可带小数）+ 截图倍率（高分屏 2）
    两种都可再带 "datum"。
    """

    def __init__(self, d, width, height):
        """
        Args:
            d: 见类说明的参数字典（会复制一份，不改调用方的）
            width, height: 图像尺寸（像素）；webmerc 需要它把图中心对上 (lon, lat)
        """
        self.d = dict(d)
        self.w, self.h = width, height
        self.kind = d["type"]
        self.datum = d.get("datum", "wgs84")  # 没写就当 WGS84（谷歌 / 天地图 / SpaceNet）
        if self.kind == "webmerc":
            # 截图: 中心经纬度 + 缩放级别。瓦片世界的像素宽 = 256 × 2^zoom × 截图倍率
            self.world = 256.0 * (2 ** float(d["zoom"])) * float(d.get("scale", 1))
            self.cx, self.cy = self._merc(float(d["lon"]), float(d["lat"]))
        elif self.kind != "lonlat":
            raise ValueError(f"不认识的地理参考类型 {self.kind}")

    def _merc(self, lon, lat):
        """经纬度 → Web 墨卡托世界像素（0 ~ world），x 向东、y 向南，(0, 0) 是西北角"""
        x = (lon + 180.0) / 360.0 * self.world  # 经度线性铺满
        s = math.sin(math.radians(max(-85.0, min(85.0, lat))))  # 截到 ±85°: 墨卡托在极点发散，瓦片地图也只到 ±85.05°
        # y = 0.5 - ln(tan(π/4 + φ/2)) / 2π，这里用 sinφ 写成等价的 ln((1+s)/(1-s)) / 4π
        y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * self.world
        return x, y

    def _unmerc(self, x, y):
        """Web 墨卡托世界像素 → 经纬度"""
        lon = x / self.world * 360.0 - 180.0
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / self.world))))  # _merc 的反函数（Gudermann 函数）
        return lon, lat

    def to_px(self, lon, lat):
        """
        WGS84 经纬度 → 图像像素 (x, y)。

        结果是浮点，可以落在图外（负数或超过宽高），调用方自己裁剪。
        """
        if self.datum == "gcj02":
            lon, lat = wgs84_to_gcj02(lon, lat)  # 先加密到图片的坐标系，再投影
        if self.kind == "lonlat":
            # 纬度向下递减，所以 y 用 lat0 - lat
            return (lon - self.d["lon0"]) / self.d["dlon"], (self.d["lat0"] - lat) / self.d["dlat"]
        mx, my = self._merc(lon, lat)
        return mx - self.cx + self.w / 2.0, my - self.cy + self.h / 2.0  # 图中心对应 (cx, cy)

    def to_lonlat(self, x, y):
        """图像像素 → WGS84 经纬度（to_px 的逆，顺序反过来: 先反投影，再把 GCJ-02 解密回 WGS84）"""
        if self.kind == "lonlat":
            lon, lat = self.d["lon0"] + x * self.d["dlon"], self.d["lat0"] - y * self.d["dlat"]
        else:
            lon, lat = self._unmerc(x - self.w / 2.0 + self.cx, y - self.h / 2.0 + self.cy)
        return gcj02_to_wgs84(lon, lat) if self.datum == "gcj02" else (lon, lat)

    def bbox(self, pad_px=0):
        """图像范围（外扩 pad_px 像素）的 WGS84 包围盒 (南, 西, 北, 东)，给 Overpass 查询用"""
        # 取四个角再求最值: GCJ-02 偏移让图像边缘在经纬度上不严格平行，只看两个角可能漏一窄条
        pts = [self.to_lonlat(x, y) for x in (-pad_px, self.w + pad_px) for y in (-pad_px, self.h + pad_px)]
        lons, lats = [p[0] for p in pts], [p[1] for p in pts]
        return min(lats), min(lons), max(lats), max(lons)

    def mpp(self):
        """
        图中心处的米/像素。

        在图中心左右各取 50 像素（共 100 像素）的两点，按球面近似（等距圆柱，小范围足够准）量出地面距离再除以 100。
        墨卡托的比例尺随纬度变，所以只代表图中心；几公里的图上下边缘差不到 0.1%。
        """
        lon_a, lat_a = self.to_lonlat(self.w / 2 - 50, self.h / 2)
        lon_b, lat_b = self.to_lonlat(self.w / 2 + 50, self.h / 2)
        dx = math.radians(lon_b - lon_a) * R_EARTH * math.cos(math.radians((lat_a + lat_b) / 2))  # 东西向米数，乘 cos(纬度)
        dy = math.radians(lat_b - lat_a) * R_EARTH  # GCJ-02 下两点纬度可能略有差，也算进去
        return math.hypot(dx, dy) / 100.0


# ----------------------------------------------------------------------------
# 取数据
# ----------------------------------------------------------------------------
def query(bbox):
    """
    Overpass 查询: 道路、水系、绿地 / 公园 / 停车场 / 广场、建筑，几何直接内联（out geom）。

    Args:
        bbox: (南, 西, 北, 东)，度，Overpass QL 要求的就是这个顺序
    Returns:
        Overpass QL 字符串。out geom 让每个 way 直接带 [{lat, lon}] 坐标，relation 的成员也带，
        省掉再查一遍 node；timeout 90 秒，城区几平方公里够用。
    """
    s, w, n, e = bbox
    b = f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"  # 6 位小数 ≈ 0.1m，同一范围生成的字符串固定，缓存键才稳定
    return f"""[out:json][timeout:90];
(
  way["highway"]{b};
  way["natural"="water"]{b}; relation["natural"="water"]{b};
  way["waterway"]{b}; relation["waterway"="riverbank"]{b};
  way["landuse"~"^(reservoir|basin|grass|meadow|forest|farmland|orchard|village_green|recreation_ground)$"]{b};
  way["leisure"~"^(park|garden|pitch|playground)$"]{b}; relation["leisure"="park"]{b};
  way["amenity"="parking"]{b};
  way["place"="square"]{b}; way["highway"="pedestrian"]["area"="yes"]{b};
  way["building"]{b}; relation["building"]{b};
);
out geom;"""


def fetch(bbox, cache=True, retries=3):
    """取 Overpass 数据（带磁盘缓存）。失败重试，间隔递增；还是失败就抛异常，调用方决定要不要降级"""
    q = query(bbox)
    CACHE.mkdir(parents=True, exist_ok=True)
    # 缓存键 = 查询语句的 md5 前 12 位: 范围或查询内容一变就是新文件，不会拿到旧查询的结果
    f = CACHE / f"osm_{hashlib.md5(q.encode()).hexdigest()[:12]}.json"
    if cache and f.exists():
        return json.loads(f.read_text("utf-8"))
    body = urllib.parse.urlencode({"data": q}).encode()  # POST 表单 data=<QL>，比 GET 不受 URL 长度限制
    last = None  # 最后一次的异常，全失败时报出来
    for k in range(retries * len(OVERPASS)):  # 每台服务器各试 retries 次
        url = OVERPASS[k % len(OVERPASS)]  # 轮流换服务器
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:  # 比查询的 90 秒多留 30 秒传输
                data = json.loads(r.read())
            f.write_text(json.dumps(data), "utf-8")  # 只缓存成功的结果
            return data
        except Exception as e:  # 429 限流 / 超时: 等一会儿再试
            last = e
            time.sleep(3 * (k // len(OVERPASS) + 1))  # 每轮换完一圈服务器，等待加 3 秒: 3, 6, 9 …
    raise RuntimeError(f"Overpass 取数据失败: {last}")


# ----------------------------------------------------------------------------
# OSM → 像素坐标的要素
# ----------------------------------------------------------------------------
def _ring(geom, gr):
    """Overpass 的 geometry（[{lat, lon}...]）→ 像素坐标 (N,2) 数组"""
    return np.array([gr.to_px(p["lon"], p["lat"]) for p in geom], np.float64)


def _width(tags, cls):
    """
    道路总宽（米）: 有 width 标签用它；有 lanes 用 车道数 × 3.5；都没有按等级。

    Args:
        tags: OSM way 的标签字典（值都是字符串）
        cls: highway 等级，必须是 ROAD_WIDTH 的键
    Returns:
        双向总宽，米
    """
    try:
        if "width" in tags:
            # width 可能写成 "12 m"，只取第一个词；下限 3m 防止误填的 0 / 1
            return max(3.0, float(str(tags["width"]).split()[0]))
        if "lanes" in tags:
            n = int(str(tags["lanes"]).split(";")[0])  # 偶有 "2;3" 这种多值，取第一个
            # 3.5m 是国内城市道路标准车道宽；双向路多加 1m 当中间的分隔线 / 小隔离带；下限 4m
            return max(4.0, n * 3.5 + (0 if tags.get("oneway") == "yes" else 1.0))
    except ValueError:
        pass  # "narrow"、"2.5m"（没空格）之类解析不了的，退回按等级
    return float(ROAD_WIDTH[cls])


def features(osm, gr):
    """
    Overpass JSON → 像素坐标的要素:
        roads     [{pts, cls, width_m, oneway, elevated}]   车行道中心线
        water     [多边形]    水面（面状水体 + 河道线扩成的面）
        green     [多边形]    草地 / 林地 / 农田
        park      [多边形]    公园 / 花园 / 运动场
        parking   [多边形]    停车场
        plaza     [多边形]    广场 / 步行街面
        buildings [{poly, kind, floors}]   建筑轮廓（kind 按 building 标签粗分，floors 来自 building:levels）
        waterways [{pts, width_m}]  河道中心线（features 内部已扩成面，另外保留给调试）
    """
    out = {k: [] for k in ("roads", "water", "green", "park", "parking", "plaza", "buildings", "waterways")}
    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        # relation（多边形带洞的）: 只取外环，内环忽略（水面里的岛、公园里的湖影响不大）
        geoms = [m["geometry"] for m in el.get("members", []) if m.get("role") == "outer" and "geometry" in m] if el["type"] == "relation" else [el.get("geometry")]
        for g in geoms:
            if not g or len(g) < 2:
                continue  # 没几何（成员不在范围内）或只有一个点，画不出东西
            pts = _ring(g, gr)
            closed = len(g) >= 4 and g[0] == g[-1]  # 闭合环: 首尾同点，至少三角形（3 个不同点 + 回到起点）
            hw = tags.get("highway")
            # 分类按下面的顺序先到先得: 道路 > 步行广场 > 建筑 > 河道线 > 水面 > 公园 > 绿地 > 停车场 > 广场
            if hw in ROAD_WIDTH and tags.get("area") != "yes":
                # 长桥 + 高等级 = 高架（城市快速路 / 高架主干道）；短桥（跨河小桥）还是地面路
                bridge = tags.get("bridge") in ("yes", "viaduct") or tags.get("layer", "0") not in ("0", "-1", "-2")  # layer ≥ 1 也算架空
                length_m = float(np.hypot(*np.diff(pts, axis=0).T).sum()) * gr.mpp()  # 折线像素长 × 米/像素
                # 150m: 跨河桥一般几十米，城市高架一段动辄几百米，这个阈值把两者分开
                out["roads"].append(dict(pts=pts, cls=hw, width_m=_width(tags, hw), oneway=tags.get("oneway") == "yes",
                                         elevated=bool(bridge and hw in ELEVATED_CLASSES and length_m > 150)))
            elif hw == "pedestrian" and closed:
                out["plaza"].append(pts)
            elif "building" in tags and closed:
                b = tags["building"]
                # building 标签粗分成场景里的三类楼型: shop 底商 / block 大体量公建 / residential 住宅；
                # "yes" 等没说用途的记 auto，交给下游按面积、形状自己猜
                kind = "shop" if b in ("retail", "commercial", "supermarket") else "block" if b in ("office", "industrial", "warehouse", "hospital", "school", "university") else "residential" if b in ("residential", "apartments", "house", "detached", "dormitory") else "auto"
                try:
                    floors = int(float(tags.get("building:levels", "0")))  # 先 float 再 int: 兼容 "5.0"
                except ValueError:
                    floors = 0  # "5-6" 之类，当没写
                out["buildings"].append(dict(poly=pts, kind=kind, floors=floors or None))  # 0 层 → None，表示「未知」
            elif tags.get("waterway") in WATERWAY_WIDTH and not closed:
                # 河道线: 有 width 标签用它（米），否则按河流等级的典型宽度
                try:
                    wm = float(str(tags.get("width", WATERWAY_WIDTH[tags["waterway"]])).split()[0])
                except ValueError:
                    wm = WATERWAY_WIDTH[tags["waterway"]]  # width 写得乱就退回默认
                out["waterways"].append(dict(pts=pts, width_m=wm))
            elif closed and (tags.get("natural") == "water" or tags.get("waterway") == "riverbank" or tags.get("landuse") in ("reservoir", "basin")):
                out["water"].append(pts)
            elif closed and tags.get("leisure") in ("park", "garden", "pitch", "playground"):
                out["park"].append(pts)
            elif closed and tags.get("landuse") in ("grass", "meadow", "forest", "farmland", "orchard", "village_green", "recreation_ground"):
                out["green"].append(pts)
            elif closed and tags.get("amenity") == "parking":
                out["parking"].append(pts)
            elif closed and tags.get("place") == "square":
                out["plaza"].append(pts)
    return out


def shift(feats, dx, dy):
    """
    所有要素整体平移 (dx, dy) 像素（自动对齐的结果套上去）。

    Args:
        feats: features() 的结果（不会被改）
        dx, dy: 像素偏移，align_roads() 的前两个返回值
    Returns:
        新的要素字典，结构和 feats 相同；坐标数组是新数组（numpy 加法不会原地改）
    """
    out = {}
    for k, v in feats.items():
        if k in ("roads", "waterways"):
            out[k] = [dict(r, pts=r["pts"] + [dx, dy]) for r in v]  # 字典要素: 复制其他字段，只换坐标
        elif k == "buildings":
            out[k] = [dict(b, poly=b["poly"] + [dx, dy]) for b in v]
        else:
            out[k] = [p + [dx, dy] for p in v]  # 其余都是纯多边形数组
    return out


# ----------------------------------------------------------------------------
# 自动对齐
# ----------------------------------------------------------------------------
def road_likelihood(img):
    """
    「像路面」的程度（0~1 浮点图）: 低饱和（灰）× 非植被 × 局部平滑。
    不追求准确 —— 只拿来给整条路网找对齐偏移: 几百米长的中心线整体平移，对上灰色带子时得分最高。
    """
    f = cv2.GaussianBlur(img, (5, 5), 0).astype(np.float32)  # 先去噪，免得 JPEG 块和车辆影响饱和度
    sat = f.max(-1) - f.min(-1)  # 饱和度的近似
    gray = np.clip(1.0 - sat / 40.0, 0, 1)  # 越灰越像路；通道差 ≥ 40（0~255）就算彩色，记 0
    b, g, r = f[..., 0] + 1, f[..., 1] + 1, f[..., 2] + 1  # +1 防全黑像素除零
    exg = (2 * g - r - b) / (r + g + b)  # 归一化过绿指数 ExG，植被 > 0
    notveg = np.clip(1.0 - exg / 0.08, 0, 1)  # ExG ≥ 0.08 视为植被（树荫下的路也会被压低，可接受）
    v = img.max(-1).astype(np.float32)  # 亮度取 HSV 的 V
    std = cv2.GaussianBlur(v * v, (9, 9), 0) - cv2.GaussianBlur(v, (9, 9), 0) ** 2  # 局部方差: 屋顶纹理多，路面平
    smooth = np.clip(1.0 - np.sqrt(np.maximum(std, 0)) / 30.0, 0, 1)  # 标准差 ≥ 30 记 0；max(…,0) 防浮点误差出负方差
    return gray * notveg * (0.5 + 0.5 * smooth)  # 平滑度只打五折以内: 路上有车 / 斑马线时不至于整段清零


def align_roads(img, feats, mpp, search_m=30.0, min_gain=0.08):
    """
    在 ±search_m 米的范围里平移 OSM 路网，找中心线平均「像路面」程度最高的偏移。
    先 4 像素步长粗搜，再在最优点附近 1 像素细搜。路太少（总长 < 200m）不对齐。
    Returns: (dx, dy, 得分提升比例)。提升 < min_gain 时认为没把握（可能是影像比 OSM 旧、新修的路图上还没有），不挪
    """
    h, w = img.shape[:2]
    # 第一步: 把地面道路中心线画成掩膜，同时累计路网总长（米）
    lines = np.zeros((h, w), np.uint8)
    total = 0.0
    for r in feats["roads"]:
        if r["elevated"]:
            continue  # 高架在图上是桥面，和地面路不一样
        p = np.round(r["pts"]).astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(lines, [p], False, 1, max(1, int(round(r["width_m"] * 0.4 / mpp))))  # 中心 40% 宽的带子
        total += float(np.hypot(*np.diff(r["pts"], axis=0).T).sum()) * mpp
    if total < 200:
        return 0, 0, 0.0  # 路太少: 一两条短路很容易和院子、屋顶的灰色对上，宁可不挪
    # 第二步: 算「像路面」图
    like = road_likelihood(img)
    # 模糊一下: 中心线落在路面任何位置得分都一样（一段平台），模糊后路的正中最高，对齐就落在中心
    k = max(3, int(round(4.0 / mpp)) | 1)  # 核 ≈ 4m
    like = cv2.GaussianBlur(like, (k, k), 0)
    ys, xs = np.nonzero(lines)  # 中心线带子上所有像素的坐标，平移只对这些点采样
    rng = int(round(search_m / mpp))  # 搜索半径换成像素

    def score(dx, dy):
        """中心线平移 (dx, dy) 后落在图内部分的平均似然；一半以上移出图外时记 0，免得只剩几段碰巧对上"""
        x, y = xs + dx, ys + dy
        ok = (x >= 0) & (x < w) & (y >= 0) & (y < h)
        return float(like[y[ok], x[ok]].mean()) if ok.sum() > 0.5 * len(xs) else 0.0

    # 第三步: 粗搜 → 细搜。不平移时的得分作基准，最后看提升了多少
    base = score(0, 0)
    best = (base, 0, 0)  # (得分, dx, dy)
    for dy in range(-rng, rng + 1, 4):  # 4 像素步长: 模糊核约 4m，峰宽够，粗网格不会跳过
        for dx in range(-rng, rng + 1, 4):
            s = score(dx, dy)
            if s > best[0]:
                best = (s, dx, dy)
    _, bx, by = best
    for dy in range(by - 3, by + 4):  # ±3 像素细搜，正好覆盖粗网格的一个步长
        for dx in range(bx - 3, bx + 4):
            s = score(dx, dy)
            if s > best[0]:
                best = (s, dx, dy)
    gain = (best[0] - base) / max(1e-6, base)  # 相对提升；base 可能是 0（路全落在植被上），防除零
    if gain < min_gain:  # 默认 8%: 已经对齐的图随便挪一两像素也有几个百分点的噪声
        return 0, 0, gain
    return best[1], best[2], gain
