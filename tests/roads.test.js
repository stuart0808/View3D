// 车道划分规则的测试。地面标线和车流都从这里取值，两边一旦不一致车就会跑到线外。
import { describe, it, expect } from 'vitest'
import { laneLayout, hasMedian, ELEVATED_H } from '../src/city/roads.js'

describe('laneLayout 双向路', () => {
  it('8.8m 的支路单向 1 条车道，车道中心在中心线右侧 2.2m', () => {
    const l = laneLayout(8.8)
    expect(l.n).toBe(1)
    expect(l.laneW).toBeCloseTo(4.4)
    expect(l.offsets).toEqual([2.2])
  })

  it('22m 的环路单向 3 条，车道等分半幅', () => {
    const l = laneLayout(22)
    expect(l.n).toBe(3)
    expect(l.laneW).toBeCloseTo(11 / 3)
    // 车道中心依次向外排，最外侧贴着路沿
    expect(l.offsets[0]).toBeLessThan(l.offsets[1])
    expect(l.offsets[2]).toBeCloseTo(11 - l.laneW / 2)
  })

  it('最多 4 条车道，再宽也不加', () => {
    expect(laneLayout(60).n).toBe(4)
  })
})

describe('laneLayout 桥下的路（median）', () => {
  it('桥面正下方 median 宽不排车道，车道从桥面投影外侧开始', () => {
    const l = laneLayout(39.2, false, 9.2)
    expect(l.inner).toBeCloseTo(9.6) // median + 0.4
    expect(l.offsets[0]).toBeGreaterThan(9.6)
    // 半幅 19.6 减去 9.6 剩 10m → 3 条车道
    expect(l.n).toBe(3)
  })
})

describe('laneLayout 单行路（环岛）', () => {
  it('整幅都是同向车道，偏移左右对称', () => {
    const l = laneLayout(7, true)
    expect(l.n).toBe(2)
    expect(l.offsets[0]).toBeCloseTo(-l.offsets[1])
  })

  it('环道最多两圈', () => {
    expect(laneLayout(20, true).n).toBe(2)
  })
})

describe('hasMedian', () => {
  it('单向 ≥3 车道才有实体隔离带；单行路没有', () => {
    expect(hasMedian(22)).toBe(true)
    expect(hasMedian(14)).toBe(false)
    expect(hasMedian(22, true)).toBe(false)
  })
})

it('高架标高是个正数常量', () => {
  expect(ELEVATED_H).toBeGreaterThan(4)
})
