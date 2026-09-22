// 二维几何工具的测试。建筑、路面、导航网格都建立在这些函数上。
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { signedArea, pointInPolygon, edgeNormal, offsetPolygon, roundPolygon, interiorPoints, distToPolygonEdge, makeRandom, makeShape, toGround } from '../src/city/geometry.js'

// 一个 10x6 的矩形（顺时针，y 向下的图像坐标里）
const RECT = [[0, 0], [10, 0], [10, 6], [0, 6]]

describe('signedArea / pointInPolygon', () => {
  it('面积的绝对值正确，方向反转符号反转', () => {
    expect(Math.abs(signedArea(RECT))).toBe(60)
    expect(signedArea(RECT)).toBe(-signedArea([...RECT].reverse()))
  })

  it('点在多边形内 / 外', () => {
    expect(pointInPolygon(5, 3, RECT)).toBe(true)
    expect(pointInPolygon(11, 3, RECT)).toBe(false)
    expect(pointInPolygon(-0.1, 3, RECT)).toBe(false)
  })
})

describe('edgeNormal', () => {
  it('每条边的法线朝外（沿法线走 1m 出多边形，反方向进多边形）', () => {
    for (let i = 0; i < RECT.length; i++) {
      const p = RECT[i], q = RECT[(i + 1) % 4]
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2
      const [nx, ny] = edgeNormal(RECT, i)
      expect(pointInPolygon(mx + nx, my + ny, RECT)).toBe(false)
      expect(pointInPolygon(mx - nx, my - ny, RECT)).toBe(true)
    }
  })
})

describe('offsetPolygon', () => {
  it('外扩 1m 后每边外移 1m，面积变大；内缩后变小', () => {
    const out = offsetPolygon(RECT, 1)
    expect(Math.abs(signedArea(out))).toBeCloseTo(12 * 8)
    const inn = offsetPolygon(RECT, -1)
    expect(Math.abs(signedArea(inn))).toBeCloseTo(8 * 4)
  })

  it('内缩到把某条边翻转时返回 null', () => {
    expect(offsetPolygon(RECT, -4)).toBeNull()
  })
})

describe('roundPolygon', () => {
  it('倒圆后顶点变多，面积略小于原多边形', () => {
    const r = roundPolygon(RECT, 1)
    expect(r.length).toBeGreaterThan(RECT.length)
    const a = Math.abs(signedArea(r))
    expect(a).toBeLessThan(60)
    expect(a).toBeGreaterThan(55)
  })

  it('半径 0 时原样返回', () => {
    expect(roundPolygon(RECT, 0)).toBe(RECT)
  })
})

describe('interiorPoints / distToPolygonEdge', () => {
  it('采样点都在多边形内且不在洞里', () => {
    const hole = [[4, 2], [6, 2], [6, 4], [4, 4]]
    const pts = interiorPoints(RECT, [hole], 50, makeRandom(3))
    expect(pts.length).toBeGreaterThan(30)
    for (const [x, y] of pts) {
      expect(pointInPolygon(x, y, RECT)).toBe(true)
      expect(pointInPolygon(x, y, hole)).toBe(false)
    }
  })

  it('到边界的距离: 中心点是 3，边上的点是 0', () => {
    expect(distToPolygonEdge(5, 3, RECT)).toBe(3)
    expect(distToPolygonEdge(5, 0, RECT)).toBe(0)
  })
})

describe('makeRandom', () => {
  it('同一种子序列相同，不同种子不同，值在 [0,1)', () => {
    const a = makeRandom(7), b = makeRandom(7), c = makeRandom(8)
    const sa = Array.from({ length: 5 }, () => a()), sb = Array.from({ length: 5 }, () => b())
    expect(sa).toEqual(sb)
    expect(sa).not.toEqual(Array.from({ length: 5 }, () => c()))
    for (const v of sa) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })
})

describe('makeShape / toGround', () => {
  it('Shape 带洞；toGround 后几何体落在 y = 给定高度的水平面上', () => {
    const shape = makeShape(RECT, [[[2, 2], [3, 2], [3, 3], [2, 3]]])
    expect(shape.holes.length).toBe(1)
    const g = toGround(new THREE.ShapeGeometry(shape), 5)
    const ys = new Set()
    for (let i = 0; i < g.attributes.position.count; i++) ys.add(+g.attributes.position.getY(i).toFixed(6))
    expect([...ys]).toEqual([5])
  })
})
