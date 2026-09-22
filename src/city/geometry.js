// 二维多边形工具。整个项目的平面几何都在这里，别处只做「拿轮廓 → 生成体块」的事。
//
// 坐标约定（贯穿全项目，改动要小心）:
//   · scene.json 的坐标是 (x, y)，单位米，y 向下 —— 和图片像素坐标同向，脚本里换算最省事
//   · 三维里映射为 world (x, 0, y)，也就是二维的 y 变成三维的 z；高度走三维的 y
//   · 因为 y 向下，多边形的「顺时针 / 逆时针」和数学课本相反，所以判断内外、算外法线都不假设方向，
//     一律用 signedArea 的符号现场判断
import * as THREE from 'three'

/**
 * 有符号面积（鞋带公式）。绝对值是面积；符号表示顶点顺序 —— 在 y 向下的坐标里，
 * 屏幕上看起来顺时针的多边形符号为正。别处只用它的符号来判断法线该朝哪边。
 */
export function signedArea(poly) {
  let a = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

/** 射线法判断点在不在多边形内（不含洞；洞要调用方自己再判一次）。落在边上时结果不保证。 */
export function pointInPolygon(x, y, poly) {
  let inside = false
  // 从点向 +x 发一条射线，数它穿过多少条边；奇数次在内
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * 边 i (poly[i] → poly[i+1]) 的单位外法线。
 * 边的方向向量是 (dx, dy)，它的两个垂线是 (dy, -dx) 和 (-dy, dx)；哪个朝外取决于顶点顺序，用面积的符号选。
 * area 可以传进来省一次计算（一个多边形要算很多条边时）。
 */
export function edgeNormal(poly, i, area = signedArea(poly)) {
  const p = poly[i], q = poly[(i + 1) % poly.length]
  const dx = q[0] - p[0], dy = q[1] - p[1]
  const l = Math.hypot(dx, dy) || 1
  const s = area > 0 ? 1 : -1
  return [(dy / l) * s, (-dx / l) * s]
}

/**
 * 多边形整体外扩 / 内缩 d 米（d > 0 外扩）。
 * 做法: 每条边沿自己的外法线平移 d，相邻两条平移后的边求交点作为新顶点。
 * 内缩过头时某条边会「翻转」（新顶点的顺序和原来相反），这时返回 null，调用方据此退化成别的做法。
 * 不处理自交和尖角爆掉的情况 —— 建筑轮廓已经直角化过，尖角很少。
 */
export function offsetPolygon(poly, d) {
  const n = poly.length
  const area = signedArea(poly)
  // 每条边平移后的直线: 过点 (px, py)，方向 (dx, dy)
  const lines = []
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n]
    const nr = edgeNormal(poly, i, area)
    lines.push({ px: p[0] + nr[0] * d, py: p[1] + nr[1] * d, dx: q[0] - p[0], dy: q[1] - p[1] })
  }
  const out = []
  for (let i = 0; i < n; i++) {
    // 新顶点 i = 边 i-1 和边 i 平移后的交点
    const a = lines[(i - 1 + n) % n], b = lines[i]
    const cross = a.dx * b.dy - a.dy * b.dx
    if (Math.abs(cross) < 1e-6 * Math.hypot(a.dx, a.dy) * Math.hypot(b.dx, b.dy)) {
      // 两条边几乎平行（共线的顶点）: 交点不稳定，直接用边 i 的起点
      out.push([b.px, b.py])
    } else {
      const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / cross
      out.push([a.px + a.dx * t, a.py + a.dy * t])
    }
  }
  // 校验: 新的每条边和原来那条边方向一致（点积 > 0），否则说明缩过头了
  for (let i = 0; i < n; i++) {
    const p = out[i], q = out[(i + 1) % n]
    if ((q[0] - p[0]) * lines[i].dx + (q[1] - p[1]) * lines[i].dy <= 0) return null
  }
  return out
}

/**
 * 把每个角倒成圆角: 角的两侧各退 r（不超过邻边长的一半），中间用一条二次贝塞尔曲线（seg 段）接上。
 * 建筑的圆角屋檐、路口的人行道转角都是它做的。r 会被短边限制，所以很小的凸起不会被倒成怪形状。
 */
export function roundPolygon(poly, r, seg = 4) {
  const n = poly.length
  if (r <= 0 || n < 3) return poly
  const out = []
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p = poly[i], p1 = poly[(i + 1) % n]
    // 指向前一个 / 后一个顶点的向量
    const ax = p0[0] - p[0], ay = p0[1] - p[1], bx = p1[0] - p[0], by = p1[1] - p[1]
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    const t = Math.min(r, la / 2.2, lb / 2.2) // 实际退多少
    if (t < 0.05) { out.push(p); continue }   // 邻边太短，这个角不倒
    const s = [p[0] + (ax / la) * t, p[1] + (ay / la) * t] // 圆弧起点
    const e = [p[0] + (bx / lb) * t, p[1] + (by / lb) * t] // 圆弧终点
    // 以原顶点 p 为控制点的二次贝塞尔: B(u) = (1-u)² s + 2(1-u)u p + u² e
    for (let k = 0; k <= seg; k++) {
      const u = k / seg, v = 1 - u
      out.push([v * v * s[0] + 2 * v * u * p[0] + u * u * e[0], v * v * s[1] + 2 * v * u * p[1] + u * u * e[1]])
    }
  }
  return out
}

/**
 * (x, y) 多边形 → THREE.Shape。y 取反是关键: Shape 在 XY 平面上，
 * 之后 toGround() 会绕 X 轴转 -90° 把它放倒，转完 Shape 的 -y 正好落到世界的 +z，法线朝上。
 */
export function makeShape(poly, holes = []) {
  const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, -y)))
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, -y))))
  return shape
}

/**
 * 把 Shape/Extrude 几何体从 XY 平面放倒到地面: 挤出方向（原来的 +z）变成朝上，底面落在高度 y 处。
 * 所有「轮廓拉伸」出来的东西（墙、屋顶、铺装、桥面）都经过它。
 */
export function toGround(geometry, y = 0) {
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, y, 0)
  return geometry
}

/**
 * 在多边形内随机撒 count 个点（拒绝采样: 在包围盒里随机取，落在外面或洞里的丢掉）。
 * 屋顶设备、树、庭院灯、店内热力落点都靠它。rand 是可复现的随机源，保证每次打开场景布置一样。
 */
export function interiorPoints(poly, holes, count, rand) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  const pts = []
  // 最多试 40 倍次数: 细长 / 带大洞的多边形命中率低，但也不能无限试
  for (let tries = 0; pts.length < count && tries < count * 40; tries++) {
    const x = minX + rand() * (maxX - minX), y = minY + rand() * (maxY - minY)
    if (!pointInPolygon(x, y, poly)) continue
    if (holes.some((h) => pointInPolygon(x, y, h))) continue
    pts.push([x, y])
  }
  return pts
}

/** 点到多边形边界（各条边的线段）的最短距离。用来挑「离墙远」的位置放东西。 */
export function distToPolygonEdge(x, y, poly) {
  let best = Infinity
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n]
    const dx = q[0] - p[0], dy = q[1] - p[1]
    // 点在线段上的投影参数，夹到 [0,1] 就是最近点在线段内
    const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - p[0] - dx * t, y - p[1] - dy * t))
  }
  return best
}

/**
 * 可复现的随机数 (mulberry32)。整个场景的随机布置（树、灯、店面主题、人的颜色…）都从同一个种子出发，
 * 所以同一份 scene.json 每次打开长得一样，截图对比、复现问题都方便。
 */
export function makeRandom(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
