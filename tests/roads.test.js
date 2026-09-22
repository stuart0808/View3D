// 车道划分规则的测试。地面标线和车流都从这里取值，两边一旦不一致车就会跑到线外。
import { describe, it, expect } from 'vitest' // vitest 的断言
import { laneLayout, hasMedian, ELEVATED_H } from '../src/city/roads.js' // 被测模块

describe('laneLayout 双向路', () => { // 普通双向路
  it('8.8m 的支路单向 1 条车道，车道中心在中心线右侧 2.2m', () => {
    const l = laneLayout(8.8) // 支路
    expect(l.n).toBe(1) // 每方向 1 条
    expect(l.laneW).toBeCloseTo(4.4) // 半幅宽 4.4 米
    expect(l.offsets).toEqual([2.2]) // 车道中心在半幅正中
  })

  it('22m 的环路单向 3 条，车道等分半幅', () => {
    const l = laneLayout(22) // 主干路
    expect(l.n).toBe(3) // 每方向 3 条
    expect(l.laneW).toBeCloseTo(11 / 3) // 半幅 11 米三等分
    // 车道中心依次向外排，最外侧贴着路沿
    expect(l.offsets[0]).toBeLessThan(l.offsets[1]) // 从中心线往外排
    expect(l.offsets[2]).toBeCloseTo(11 - l.laneW / 2) // 最外侧车道贴着路边
  })

  it('最多 4 条车道，再宽也不加', () => {
    expect(laneLayout(60).n).toBe(4) // 封顶 4 条
  })
})

describe('laneLayout 桥下的路（median）', () => {
  it('桥面正下方 median 宽不排车道，车道从桥面投影外侧开始', () => {
    const l = laneLayout(39.2, false, 9.2) // 桥下 9.2 米是桥墩和隔离带
    expect(l.inner).toBeCloseTo(9.6) // median + 0.4
    expect(l.offsets[0]).toBeGreaterThan(9.6) // 第一条车道在桥面投影外侧
    // 半幅 19.6 减去 9.6 剩 10m → 3 条车道
    expect(l.n).toBe(3) // 每方向 3 条
  })
})

describe('laneLayout 单行路（环岛）', () => {
  it('整幅都是同向车道，偏移左右对称', () => {
    const l = laneLayout(7, true) // 7 米环道
    expect(l.n).toBe(2) // 两圈
    expect(l.offsets[0]).toBeCloseTo(-l.offsets[1]) // 关于中心线对称
  })

  it('环道最多两圈', () => {
    expect(laneLayout(20, true).n).toBe(2) // 再宽也只有两圈
  })
})

describe('hasMedian', () => {
  it('单向 ≥3 车道才有实体隔离带；单行路没有', () => {
    expect(hasMedian(22)).toBe(true) // 22 米: 每方向 3 条，有隔离带
    expect(hasMedian(14)).toBe(false) // 14 米: 每方向 2 条，没有
    expect(hasMedian(22, true)).toBe(false) // 单行路没有
  })
})

it('高架标高是个正数常量', () => {
  expect(ELEVATED_H).toBeGreaterThan(4) // 桥面比地面高
})

describe('laneLayout 指定车道数（场景编辑器画的路）', () => {
  it('双向路按指定的每方向车道数排，车道宽 = 半幅宽 / n', () => {
    const l = laneLayout(14, false, 0, 2) // 14 米按路宽推也是 2 条，这里验证指定值
    expect(l.n).toBe(2) // 按指定的 2 条
    expect(l.laneW).toBeCloseTo(3.5) // 14 米半幅 7 米 / 2
    expect(laneLayout(14, false, 0, 1).n).toBe(1) // 宽路只要 1 条: 宽车道
    expect(laneLayout(14, false, 0, 9).n).toBe(4) // 最多 4 条
  })

  it('单行路不再受环道「最多 2 条」的限制', () => {
    const l = laneLayout(10.5, true, 0, 3) // 三车道单行路
    expect(l.n).toBe(3) // 按指定的 3 条
    expect(l.offsets).toEqual([-3.5, 0, 3.5]) // 整幅同向，关于中心线对称
    expect(laneLayout(10.5, true).n).toBe(2) // 不指定时仍按环道规则
  })

  it('中央隔离带按指定车道数判断', () => {
    expect(hasMedian(21, false, 3)).toBe(true) // 每方向 3 条
    expect(hasMedian(22, false, 2)).toBe(false) // 宽路但只要 2 条
  })
})
