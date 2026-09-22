// 路灯布点的测试。planLamps 只看场景数据，所以用手工拼的小场景就能验证每种型号的规则。
import { describe, it, expect } from 'vitest'
import { planLamps, yawToward, LAMP_SPEC } from '../src/city/lamps.js'
import { ELEVATED_H } from '../src/city/roads.js'

// 一条从 (0,0) 到 (120,0) 的直路
const lane = (width, extra = {}) => ({ points: [[0, 0], [120, 0]], width, ...extra })
const scene = (lanes = [], areas = [], buildings = []) => ({ lanes, areas, buildings })

describe('yawToward', () => {
  it('朝 +x 时转角为 0，朝 +y（世界 +z）时为 -90°', () => {
    expect(yawToward(1, 0)).toBeCloseTo(0)
    expect(yawToward(0, 1)).toBeCloseTo(-Math.PI / 2)
  })
})

describe('道路灯', () => {
  it('普通双车道路: 单臂灯在路沿外 0.7m，左右交错，间距 30m', () => {
    const lamps = planLamps(scene([lane(14.6)])) // 单向 2 车道
    const street = lamps.filter((l) => l.kind === 'street')
    expect(street.length).toBe(4) // 120m / 30m
    // 离中心线的距离 = 7.3 + 0.7
    for (const l of street) expect(Math.abs(l.y)).toBeCloseTo(8.0)
    // 相邻两盏在不同侧
    expect(Math.sign(street[0].y)).not.toBe(Math.sign(street[1].y))
    // 灯臂指向路中心: 在 y>0 一侧的灯朝 -y
    const above = street.find((l) => l.y > 0)
    expect(yawToward(0, -1)).toBeCloseTo(above.dir)
  })

  it('主干路（单向 ≥3 车道）: 双臂灯立在中心线上', () => {
    const lamps = planLamps(scene([lane(22)]))
    expect(lamps.every((l) => l.kind === 'avenue')).toBe(true)
    expect(lamps.length).toBe(Math.floor((120 - 18) / 36) + 1)
    for (const l of lamps) expect(l.y).toBeCloseTo(0)
  })

  it('高架: 护栏灯在桥面两侧、标高为桥面', () => {
    const lamps = planLamps(scene([lane(21, { level: 1 })]))
    expect(lamps.length).toBe(8) // 4 个位置 × 两侧
    for (const l of lamps) {
      expect(l.kind).toBe('deck')
      expect(l.z).toBe(ELEVATED_H)
      expect(Math.abs(l.y)).toBeCloseTo(21 / 2 - 0.6)
    }
  })

  it('桥下的路和环岛环道不布灯', () => {
    expect(planLamps(scene([lane(39, { median: 9 })])).length).toBe(0)
    expect(planLamps(scene([lane(7, { oneway: true })])).length).toBe(0)
  })

  it('核心区里落在不可行走格子上的路灯被跳过', () => {
    const nav = { contains: () => true, isWalkable: (x) => x < 60 } // 后半段是「建筑」
    const lamps = planLamps(scene([lane(8.8)]), nav)
    expect(lamps.every((l) => l.x < 60)).toBe(true)
    expect(lamps.length).toBeGreaterThan(0)
  })
})

describe('庭院灯', () => {
  const park = { kind: 'park', polygon: [[0, 0], [100, 0], [100, 60], [0, 60]], holes: [] }

  it('公园里按面积散布，全部在多边形内且离边 ≥2m，互相不挤', () => {
    const lamps = planLamps(scene([], [park]))
    expect(lamps.length).toBeGreaterThan(5)
    for (const l of lamps) {
      expect(l.kind).toBe('garden')
      expect(l.x).toBeGreaterThanOrEqual(2); expect(l.x).toBeLessThanOrEqual(98)
      expect(l.y).toBeGreaterThanOrEqual(2); expect(l.y).toBeLessThanOrEqual(58)
    }
    for (let i = 0; i < lamps.length; i++) for (let j = i + 1; j < lamps.length; j++) {
      expect(Math.hypot(lamps[i].x - lamps[j].x, lamps[i].y - lamps[j].y)).toBeGreaterThanOrEqual(LAMP_SPEC.garden.spacing * 0.8 - 1e-9)
    }
  })

  it('水面上不立灯', () => {
    const water = { kind: 'water', polygon: [[20, 10], [80, 10], [80, 50], [20, 50]] }
    const lamps = planLamps(scene([], [park, water]))
    for (const l of lamps) expect(l.x < 20 || l.x > 80 || l.y < 10 || l.y > 50).toBe(true)
  })

  it('住宅楼四周一圈庭院灯，离墙 3.5m', () => {
    const b = { kind: 'residential', polygon: [[0, 0], [40, 0], [40, 12], [0, 12]] }
    const lamps = planLamps(scene([], [], [b]))
    expect(lamps.length).toBeGreaterThan(3)
    for (const l of lamps) {
      const inside = l.x > 0 && l.x < 40 && l.y > 0 && l.y < 12
      expect(inside).toBe(false)
    }
  })

  it('写字楼不配庭院灯', () => {
    expect(planLamps(scene([], [], [{ kind: 'block', polygon: [[0, 0], [40, 0], [40, 12], [0, 12]] }])).length).toBe(0)
  })
})
