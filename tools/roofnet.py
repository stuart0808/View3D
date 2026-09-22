#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
roofnet.py —— 卫星图建筑分割小网络（训练 + 推理）。

为什么不只用 SAM: SAM 是「点一下分一块」的通用分割，高层小区这种楼与楼之间隔着树和影子的图很好用，
但国内村镇 / 老城区那种挨家挨户、屋顶只有 30×30 像素的房子，一个点常把好几户连成一块，
实测（上海 SpaceNet 样例）SAM 候选 F1 只有 0.1~0.2。这里用 SpaceNet 的人工标注训练一个专门的屋顶分割网络。

模型: ResNet18（ImageNet 预训练）编码器 + U-Net 解码器，输出两个通道:
    建筑    这个像素是不是屋顶
    边界    这个像素是不是某栋楼的轮廓线 —— 挨着的两栋楼中间那条缝。推理时「建筑 − 边界」得到每栋楼的内核，
            当作分水岭的种子，把连成一片的房子拆开
输入统一成 0.3 m/像素（SpaceNet 的分辨率）；推理时先把图缩放到这个分辨率，结果再缩回去。

训练数据: fetch_samples.py --train N 下载的瓦片（tools/samples/train/），评测场景的瓦片不在里面。
增广模拟「网络地图截图」和 WorldView 影像的差别: 缩放 0.75~1.33（分辨率 0.22~0.4m）、旋转翻转、
亮度 / 对比度 / 饱和度 / 色相抖动、模糊、JPEG 压缩。

    python tools/roofnet.py train --iters 4000          # CPU 约 1 小时；有 CUDA 自动用
    python tools/roofnet.py predict 图.jpg --mpp 0.3     # 出一张叠加图看效果
权重存在 tools/roofnet.pt（不进仓库，约 25MB）。
"""
import argparse
import json
import math
import random
import sys
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
WEIGHTS = HERE / "roofnet.pt"
TRAIN_DIR = HERE / "samples" / "train"
NET_MPP = 0.3  # 网络训练时的分辨率（米/像素）
MEAN = np.array([0.485, 0.456, 0.406], np.float32)  # ImageNet 的均值 / 方差（RGB 顺序），预训练编码器要这个归一化
STD = np.array([0.229, 0.224, 0.225], np.float32)


# ----------------------------------------------------------------------------
# 模型
# ----------------------------------------------------------------------------
def build_model(pretrained=True):
    """ResNet18 编码器 + U-Net 解码器。torch 在函数里 import: 只用推理结果的模块（比如测试）不必装 torch

    Args:
        pretrained: True = 编码器用 ImageNet 预训练权重初始化（训练时用，要联网下载一次）；
                    推理时传 False，反正马上会被 roofnet.pt 覆盖，省得下载

    Returns:
        nn.Module: 输入 (N,3,H,W) 归一化 RGB，输出 (N,2,H,W) logit；H、W 最好是 32 的倍数
    """
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    from torchvision.models import ResNet18_Weights, resnet18

    class Up(nn.Module):
        """解码一级: 上采样 ×2，和同尺度的编码特征拼接，两个 3×3 卷积"""

        def __init__(self, cin, cskip, cout):
            super().__init__()
            self.conv = nn.Sequential(
                nn.Conv2d(cin + cskip, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
                nn.Conv2d(cout, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))

        def forward(self, x, skip):
            """x: (N,cin,h,w) 深层特征；skip: (N,cskip,2h,2w) 编码器同尺度特征 → (N,cout,2h,2w)"""
            # 插值到 skip 的精确尺寸而不是固定 ×2: 输入边长不是 32 倍数时各级尺寸会差 1，这样拼接不报错
            x = F.interpolate(x, size=skip.shape[-2:], mode="bilinear", align_corners=False)
            return self.conv(torch.cat([x, skip], 1))

    class RoofNet(nn.Module):
        """编码器各级分辨率: 1/2（stem）、1/4、1/8、1/16、1/32；解码逐级回到 1/2，最后插值回原尺寸"""

        def __init__(self):
            super().__init__()
            r = resnet18(weights=ResNet18_Weights.IMAGENET1K_V1 if pretrained else None)
            self.stem = nn.Sequential(r.conv1, r.bn1, r.relu)  # 1/2, 64 通道
            self.pool = r.maxpool  # 1/2 → 1/4
            self.l1, self.l2, self.l3, self.l4 = r.layer1, r.layer2, r.layer3, r.layer4  # 64 / 128 / 256 / 512 通道
            # 解码器: Up(深层通道, 跳连通道, 输出通道)，通道数逐级减半；
            # 最后一级只留 32 通道 —— 两个输出通道用不着更多，省 CPU 推理时间
            self.u4 = Up(512, 256, 256)  # 1/32 → 1/16，拼 l3
            self.u3 = Up(256, 128, 128)  # 1/16 → 1/8，拼 l2
            self.u2 = Up(128, 64, 64)  # 1/8 → 1/4，拼 l1
            self.u1 = Up(64, 64, 32)  # 1/4 → 1/2，拼 stem
            self.head = nn.Conv2d(32, 2, 1)  # 通道 0 = 建筑，1 = 边界（都是 logit）

        def forward(self, x):
            """(N,3,H,W) → (N,2,H,W) logit；sigmoid 在外面做（训练用 *_with_logits 损失，数值更稳）"""
            # 编码: 逐级下采样，留住每级特征给解码器跳连
            s = self.stem(x)
            e1 = self.l1(self.pool(s))
            e2 = self.l2(e1)
            e3 = self.l3(e2)
            e4 = self.l4(e3)
            # 解码: 从 1/32 一路拼回 1/2；最后 1/2 → 原尺寸用双线性插值（屋顶边缘精度靠边界通道补）
            d = self.u4(e4, e3)
            d = self.u3(d, e2)
            d = self.u2(d, e1)
            d = self.u1(d, s)
            return F.interpolate(self.head(d), size=x.shape[-2:], mode="bilinear", align_corners=False)

    return RoofNet()


def to_tensor(img_bgr):
    """BGR uint8 (H,W,3) → 归一化的 RGB float 张量 (3,H,W)

    OpenCV 读出来是 BGR，ImageNet 预训练编码器要 RGB，所以先反转通道；
    再 /255 缩到 0~1，按 MEAN / STD 标准化。返回的张量在 CPU 上，调用方自己 .to(dev)。
    """
    import torch
    # ascontiguousarray: [..., ::-1] 和 transpose 产生的是负步长视图，torch.from_numpy 不接受
    x = (img_bgr[..., ::-1].astype(np.float32) / 255.0 - MEAN) / STD
    return torch.from_numpy(np.ascontiguousarray(x.transpose(2, 0, 1)))


# ----------------------------------------------------------------------------
# 训练
# ----------------------------------------------------------------------------
def augment(img, mask, rng, size):
    """
    随机增广 + 随机裁 size × size。mask: 0 背景 / 1 建筑 / 2 边界。
    缩放范围 0.75~1.33: 覆盖 0.22~0.4 m/像素的截图；颜色抖动和模糊 / JPEG 让它不只认 WorldView 的色调。

    Args:
        img: BGR uint8 (H,W,3) 训练瓦片
        mask: uint8 (H,W) 标签，和 img 同尺寸
        rng: random.Random，训练用固定种子，保证可复现
        size: 输出边长（像素），要是 32 的倍数

    Returns:
        (img, mask): (size,size,3) 和 (size,size)，都是连续内存
    """
    # 1) 随机缩放，模拟不同缩放级别的截图；缩小用 INTER_AREA 防摩尔纹
    s = rng.uniform(0.75, 1.33)
    img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    # 标签必须最近邻插值，否则 0/1/2 之间会插出不存在的类别
    mask = cv2.resize(mask, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST)
    if min(img.shape[:2]) < size:  # 缩小后不够裁: 补边
        ph, pw = max(0, size - img.shape[0]), max(0, size - img.shape[1])
        img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_REFLECT)
        mask = cv2.copyMakeBorder(mask, 0, ph, 0, pw, cv2.BORDER_CONSTANT, value=0)  # 镜像出来的「假楼」标成背景
    # 2) 随机裁块 + 8 种方向（4 旋转 × 翻转）: 卫星图没有固定朝向，屋顶朝哪都一样
    y = rng.randrange(0, img.shape[0] - size + 1)
    x = rng.randrange(0, img.shape[1] - size + 1)
    img, mask = img[y:y + size, x:x + size], mask[y:y + size, x:x + size]
    k = rng.randrange(4)  # 旋转 0/90/180/270
    img, mask = np.rot90(img, k), np.rot90(mask, k)
    if rng.random() < 0.5:
        img, mask = img[:, ::-1], mask[:, ::-1]
    img = np.ascontiguousarray(img)
    # 颜色: HSV 里抖色相 / 饱和度，再整体调亮度对比度
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 0] = (hsv[..., 0] + rng.uniform(-8, 8)) % 180  # OpenCV 的 H 是 0~179，±8 约 ±16°，绕回
    hsv[..., 1] *= rng.uniform(0.6, 1.4)  # 饱和度: 网络地图截图普遍比原始影像艳
    img = cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)
    img = img * rng.uniform(0.75, 1.3) + rng.uniform(-25, 25)  # 对比度 ×0.75~1.3，亮度 ±25 灰度
    img = np.clip(img, 0, 255).astype(np.uint8)
    # 3) 画质退化: 各 30% 概率轻微模糊 / JPEG 压缩（质量 40~89），模拟截图重采样和地图服务的压缩
    if rng.random() < 0.3:
        img = cv2.GaussianBlur(img, (3, 3), rng.uniform(0.5, 1.2))
    if rng.random() < 0.3:
        img = cv2.imdecode(cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, rng.randrange(40, 90)])[1], cv2.IMREAD_COLOR)
    return img, np.ascontiguousarray(mask)


def train(iters=4000, batch=8, size=256, lr=5e-4, threads=None, log_every=50):
    """
    训练并保存 tools/roofnet.pt。损失: 建筑通道 BCE + Dice（前景占比小，Dice 防止全判背景），
    边界通道 BCE（正样本权重 5: 边界像素很少）。AdamW + 余弦退火，前 200 步线性预热。

    Args:
        iters: 总步数（每步一个 batch，不按 epoch 算: 每步从全部瓦片里随机抽）
        batch: 每步张数；CPU 上 8 × 256² 大约 1 秒一步
        size: 训练裁块边长（像素，0.3 m/px 下 256 ≈ 77 m 见方，够装下几栋楼和上下文）
        lr: 峰值学习率
        threads: torch CPU 线程数，None = 默认（全部核）
        log_every: 每多少步打一次平均损失和剩余时间

    每 500 步和最后一步各存一次权重，中途断掉也有能用的 roofnet.pt。
    """
    import torch
    import torch.nn.functional as F

    if threads:
        torch.set_num_threads(threads)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    # 瓦片是 xxx.jpg + xxx_mask.png 成对存放（fetch_samples.py 生成），这里只列 jpg
    files = sorted(p for p in TRAIN_DIR.glob("*.jpg"))
    if not files:
        raise SystemExit("没有训练数据: 先运行 python tools/fetch_samples.py --train 350")
    print(f"[roofnet] {len(files)} 张训练瓦片，设备 {dev}", file=sys.stderr)
    model = build_model(True).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    # 学习率倍数 = 预热（前 200 步从 0 线性升到 1）× 余弦（从 1 降到 0）；预热防止刚开始大梯度冲坏预训练编码器
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda i: min(1.0, (i + 1) / 200) * 0.5 * (1 + math.cos(math.pi * i / iters)))
    rng = random.Random(0)  # 固定种子: 抽样和增广可复现
    pos_w = torch.tensor(5.0, device=dev)  # 边界通道正样本权重（边界像素只占几个百分点）
    t0 = time.time()
    run = []  # 最近 log_every 步的损失，打日志时取平均后清空
    model.train()
    for it in range(iters):
        # 组 batch: 每张随机抽一张瓦片现读现增广（数据集小，读盘不是瓶颈，也省内存）
        xs, ys = [], []
        for _ in range(batch):
            f = rng.choice(files)
            img = cv2.imdecode(np.fromfile(str(f), np.uint8), cv2.IMREAD_COLOR)
            m = cv2.imdecode(np.fromfile(str(f).replace(".jpg", "_mask.png"), np.uint8), cv2.IMREAD_GRAYSCALE)
            img, m = augment(img, m, rng, size)
            xs.append(to_tensor(img))
            ys.append(torch.from_numpy(np.stack([m >= 1, m == 2]).astype(np.float32)))  # 建筑（含边界）/ 边界
        x, y = torch.stack(xs).to(dev), torch.stack(ys).to(dev)  # x (B,3,S,S)，y (B,2,S,S)
        out = model(x)  # (B,2,S,S) logit
        pb = torch.sigmoid(out[:, 0])
        # 建筑: BCE 管逐像素对错，Dice 管整体重叠（整个 batch 算一个 Dice，+1 平滑防止全背景时 0/0）
        bce = F.binary_cross_entropy_with_logits(out[:, 0], y[:, 0])
        dice = 1 - (2 * (pb * y[:, 0]).sum() + 1) / (pb.sum() + y[:, 0].sum() + 1)
        edge = F.binary_cross_entropy_with_logits(out[:, 1], y[:, 1], pos_weight=pos_w)
        # 边界是辅助任务，权重 0.5: 让它学出缝，但别压过主任务
        loss = bce + dice + 0.5 * edge
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        run.append(loss.item())
        if (it + 1) % log_every == 0:
            el = time.time() - t0
            print(f"[roofnet] {it + 1}/{iters} loss {np.mean(run):.3f}  {el / (it + 1):.2f}s/步  剩余约 {el / (it + 1) * (iters - it - 1) / 60:.0f} 分钟", file=sys.stderr, flush=True)
            run = []
        if (it + 1) % 500 == 0 or it + 1 == iters:
            save(model)


def save(model):
    """半精度存权重（25MB 左右）+ 元信息

    只把 float32 转 fp16（BatchNorm 的 num_batches_tracked 是 int64，原样保留）；
    load() 再转回 float32。mpp / arch 记下来，以后换分辨率或结构时能认出旧权重。
    """
    import torch
    sd = {k: v.half() if v.dtype == torch.float32 else v for k, v in model.state_dict().items()}
    torch.save({"state_dict": sd, "mpp": NET_MPP, "arch": "resnet18-unet-2ch"}, WEIGHTS)


# ----------------------------------------------------------------------------
# 推理
# ----------------------------------------------------------------------------
_model_cache = {}  # (权重路径, 设备) → (模型, 设备名)；autoscene 一次处理多张图时不重复加载


def available(path=WEIGHTS):
    """有没有训练好的权重 + torch

    autoscene 用它决定建筑检测走 roofnet 还是退回 SAM / 颜色法；
    只检查能不能 import，不真的加载模型（加载要几秒）。
    """
    if not Path(path).exists():
        return False
    try:
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


def load(path=WEIGHTS, device=None):
    """加载权重（同一进程只加载一次）

    Args:
        path: 权重文件
        device: "cuda" / "cpu"；None = 有 CUDA 就用

    Returns:
        (model, dev): eval 模式的模型和它所在的设备名
    """
    import torch
    key = (str(path), device)
    if key not in _model_cache:
        # 先加载到 CPU 再搬: 训练机和推理机设备不同也能读；weights_only=False 因为里面有 mpp / arch 等非张量字段
        ck = torch.load(path, map_location="cpu", weights_only=False)
        m = build_model(pretrained=False)
        m.load_state_dict({k: v.float() for k, v in ck["state_dict"].items()})
        dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
        _model_cache[key] = (m.to(dev).eval(), dev)
    return _model_cache[key]


def predict(img, mpp, path=WEIGHTS, tile=512, overlap=64, progress=None):
    """
    整张图的 建筑 / 边界 概率（float32，和原图同尺寸）。
    先缩放到 0.3 m/像素，按 tile 分块（相邻块重叠 overlap，只取每块中间那部分，避免块边的效应），再缩回原尺寸。

    Args:
        img: BGR uint8 (H,W,3) 整张图
        mpp: 这张图的 米/像素
        tile: 网络一次吃的块边长（网络分辨率下的像素）；512 在 CPU 上内存和速度比较均衡
        overlap: 相邻块各自丢掉的边宽；卷积感受野在块边缺上下文，64 px ≈ 19 m 够了
        progress: 可选回调 progress(已完成块数, 总块数)

    Returns:
        [pb, pe]: 建筑概率 / 边界概率，各是 float32 (H,W)，0~1
    """
    import torch
    model, dev = load(path)
    h0, w0 = img.shape[:2]
    s = mpp / NET_MPP  # 缩放倍数: 0.6 m/像素的图要放大 2 倍
    # 至少 32 像素（网络下采样 32 倍，再小就没特征了）
    im = cv2.resize(img, (max(32, int(round(w0 * s))), max(32, int(round(h0 * s)))), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    H, W = im.shape[:2]
    prob = np.zeros((2, H, W), np.float32)  # (2,H,W) 网络分辨率下的拼接结果
    # 块起点间隔 = tile − 2·overlap，每块有效的中间部分正好首尾相接；
    # 最后一块会被下面的 min(y, H − tile) 推回图内，和前一块多重叠一些，无妨
    step = tile - 2 * overlap
    ys = list(range(0, max(1, H - 2 * overlap), step))
    xs = list(range(0, max(1, W - 2 * overlap), step))
    n, k = len(ys) * len(xs), 0
    with torch.no_grad():
        for y in ys:
            for x in xs:
                y0, x0 = max(0, min(y, H - tile)), max(0, min(x, W - tile))
                patch = im[y0:y0 + tile, x0:x0 + tile]
                ph, pw = patch.shape[:2]  # 图比 tile 小时块也小于 tile
                pad = cv2.copyMakeBorder(patch, 0, (32 - ph % 32) % 32, 0, (32 - pw % 32) % 32, cv2.BORDER_REFLECT)  # 边长补到 32 的倍数
                # [None] 加 batch 维 → (1,3,h,w)；输出取 [0] 再裁掉补的边 → (2,ph,pw)
                out = torch.sigmoid(model(to_tensor(pad)[None].to(dev)))[0].cpu().numpy()[:, :ph, :pw]
                # 只写「中间」: 离块边 overlap 以内的像素由相邻块负责（图像边缘除外）
                cy0 = 0 if y0 == 0 else overlap
                cx0 = 0 if x0 == 0 else overlap
                cy1 = ph if y0 + ph >= H else ph - overlap
                cx1 = pw if x0 + pw >= W else pw - overlap
                prob[:, y0 + cy0:y0 + cy1, x0 + cx0:x0 + cx1] = out[:, cy0:cy1, cx0:cx1]
                k += 1
                if progress:
                    progress(k, n)
    # 缩回原图尺寸，调用方拿到的概率和原图像素一一对应
    return [cv2.resize(p, (w0, h0), interpolation=cv2.INTER_LINEAR) for p in prob]


def instances(pb, pe, mpp, thr=0.5, edge_thr=0.35, min_m2=12.0):
    """
    概率图 → 一栋一栋的楼（裁剪块列表，同 satgeo.crop 的格式）。
    种子 = 建筑概率高、且不在边界上的像素（每栋楼的「内核」），开运算去掉细连接后按连通块编号；
    再以「建筑概率」为地形做分水岭，把整片建筑区域分给最近的种子 —— 挨着的房子就按那条缝分开了。

    Args:
        pb, pe: predict() 给的建筑 / 边界概率，float32 (H,W)
        mpp: 米/像素，用来把最小面积换成像素
        thr: 建筑概率阈值
        edge_thr: 边界概率低于它才算「内核」；比 0.5 低，宁可种子小一点也别跨过缝
        min_m2: 小于这个面积（平方米）的块丢掉 —— 12 m² 大约一间棚屋，更小的多是车 / 噪点

    Returns:
        [(x0, y0, sub)]: 每栋楼的外接框左上角和框内 bool 掩码
    """
    fg = (pb > thr).astype(np.uint8)
    seeds = ((pb > thr) & (pe < edge_thr)).astype(np.uint8)
    # 3×3 开运算: 断开两栋楼内核之间残留的 1~2 像素细桥，否则它们会被当成一个种子
    seeds = cv2.morphologyEx(seeds, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, markers = cv2.connectedComponents(seeds, connectivity=4)  # 4 连通: 斜角相碰不算连着；标签 0 = 背景，1..n-1 = 种子
    # 分水岭: 标记 0 = 待分配（前景里不是种子的），背景给一个单独的标记 n，不参与
    markers = markers.astype(np.int32)
    markers[(fg == 0)] = n
    markers[(fg == 1) & (seeds == 0)] = 0
    relief = cv2.cvtColor((255 * (1 - pb)).astype(np.uint8), cv2.COLOR_GRAY2BGR)  # 概率越低越「高」，边界是山脊
    cv2.watershed(relief, markers)  # 原地改 markers: 每个前景像素归到某个种子，分界线标 -1
    out = []
    min_px = min_m2 / (mpp * mpp)
    # 只遍历种子标签 1..n-1（n 是背景），逐个裁出外接框
    for i in range(1, n):
        m = markers == i
        if m.sum() < min_px:
            continue
        ys, xs = np.nonzero(m)
        x0, y0 = int(xs.min()), int(ys.min())
        sub = m[y0:ys.max() + 1, x0:xs.max() + 1]
        sub = cv2.morphologyEx(sub.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0  # 分水岭线（-1）留下的缝补上
        out.append((x0, y0, sub))
    return out


def main():
    """命令行: train / predict

    predict 打印 {buildings, seconds}，并在原图旁边写一张 <原名>.roofnet.jpg，每栋楼描红框，
    用来肉眼检查分割和拆分效果。
    """
    ap = argparse.ArgumentParser(description="卫星图建筑分割网络", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--iters", type=int, default=4000)
    t.add_argument("--batch", type=int, default=8)
    t.add_argument("--size", type=int, default=256)
    t.add_argument("--threads", type=int, default=None, help="CPU 线程数（留几个给别的程序）")
    p = sub.add_parser("predict")
    p.add_argument("image")
    p.add_argument("--mpp", type=float, required=True)
    p.add_argument("-o", "--out", default=None)
    a = ap.parse_args()
    if a.cmd == "train":
        return train(a.iters, a.batch, a.size, threads=a.threads)
    # np.fromfile + imdecode 而不是 cv2.imread: Windows 上 imread 读不了中文路径
    img = cv2.imdecode(np.fromfile(a.image, np.uint8), cv2.IMREAD_COLOR)
    t0 = time.time()
    pb, pe = predict(img, a.mpp)
    inst = instances(pb, pe, a.mpp)
    print(json.dumps({"buildings": len(inst), "seconds": round(time.time() - t0, 1)}))
    vis = img.copy()
    for x0, y0, s in inst:
        cnts, _ = cv2.findContours(s.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(vis, [c + [x0, y0] for c in cnts], -1, (0, 0, 255), 2)
    cv2.imencode(".jpg", vis)[1].tofile(a.out or str(Path(a.image).with_suffix(".roofnet.jpg")))


if __name__ == "__main__":
    main()
