// 二维多边形工具。scene.json 的坐标是 (x, y)，y 向下；三维里映射为 world (x, 0, y)。
import * as THREE from 'three'

export function signedArea(poly) {
  let a = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

export function pointInPolygon(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 边 i (poly[i] → poly[i+1]) 的单位外法线 */
export function edgeNormal(poly, i, area = signedArea(poly)) {
  const p = poly[i], q = poly[(i + 1) % poly.length]
  const dx = q[0] - p[0], dy = q[1] - p[1]
  const l = Math.hypot(dx, dy) || 1
  const s = area > 0 ? 1 : -1
  return [(dy / l) * s, (-dx / l) * s]
}

/** 每条边沿法线平移 d（正 = 向外）后相邻边求交。结果有边方向翻转则返回 null。 */
export function offsetPolygon(poly, d) {
  const n = poly.length
  const area = signedArea(poly)
  const lines = []
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n]
    const nr = edgeNormal(poly, i, area)
    lines.push({ px: p[0] + nr[0] * d, py: p[1] + nr[1] * d, dx: q[0] - p[0], dy: q[1] - p[1] })
  }
  const out = []
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n], b = lines[i]
    const cross = a.dx * b.dy - a.dy * b.dx
    if (Math.abs(cross) < 1e-6 * Math.hypot(a.dx, a.dy) * Math.hypot(b.dx, b.dy)) {
      out.push([b.px, b.py])
    } else {
      const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / cross
      out.push([a.px + a.dx * t, a.py + a.dy * t])
    }
  }
  for (let i = 0; i < n; i++) {
    const p = out[i], q = out[(i + 1) % n]
    if ((q[0] - p[0]) * lines[i].dx + (q[1] - p[1]) * lines[i].dy <= 0) return null
  }
  return out
}

/** 用二次贝塞尔把每个角倒圆，r 会被相邻边长限制 */
export function roundPolygon(poly, r, seg = 4) {
  const n = poly.length
  if (r <= 0 || n < 3) return poly
  const out = []
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p = poly[i], p1 = poly[(i + 1) % n]
    const ax = p0[0] - p[0], ay = p0[1] - p[1], bx = p1[0] - p[0], by = p1[1] - p[1]
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    const t = Math.min(r, la / 2.2, lb / 2.2)
    if (t < 0.05) { out.push(p); continue }
    const s = [p[0] + (ax / la) * t, p[1] + (ay / la) * t]
    const e = [p[0] + (bx / lb) * t, p[1] + (by / lb) * t]
    for (let k = 0; k <= seg; k++) {
      const u = k / seg, v = 1 - u
      out.push([v * v * s[0] + 2 * v * u * p[0] + u * u * e[0], v * v * s[1] + 2 * v * u * p[1] + u * u * e[1]])
    }
  }
  return out
}

/** (x, y) → THREE.Shape。y 取反，配合 toGround() 旋转后正好落到 world (x, *, y) 且法线朝上 */
export function makeShape(poly, holes = []) {
  const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, -y)))
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, -y))))
  return shape
}

/** Shape/Extrude 几何体从 XY 平面放倒到地面，挤出方向朝上，底面落在 y 处 */
export function toGround(geometry, y = 0) {
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, y, 0)
  return geometry
}

/** 多边形内离边界最远的点（粗采样），用来放屋顶设备、挑店内热力点 */
export function interiorPoints(poly, holes, count, rand) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  const pts = []
  for (let tries = 0; pts.length < count && tries < count * 40; tries++) {
    const x = minX + rand() * (maxX - minX), y = minY + rand() * (maxY - minY)
    if (!pointInPolygon(x, y, poly)) continue
    if (holes.some((h) => pointInPolygon(x, y, h))) continue
    pts.push([x, y])
  }
  return pts
}

export function distToPolygonEdge(x, y, poly) {
  let best = Infinity
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n]
    const dx = q[0] - p[0], dy = q[1] - p[1]
    const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - p[0] - dx * t, y - p[1] - dy * t))
  }
  return best
}

/** 可复现的随机数 (mulberry32) */
export function makeRandom(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
