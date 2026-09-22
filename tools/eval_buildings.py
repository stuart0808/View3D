#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
eval_buildings.py —— 用带真值的样例图（fetch_samples.py 下载的 sn_*.jpg + sn_*_gt.json）评测自动找建筑的效果。

指标:
    P / R / F1   SpaceNet 的标准: 预测和真值按 IoU 贪心一一配对，IoU ≥ 0.5 算命中
    像素 IoU      所有预测的并集 vs 所有真值的并集（不管是不是一栋一栋分开的）
    覆盖召回      真值楼有 ≥ 50% 面积被某个预测盖住的比例 —— 挨着的几户被合成一块时 F1 算错，但对建模其实够用
    用时          SAM 推理（有缓存时为 0）+ 筛选

SAM 的原始掩膜（satgeo.segment_raw 的结果）缓存在 tools/samples/cache/，只改筛选规则时不用重跑 SAM:
    python tools/eval_buildings.py                  # 所有带真值的样例
    python tools/eval_buildings.py sh_dense paris   # 指定几个
    python tools/eval_buildings.py --no-cache       # 改了提示点 / 分割部分后，重跑 SAM
    python tools/eval_buildings.py --vis            # 另存叠加图: 真值绿、预测红（命中的预测黄）
"""
import argparse
import json
import pickle
import sys
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent  # tools/ 目录；样例、模型都相对它找
sys.path.insert(0, str(HERE))  # 让同目录的 satgeo / sat2marks / roofnet 能直接 import
import satgeo as sg  # noqa: E402

SAMPLES = HERE / "samples"  # fetch_samples.py 的输出目录
CACHE = SAMPLES / "cache"  # SAM 原始掩膜缓存 + 叠加图


def load_sample(name):
    """
    读样例图和真值；真值多边形栅格化成实例编号图（0 = 背景，i+1 = 第 i 栋）。

    Args:
        name: 样例名，对应 samples/sn_<name>.jpg 和 sn_<name>_gt.json
    Returns:
        (img, mpp, inst): BGR 图、每像素米数（方像素，x / y 相同）、int32 实例编号图
    """
    # np.fromfile + imdecode 而不是 imread: Windows 上中文路径 imread 读不了
    img = cv2.imdecode(np.fromfile(str(SAMPLES / f"sn_{name}.jpg"), np.uint8), cv2.IMREAD_COLOR)
    # 真值 JSON: {"mpp": 米/像素, "buildings": [[[x, y], ...], ...]}，坐标是图像像素（可带小数）
    gt = json.loads((SAMPLES / f"sn_{name}_gt.json").read_text("utf-8"))
    inst = np.zeros(img.shape[:2], np.int32)  # int32: 楼数可能超过 255，不能用 uint8
    for i, poly in enumerate(gt["buildings"]):
        pts = np.round(np.array(poly, np.float64)).astype(np.int32).reshape(-1, 1, 2)  # fillPoly 要 (N, 1, 2) 整数点
        cv2.fillPoly(inst, [pts], i + 1)  # 后画的盖住先画的（真值里偶有重叠），无所谓
    return img, gt["mpp"], inst


def make_segmenter(model, device):
    """
    和 sat2marks 一样的 SAM「全图分割」函数；没装 SAM 返回 None（颜色连通块兜底）。

    Args:
        model: MobileSAM 权重路径
        device: "cpu" / "cuda"
    Returns:
        segment_all 可调用对象，或 None
    """
    try:
        import sat2marks  # 延迟导入: 它会拉 torch，--no-sam 时不必付这个启动开销
        # 8×8 空图只是占位，SamBackend 构造要一张图；真正的图由 segment_all 每次传入
        return sat2marks.SamBackend(np.zeros((8, 8, 3), np.uint8), model, device).make_segment_all()
    except Exception as e:  # 没装 torch / ultralytics
        print(f"[eval] SAM 不可用（{e}），用颜色连通块兜底", file=sys.stderr)
        return None


def raw_masks(name, img, seg, stride, use_cache):
    """
    第一步（慢）: SAM 原始掩膜，按 名字 + 提示点间距 缓存。

    Args:
        name: 样例名（缓存文件名的一部分）
        img: BGR 图
        seg: make_segmenter 的结果；None 时 segment_raw 走颜色连通块
        stride: 大连通块里补提示点的间距（像素）
        use_cache: False 时忽略已有缓存、重跑并覆盖
    Returns:
        (raw, 秒数): raw 是 segment_raw 的原始掩膜列表；命中缓存时秒数记 0
    """
    CACHE.mkdir(parents=True, exist_ok=True)
    # 有 / 没有 SAM 的结果差别很大，文件名分开，免得两种互相顶替
    f = CACHE / f"{name}_s{stride}{'' if seg else '_noSAM'}.pkl"
    if use_cache and f.exists():
        with open(f, "rb") as fh:
            return pickle.load(fh), 0.0  # 缓存命中不算 SAM 用时
    t0 = time.time()
    # 进度打到 stderr，stdout 只留最后的表格，方便重定向保存
    raw = sg.segment_raw(img, seg, stride=stride, progress=lambda a, b: print(f"[eval] {name}: 块 {a}/{b}", file=sys.stderr, flush=True))
    with open(f, "wb") as fh:
        pickle.dump(raw, fh)
    return raw, time.time() - t0


def score(pred, inst):
    """
    pred: 候选裁剪块列表；inst: 真值实例编号图。
    Returns: dict(tp, fp, fn, P, R, F1, pix_iou, cover_R, hits) —— hits 是每个预测是否命中（画图用）

    裁剪块格式 (x0, y0, sub): sub 是 bool 掩膜，左上角在整图的 (x0, y0) 像素处。
    只在裁剪窗口内算交集，不必每个预测都铺一张整图大小的掩膜。
    """
    n_gt = int(inst.max())  # 实例编号连续，最大值就是真值楼数
    gt_area = np.bincount(inst.ravel(), minlength=n_gt + 1)  # 每栋真值楼的像素数
    pairs = []  # (IoU, 预测下标, 真值编号)
    covered = np.zeros(n_gt + 1)  # 每栋真值楼被预测盖住的像素数（多个预测累加）
    union_pred = np.zeros(inst.shape, bool)
    for k, (x0, y0, sub) in enumerate(pred):
        win = inst[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]]  # 真值图上和预测同位置的窗口
        ids, cnt = np.unique(win[sub], return_counts=True)  # 这个预测盖住了哪些真值楼、各多少像素
        for gid, c in zip(ids, cnt):
            if gid == 0:
                continue  # 盖在背景上的部分只影响 IoU 分母，不单独计
            covered[gid] += c
            iou = c / (sub.sum() + gt_area[gid] - c)  # 交 / 并 = c / (预测面积 + 真值面积 - c)
            if iou >= 0.5:  # SpaceNet 的阈值；≥ 0.5 时一对一配对是唯一的（不可能同时和两栋都 > 0.5）
                pairs.append((iou, k, gid))
        union_pred[y0:y0 + sub.shape[0], x0:x0 + sub.shape[1]] |= sub
    # 贪心一一配对（IoU ≥ 0.5 时一个预测最多配一个真值，反之亦然）
    used_p, used_g = set(), set()
    for iou, k, gid in sorted(pairs, reverse=True):
        if k in used_p or gid in used_g:
            continue
        used_p.add(k)
        used_g.add(gid)
    tp = len(used_p)
    fp, fn = len(pred) - tp, n_gt - tp  # 没配上的预测 = 误检，没配上的真值 = 漏检
    P = tp / max(1, len(pred))  # max(1, …) 防空列表除零；没有预测时 P 记 0
    R = tp / max(1, n_gt)
    gt_any = inst > 0  # 真值并集（不分实例），给像素 IoU 用
    # 覆盖召回: 被预测盖住 ≥ 50% 面积的真值楼占比（下标 0 是背景，跳过）；没有真值楼时记 0
    return dict(tp=tp, fp=fp, fn=fn, P=P, R=R, F1=2 * P * R / max(1e-9, P + R),
                pix_iou=float((union_pred & gt_any).sum() / max(1, (union_pred | gt_any).sum())),
                cover_R=float((covered[1:] >= 0.5 * gt_area[1:]).mean()) if n_gt else 0.0,
                hits=[k in used_p for k in range(len(pred))])


def draw(img, inst, pred, hits, path):
    """
    叠加图: 真值轮廓绿，命中的预测黄，没命中的预测红。

    Args:
        img: 原图（BGR，不会被改）
        inst: 真值实例编号图
        pred: 预测裁剪块列表 (x0, y0, sub)
        hits: score() 返回的 hits，和 pred 一一对应
        path: 输出 jpg 路径
    """
    vis = img.copy()
    # 形态学梯度 = 膨胀 - 腐蚀，得到约 2 像素宽的真值外轮廓；相邻楼之间的缝也会画出来
    gt_edge = cv2.morphologyEx((inst > 0).astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    vis[gt_edge] = (0, 255, 0)  # OpenCV 是 BGR，这是纯绿
    for (x0, y0, sub), hit in zip(pred, hits):
        cnts, _ = cv2.findContours(sub.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        # 轮廓点是裁剪块内坐标，加上 (x0, y0) 回到整图；BGR (0,220,255) 黄 / (0,0,255) 红，线宽 2
        cv2.drawContours(vis, [c + [x0, y0] for c in cnts], -1, (0, 220, 255) if hit else (0, 0, 255), 2)
    cv2.imencode(".jpg", vis, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tofile(str(path))  # 同样绕开中文路径问题


def main():
    """逐个样例评测，最后打一张表"""
    ap = argparse.ArgumentParser(description="评测自动找建筑", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("names", nargs="*", help="样例名（sn_<名字>.jpg），默认全部")
    ap.add_argument("--stride", type=int, default=40, help="大连通块里补提示点的间距（像素）")
    ap.add_argument("--no-cache", action="store_true", help="不用 SAM 缓存，重跑")
    ap.add_argument("--no-sam", action="store_true", help="不用 SAM，颜色连通块兜底")
    ap.add_argument("--model", default=str(HERE / "mobile_sam.pt"))
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--vis", action="store_true", help="存叠加图到 samples/cache/<名字>_eval.jpg")
    ap.add_argument("--method", choices=["sam", "roofnet"], default="sam", help="sam = SAM 候选 + 筛选；roofnet = 屋顶分割网络")
    args = ap.parse_args()
    # 没指定就取所有带真值的样例: 文件名 sn_<名字>_gt.json 去掉前 3 个字符 "sn_" 和后 3 个 "_gt"
    names = args.names or sorted(p.stem[3:-3] for p in SAMPLES.glob("sn_*_gt.json"))
    # roofnet 路线不用 SAM，也就不用加载模型（加载要好几秒）
    seg = None if (args.no_sam or args.method == "roofnet") else make_segmenter(args.model, args.device)
    rows = []
    for name in names:
        img, mpp, inst = load_sample(name)
        if args.method == "roofnet":  # 网络推理（不缓存，几秒钟）
            import roofnet
            t0 = time.time()
            probs = roofnet.predict(img, mpp)  # 第二版多一个道路通道，这里只用前两个
            pred = roofnet.instances(probs[0], probs[1], mpp)
            t_sam, t_pick = time.time() - t0, 0.0  # 网络一步到位，整段时间记在「SAM」列里
        else:
            # SAM 路线分两步: 原始掩膜（慢、可缓存）→ 筛选（快，调规则时只重跑这步）
            raw, t_sam = raw_masks(name, img, seg, args.stride, not args.no_cache)
            t0 = time.time()
            pred = [c["crop"] for c in sg.pick_buildings(img, mpp, raw)]  # 候选 dict 里只取裁剪掩膜
            t_pick = time.time() - t0
        r = score(pred, inst)
        rows.append((name, int(inst.max()), len(pred), r, t_sam, t_pick))  # 先攒起来，最后统一打表
        if args.vis:
            draw(img, inst, pred, r["hits"], CACHE / f"{name}_{args.method}_eval.jpg")
    # 表格: 左对齐名字 + 右对齐数值列；中文表头按字符数算宽，终端里可能略错位，不影响读数
    print(f"{'样例':<12}{'真值':>6}{'预测':>6}{'P':>7}{'R':>7}{'F1':>7}{'像素IoU':>9}{'覆盖召回':>9}{'SAM s':>8}{'筛选 s':>8}")
    for name, n_gt, n_pred, r, t_sam, t_pick in rows:
        print(f"{name:<12}{n_gt:>6}{n_pred:>6}{r['P']:>7.2f}{r['R']:>7.2f}{r['F1']:>7.2f}{r['pix_iou']:>9.2f}{r['cover_R']:>9.2f}{t_sam:>8.0f}{t_pick:>8.1f}")
    # 汇总: 各样例的简单平均（不按楼数加权），每张图权重相同
    f1 = np.mean([r["F1"] for *_, r, _, _ in [(a, b, c, d, e, f) for a, b, c, d, e, f in rows]]) if rows else 0
    print(f"平均 F1 {f1:.3f}，平均像素 IoU {np.mean([r['pix_iou'] for _, _, _, r, _, _ in rows]):.3f}，平均覆盖召回 {np.mean([r['cover_R'] for _, _, _, r, _, _ in rows]):.3f}")


if __name__ == "__main__":
    main()
