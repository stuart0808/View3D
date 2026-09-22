#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sat_server.py —— 前端「导入卫星图」的后端。只监听本机，给 Vite 开发服务器代理（/api → 这里）。

    python tools/sat_server.py            # 默认端口 8770；npm run dev 的 vite.config.js 已配好代理

接口:
    POST /api/import?name=&mpp=&lat=&lon=&zoom=&scale=&datum=&osm=1&method=auto
         请求体 = 图片文件本身（jpg / png / GeoTIFF）。存到 public/scenes/imported/<name>.<扩展名>，排队处理，
         返回 {job}。name 只允许字母数字下划线横线（它会变成文件名和 URL）
    GET  /api/jobs/<job>   进度 {state: queued|running|done|error, stage, progress 0~1, summary, error}
    GET  /api/survey?scene=<场景 id>          实地标注数据（没有就给空白的）
    PUT  /api/survey?scene=<场景 id>          请求体 = 手机上的标注数据 JSON；和服务器上的合并后存盘，返回合并结果
    POST /api/survey/apply?scene=<场景 id>    把标注写回场景，另存为 imported/<名字>-surveyed，返回 {scene}
    POST /api/draw/build?name=<名字>          请求体 = 场景编辑器画的矢量图 JSON；生成 imported/<名字>，返回 {scene, summary}
    GET  /api/scenes       已导入的场景 [{id, name, created, summary}]（同时写一份 public/scenes/imported/index.json，
                           服务没开时前端读这个静态文件也能列出来）
处理在一个后台线程里按顺序做（CPU 上一张图几十秒到几分钟，并行只会更慢）。
"""
import argparse
import json
import queue
import re
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import autoscene  # noqa: E402
import survey as sv_survey  # noqa: E402
import drawscene  # noqa: E402

OUT = HERE.parent / "public" / "scenes" / "imported"  # vite 直接把 public/ 当静态目录，前端用 /scenes/imported/<name>.json 取
SCENES = HERE.parent / "public" / "scenes"  # 所有场景（内置的在这层，导入的在 imported/ 下）
SURVEY_DIR = HERE.parent / "data" / "survey"  # 实地标注数据: 不放 public/，店名等信息不直接当静态文件发出去
SCENE_ID = re.compile(r"(imported/)?[A-Za-z0-9_\-]{1,60}")  # 场景 id 白名单: 防 ../ 跑出目录
draw_lock = threading.Lock()  # 生成场景要跑 map2scene 子进程: 同一时间只跑一个，免得两次生成同名场景互相覆盖一半
survey_lock = threading.Lock()  # 几台手机同时同步: 读-合并-写 要整体串行，否则后写的会盖掉先写的
MAX_BYTES = 200 * 1024 * 1024  # 上传上限 200MB（大 GeoTIFF）
jobs = {}  # job id → 状态 dict
work = queue.Queue()  # 待处理的 job id


def write_index():
    """扫一遍 imported 目录，写 index.json（按时间倒序）

    每次导入成功、每次前端 GET /api/scenes 都重扫一遍，而不是维护内存列表:
    这样手动删掉 / 拷进来的场景文件也能反映出来，服务重启也不丢。

    Returns:
        list[dict]: [{id: "imported/<名字>", name, created: mtime 秒, source, summary}]，
                    最新的在前；同样内容也写进 OUT/index.json 给静态读取用
    """
    items = []
    for f in OUT.glob("*.json"):
        # index.json 自己、层数等 *_sidecar.json、编辑器矢量图 *_drawing.json 都不是场景，跳过
        if f.name == "index.json" or f.stem.endswith(("_sidecar", "_drawing")):
            continue
        try:
            s = json.loads(f.read_text("utf-8"))
        except Exception:
            continue  # 写到一半 / 坏文件
        # origin 是 autoscene 写进 scene.json 的来源信息（source = 原图名，summary = 楼 / 路统计）
        o = s.get("origin", {})
        items.append({"id": f"imported/{f.stem}", "name": f.stem, "created": f.stat().st_mtime, "source": o.get("source"), "summary": o.get("summary")})
    items.sort(key=lambda d: -d["created"])
    (OUT / "index.json").write_text(json.dumps(items, ensure_ascii=False), "utf-8")
    return items


def worker():
    """后台线程: 逐个取 job 跑 autoscene.run，把进度写回 jobs

    只有一个 worker，严格串行: 检测模型 / SAM 很吃内存和 CPU（或显存），
    两张图同时跑只会互相抢资源、两张都更慢，还可能爆显存。
    HTTP 线程只读 jobs[jid] 里的字段，这里只整体改写单个键，GIL 下不需要额外加锁。
    线程是 daemon，主进程 Ctrl+C 退出时直接跟着结束（正在跑的图作废）。
    """
    while True:
        jid = work.get()  # 阻塞等下一个 job
        j = jobs[jid]
        j["state"] = "running"

        def progress(stage, p):
            """autoscene 的进度回调

            Args:
                stage: 当前阶段的中文说明（「找建筑」「下载 OSM」……），前端原样显示
                p: 整体进度 0~1；保留 3 位小数，轮询返回的 JSON 短一点
            """
            j["stage"], j["progress"] = stage, round(p, 3)

        # 输出直接写到 OUT/<名字>.json；中间产物（标签图、缓存）放 OUT/_work，不进场景列表
        try:
            j["summary"] = autoscene.run(j["image"], OUT / f"{j['name']}.json", mpp=j["mpp"], geo=j["geo"], use_osm=j["osm"],
                                         method=j["method"], progress=progress, work_dir=OUT / "_work", ref_floors=j.get("ref_floors"))
            j["state"] = "done"
            j["scene"] = f"imported/{j['name']}"
            write_index()
        except Exception as e:  # 错误原样给前端看
            traceback.print_exc()
            j["state"], j["error"] = "error", f"{type(e).__name__}: {e}"


def make_job(qs, body, ext):
    """解析参数、存图、登记 job；参数不对抛 ValueError

    Args:
        qs: urllib.parse.parse_qs 的结果，{键: [值, ...]}，每个键只取第一个值
        body: 上传的原始字节（图片文件本身，不是 multipart）
        ext: 由 Content-Type / 文件头推断的扩展名（.tif / .png / .jpg）

    Returns:
        str: 10 位十六进制 job id，前端拿它轮询 /api/jobs/<id>

    Raises:
        ValueError: 名字不合法，或者既没有 mpp 也没有经纬度+缩放级别且不是 GeoTIFF；
                    do_POST 把它转成 400 + 中文提示
    """
    def num(k):
        """查询参数里的数字，没有返回 None

        空字符串也算没有（前端表单没填时会传 name=&mpp= 这种空值）。
        填了但不是数字会抛 ValueError，正好也走 400。
        """
        v = qs.get(k, [""])[0]
        return float(v) if v not in ("", None) else None

    # 名字: 没填就用时间戳；白名单校验，防止 ../ 之类跑出目录，也保证能直接当 URL 片段
    name = qs.get("name", [""])[0] or time.strftime("sat_%Y%m%d_%H%M%S")
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,60}", name):
        raise ValueError("场景名只能用字母、数字、下划线、横线（最长 60）")
    mpp, lat, lon, zoom = num("mpp"), num("lat"), num("lon"), num("zoom")
    # 比例尺来源二选一: 直接给 米/像素，或者给瓦片地图的中心经纬度 + 缩放级别（Web 墨卡托），
    # 后者由 autoscene 按纬度算出 米/像素，并且能定位去取 OSM 数据
    geo = None
    if zoom is not None and lat is not None and lon is not None:
        # scale = 截图的设备像素比（高分屏 2x），datum = 坐标系（wgs84 / gcj02 火星坐标）
        geo = {"type": "webmerc", "lat": lat, "lon": lon, "zoom": zoom, "scale": num("scale") or 1, "datum": qs.get("datum", ["wgs84"])[0]}
    if not mpp and not geo and ext not in (".tif", ".tiff"):
        raise ValueError("需要比例尺: 填 米/像素，或者 中心经纬度 + 缩放级别（GeoTIFF 可以不填）")
    # 原图存进 _work 而不是内存: autoscene 按路径读（GeoTIFF 要 rasterio 打开文件），
    # 同名重新导入会覆盖旧原图，方便反复调参
    OUT.mkdir(parents=True, exist_ok=True)
    src = OUT / "_work" / f"{name}_source{ext}"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(body)
    # 10 位十六进制足够一次运行里不撞；jobs 只存在内存里，服务重启后旧 job 查不到（场景文件还在）
    jid = uuid.uuid4().hex[:10]
    # osm 默认开（"1"）；method = auto / roofnet / sam / color，决定用哪种建筑检测
    jobs[jid] = {"id": jid, "name": name, "image": str(src), "mpp": mpp, "geo": geo, "osm": qs.get("osm", ["1"])[0] == "1", "ref_floors": num("ref_floors"),
                 "method": qs.get("method", ["auto"])[0], "state": "queued", "stage": "排队", "progress": 0.0, "summary": None, "error": None}
    work.put(jid)
    return jid


def survey_path(scene):
    """场景 id → 标注数据文件路径；id 不合法抛 ValueError（'imported/x' 存成 imported__x.json）"""
    if not scene or not SCENE_ID.fullmatch(scene):
        raise ValueError("场景 id 不合法")
    return SURVEY_DIR / (scene.replace("/", "__") + ".json")


def load_survey(scene):
    """读一个场景的标注数据；还没有就给空白的"""
    f = survey_path(scene)
    return json.loads(f.read_text("utf-8")) if f.exists() else sv_survey.empty(scene)


def save_survey(scene, incoming):
    """把手机传上来的标注和服务器上的合并、存盘，返回合并结果

    先写临时文件再改名: 写到一半断电也不会留下半截 JSON 把之前的数据弄坏。
    """
    with survey_lock:
        merged = sv_survey.merge(load_survey(scene), dict(incoming, scene=scene))
        f = survey_path(scene)
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(merged, ensure_ascii=False), "utf-8")
        tmp.replace(f)
    return merged


def apply_survey(scene):
    """把标注写回场景，另存为 imported/<名字>-surveyed.json（不动原场景），返回新场景 id

    已经是回写过的场景（场景里有 surveyOf）就用它指向的那份标注、并覆盖自己，
    这样在回写后的场景上继续标、再回写，不会一层层生成 -surveyed-surveyed。
    """
    survey_path(scene)  # 校验 id
    src = SCENES / f"{scene}.json"
    if not src.exists():
        raise ValueError(f"场景 {scene} 不存在")
    data = json.loads(src.read_text("utf-8"))
    base = scene.split("/")[-1]
    name = base if base.endswith("-surveyed") else f"{base}-surveyed"
    out = sv_survey.apply_survey(data, load_survey(data.get("surveyOf") or scene))
    # 内置场景在上一层目录: 底图地址是相对场景文件的，挪到 imported/ 后要补 ../
    if out.get("imagery") and not scene.startswith("imported/"):
        out["imagery"]["url"] = "../" + out["imagery"]["url"]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.json").write_text(json.dumps(out, ensure_ascii=False), "utf-8")
    write_index()
    return f"imported/{name}"


def build_drawing(name, drawing):
    """场景编辑器的矢量图 → imported/<名字>.json（同名覆盖，方便反复改了再生成），返回 (场景 id, 摘要)"""
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,60}", name or ""):
        raise ValueError("场景名只能用字母、数字、下划线、横线（最长 60）")
    with draw_lock:
        summary = drawscene.build(drawing, OUT / f"{name}.json", work_dir=OUT / "_work")
    write_index()
    return f"imported/{name}", summary


class Handler(BaseHTTPRequestHandler):
    """/api/* 路由；其余 404"""

    def log_message(self, *a):
        pass  # 不打访问日志

    def _send(self, obj, code=200):
        """把 obj 序列化成 JSON 回给前端

        ensure_ascii=False 让中文错误提示原样发出（UTF-8）；no-store 防止浏览器缓存
        进度轮询的结果，否则进度条会卡住不动。
        """
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        """GET /api/scenes 列场景；GET /api/jobs/<id> 查进度；其余 404"""
        path = urllib.parse.urlparse(self.path).path  # 去掉 ?query（前端会加时间戳防缓存）
        if path == "/api/scenes":
            return self._send(write_index())
        if path == "/api/survey":
            try:
                return self._send(load_survey(self._scene()))
            except ValueError as e:
                return self._send({"error": str(e)}, 400)
        m = re.fullmatch(r"/api/jobs/([0-9a-f]+)", path)
        if m and m.group(1) in jobs:
            j = jobs[m.group(1)]
            # 只挑前端要的字段（不暴露服务器上的原图路径等）；scene 完成后才有
            return self._send({k: j[k] for k in ("id", "name", "state", "stage", "progress", "summary", "error")} | {"scene": j.get("scene")})
        self._send({"error": "not found"}, 404)

    def _scene(self):
        """查询串里的 scene 参数（没有给空串，交给 survey_path 报错）"""
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("scene", [""])[0]

    def _json_body(self, limit=20 * 1024 * 1024):
        """读 JSON 请求体（标注数据，上限 20MB）；不合法抛 ValueError"""
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= limit:
            raise ValueError("请求体为空或太大")
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"不是合法的 JSON: {e}")

    def do_PUT(self):
        """PUT /api/survey?scene=: 上传手机上的标注，合并后返回服务器上的完整数据"""
        if urllib.parse.urlparse(self.path).path != "/api/survey":
            return self._send({"error": "not found"}, 404)
        try:
            body = self._json_body()
            if not isinstance(body, dict) or not isinstance(body.get("shops", []), list):
                raise ValueError("标注数据格式不对")
            return self._send(save_survey(self._scene(), body))
        except ValueError as e:
            return self._send({"error": str(e)}, 400)

    def do_POST(self):
        """POST /api/import: 请求体是图片本身，参数全在查询串里；立即返回 job id，不等处理完
        POST /api/survey/apply?scene=: 把标注写回场景"""
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/draw/build":
            try:
                body = self._json_body(limit=80 * 1024 * 1024)  # 可能带 base64 底图，放宽到 80MB
                sid, summary = build_drawing(urllib.parse.parse_qs(u.query).get("name", [""])[0], body)
                return self._send({"scene": sid, "summary": summary})
            except ValueError as e:
                return self._send({"error": str(e)}, 400)
            except RuntimeError as e:  # map2scene 失败: 日志末尾给前端看
                return self._send({"error": str(e)}, 500)
        if u.path == "/api/survey/apply":
            try:
                return self._send({"scene": apply_survey(self._scene())})
            except ValueError as e:
                return self._send({"error": str(e)}, 400)
        if u.path != "/api/import":
            return self._send({"error": "not found"}, 404)
        # 先看 Content-Length 再读，超限的不读进内存；没有长度头（分块传输）按 0 处理直接拒绝
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_BYTES:
            return self._send({"error": "图片为空或超过 200MB"}, 400)
        body = self.rfile.read(n)
        # 浏览器对 .tif 常给 application/octet-stream，所以再看文件头: II*\0 小端 / MM\0* 大端 TIFF
        ctype = (self.headers.get("Content-Type") or "").lower()
        ext = ".tif" if "tif" in ctype or body[:4] in (b"II*\x00", b"MM\x00*") else ".png" if "png" in ctype else ".jpg"  # 按类型 / 文件头判断
        try:
            jid = make_job(urllib.parse.parse_qs(u.query), body, ext)
        except ValueError as e:
            return self._send({"error": str(e)}, 400)
        self._send({"job": jid})


def main():
    """起服务 + 后台处理线程

    只绑 127.0.0.1: 这个服务能往 public/ 写文件，不该暴露到局域网；
    前端通过 Vite 的 /api 代理访问，所以不需要 CORS 头。
    """
    ap = argparse.ArgumentParser(description="卫星图导入服务（给前端用）")
    ap.add_argument("--port", type=int, default=8770)  # 要和 vite.config.js 里代理的端口一致
    a = ap.parse_args()
    threading.Thread(target=worker, daemon=True).start()
    # 启动时先刷新一次 index.json，服务关着时导入 / 删除的场景也能对上
    OUT.mkdir(parents=True, exist_ok=True)
    write_index()
    print(f"[sat_server] http://127.0.0.1:{a.port}/api  （输出到 {OUT}）", flush=True)
    # ThreadingHTTPServer: 每个请求一个线程，上传大图时进度轮询不会被卡住
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
