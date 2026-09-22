// 轨道交通时刻表的测试。Transit 类本身要建网格（three 几何体）和导航网格，这里只测纯逻辑的发车间隔查询。
import { describe, it, expect } from 'vitest'
import { headwayAt, TIMETABLES } from '../src/city/transit.js'

describe('headwayAt', () => {
  it('夜间停运: 间隔为 0', () => {
    expect(headwayAt('metro', 'workday', 2)).toBe(0)
    expect(headwayAt('rail', 'holiday', 1)).toBe(0)
  })

  it('工作日早高峰地铁 3 分钟一班，平峰更稀', () => {
    expect(headwayAt('metro', 'workday', 8)).toBe(3)
    expect(headwayAt('metro', 'workday', 11)).toBeGreaterThan(3)
  })

  it('节假日表和工作日表不同', () => {
    expect(headwayAt('metro', 'holiday', 8)).not.toBe(headwayAt('metro', 'workday', 8))
  })

  it('时段边界: 恰好在起始小时上取新时段的值', () => {
    // metro workday: [7, 3] 从 7:00 起
    expect(headwayAt('metro', 'workday', 7)).toBe(3)
    expect(headwayAt('metro', 'workday', 6.99)).toBe(8)
  })

  it('可传入自定义时刻表', () => {
    const tables = { metro: { workday: [[0, 12]], holiday: [[0, 0]] } }
    expect(headwayAt('metro', 'workday', 15, tables)).toBe(12)
    expect(headwayAt('metro', 'holiday', 15, tables)).toBe(0)
  })

  it('内置表每个时段的起始小时递增', () => {
    for (const kind of Object.keys(TIMETABLES)) {
      for (const day of Object.keys(TIMETABLES[kind])) {
        const hours = TIMETABLES[kind][day].map((r) => r[0])
        for (let i = 1; i < hours.length; i++) expect(hours[i]).toBeGreaterThan(hours[i - 1])
      }
    }
  })
})
