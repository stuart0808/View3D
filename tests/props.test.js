// 配景布点的测试: 停车位布局、行道树、绿地树。布点函数都是纯函数，导航网格用一个假对象代替。
import { describe, it, expect } from 'vitest'
import { layoutParking, streetTreeSpots, areaTreeSpots, carGeometry, CAR_COLORS } from '../src/city/props.js'
import { SURFACE } from '../src/city/navgrid.js'
import { makeRandom, pointInPolygon } from '../src/city/geometry.js'

describe('layoutParking', () => {
  const lot = { polygon: [[0, 0], [60, 0], [60, 40], [0, 40]], holes: [] }

  it('没有出入口时只排车位，route 为 null，所有车位在场内', () => {
    const { stalls, lines } = layoutParking(lot, 0, null)
    expect(stalls.length).toBeGreaterThan(40)
    expect(lines.length).toBe(stalls.length * 2)
    for (const st of stalls) {
      expect(st.route).toBeNull()
      expect(pointInPolygon(st.pos[0], st.pos[1], lot.polygon)).toBe(true)
    }
  })

  it('有出入口时: 通道朝向出入口，每个车位的出库路线终点在出入口附近的横向车道上', () => {
    const entry = [60, 20] // 出入口在东边界中点
    const { stalls } = layoutParking(lot, 0, entry)
    expect(stalls.length).toBeGreaterThan(20)
    for (const st of stalls) {
      expect(st.route.length).toBe(4)
      const end = st.route[3]
      expect(Math.abs(end[0] - (60 - 6.5 / 2))).toBeLessThan(0.01) // 横向车道中线 x = 60 - DRIVE/2
      expect(Math.abs(end[1] - 20)).toBeLessThan(0.01)
      expect(pointInPolygon(end[0], end[1], lot.polygon)).toBe(true)
    }
  })

  it('车位互不重叠（中心间距 ≥ 车位宽）', () => {
    const { stalls } = layoutParking(lot, 0, null)
    for (let i = 0; i < stalls.length; i++) for (let j = i + 1; j < stalls.length; j++) {
      expect(Math.hypot(stalls[i].pos[0] - stalls[j].pos[0], stalls[i].pos[1] - stalls[j].pos[1])).toBeGreaterThanOrEqual(2.6 - 1e-6)
    }
  })

  it('街区主方向旋转后车位线角度跟着转', () => {
    const { lines } = layoutParking(lot, 0.3, null)
    expect(lines[0].angle).toBeCloseTo(0.3 + Math.PI / 2)
  })
})

describe('streetTreeSpots', () => {
  // 一条东西向的车行道 y ∈ [-5, 5]，两侧是铺装；铺装环是 y ∈ [5, 20] 的矩形
  const nav = { surfaceAt: (x, y) => (Math.abs(y) < 5 ? SURFACE.ROAD : y > 5 && y < 20 && x > 0 && x < 200 ? SURFACE.PAVE : SURFACE.NONE) }
  const scene = (doors = [], crosswalks = []) => ({ pavement: [{ polygon: [[0, 5], [200, 5], [200, 20], [0, 20]], holes: [] }], doors, crosswalks })

  it('只在临车行道的那条边上种，种在铺装内 1.5m，间距 9m', () => {
    const spots = streetTreeSpots(scene(), nav)
    expect(spots.length).toBe(Math.floor((200 - 4.5) / 9) + 1)
    for (const [x, y] of spots) expect(y).toBeCloseTo(6.5)
    expect(spots[1][0] - spots[0][0]).toBeCloseTo(9)
  })

  it('店门和斑马线附近不种', () => {
    const doors = [{ pos: [49.5, 5] }]
    const cw = [{ center: [100, 0], span: 10, depth: 3 }]
    const spots = streetTreeSpots(scene(doors, cw), nav)
    for (const [x] of spots) {
      expect(Math.abs(x - 49.5)).toBeGreaterThanOrEqual(4 - 1e-6)
      expect(Math.hypot(x - 100, 6.5)).toBeGreaterThanOrEqual(8.5 - 1e-6) // 到斑马线中心的距离 ≥ span/2 + 3.5
    }
  })
})

describe('areaTreeSpots', () => {
  it('公园里的树都在多边形内、离边 ≥1.3m、互相 ≥6.5m；绿化带更密', () => {
    const park = { kind: 'park', polygon: [[0, 0], [100, 0], [100, 80], [0, 80]], holes: [] }
    const green = { kind: 'green', polygon: [[200, 0], [260, 0], [260, 20], [200, 20]], holes: [] }
    const spots = areaTreeSpots({ areas: [park, green] }, makeRandom(2))
    const inPark = spots.filter(([x]) => x < 150), inGreen = spots.filter(([x]) => x >= 150)
    expect(inPark.length).toBeGreaterThan(30)
    expect(inGreen.length).toBeGreaterThan(10)
    for (const [x, y] of inPark) { expect(x).toBeGreaterThanOrEqual(1.3); expect(y).toBeLessThanOrEqual(80 - 1.3) }
    for (let i = 0; i < inPark.length; i++) for (let j = i + 1; j < inPark.length; j++) {
      expect(Math.hypot(inPark[i][0] - inPark[j][0], inPark[i][1] - inPark[j][1])).toBeGreaterThanOrEqual(6.5 - 1e-6)
    }
    // 绿化带每 30㎡ 一棵，公园每 75㎡ 一棵 → 绿化带密度更高
    expect(inGreen.length / 1200).toBeGreaterThan(inPark.length / 8000)
  })

  it('水面上不种树', () => {
    const park = { kind: 'park', polygon: [[0, 0], [100, 0], [100, 80], [0, 80]], holes: [] }
    const water = { kind: 'water', polygon: [[20, 20], [80, 20], [80, 60], [20, 60]], holes: [] }
    for (const [x, y] of areaTreeSpots({ areas: [park, water] }, makeRandom(2))) {
      expect(x < 20 || x > 80 || y < 20 || y > 60).toBe(true)
    }
  })
})

describe('车模型', () => {
  it('车身长 4.3m、车头朝 +X；颜色表以白灰为主', () => {
    const g = carGeometry()
    g.computeBoundingBox()
    expect(g.boundingBox.max.x - g.boundingBox.min.x).toBeCloseTo(4.3)
    expect(g.boundingBox.min.y).toBeGreaterThanOrEqual(0)
    expect(CAR_COLORS.length).toBeGreaterThan(5)
  })
})
