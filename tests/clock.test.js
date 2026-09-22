// 仿真时钟与日历的单元测试。这个模块是全城唯一的时间来源，错了所有东西都跟着错，所以覆盖得细一点。
import { describe, it, expect } from 'vitest'
import { SimClock, activity, daylight, DAY_TYPE_LABEL } from '../src/city/clock.js'

describe('SimClock 基本推进', () => {
  it('tick 按 rate 推进仿真时间并返回这一帧的仿真秒', () => {
    const c = new SimClock({ start: '2026-09-21T07:30:00', rate: 60 })
    // 现实 1 秒 = 仿真 60 秒
    expect(c.tick(1)).toBe(60)
    expect(c.label.time).toBe('07:31')
    // 小数小时: 7:31 = 7.5167
    expect(c.hour).toBeCloseTo(7 + 31 / 60, 3)
  })

  it('暂停时不推进', () => {
    const c = new SimClock({ start: '2026-09-21T07:30:00', rate: 60 })
    c.paused = true
    expect(c.tick(5)).toBe(0)
    expect(c.label.time).toBe('07:30')
  })

  it('跨分钟 / 整点 / 换日时依次触发事件', () => {
    const c = new SimClock({ start: '2026-09-21T23:59:30', rate: 1 })
    const got = []
    c.on((ev) => got.push(ev))
    c.tick(45) // 23:59:30 → 00:00:15，同时跨了分钟、小时、日期
    expect(got).toEqual(['minute', 'hour', 'day'])
  })

  it('on 返回的取消函数能移除监听', () => {
    const c = new SimClock({ start: '2026-09-21T07:59:50', rate: 1 })
    const got = []
    const off = c.on((ev) => got.push(ev))
    off()
    c.tick(20)
    expect(got).toEqual([])
  })
})

describe('日历: 工作日 / 周末 / 节假日', () => {
  it('普通周一是工作日，周六周日是周末', () => {
    const c = new SimClock({ start: '2026-09-21T10:00:00' }) // 2026-09-21 周一
    expect(c.dayType).toBe('workday')
    expect(c.dayTypeOf(new Date(2026, 8, 26))).toBe('weekend') // 周六
    expect(c.dayTypeOf(new Date(2026, 8, 27))).toBe('weekend') // 周日
  })

  it('法定节假日优先于周几；调休上班日强制为工作日', () => {
    const c = new SimClock({ start: '2026-09-21T10:00:00', holidays: ['2026-10-01'], makeupWorkdays: ['2026-09-27'] })
    expect(c.dayTypeOf(new Date(2026, 9, 1))).toBe('holiday') // 国庆，周四
    expect(c.dayTypeOf(new Date(2026, 8, 27))).toBe('workday') // 本是周日，调休上班
  })

  it('时刻表只分两套: 周末和节假日都用 holiday 表', () => {
    const c = new SimClock({ start: '2026-09-26T10:00:00' }) // 周六
    expect(c.timetable).toBe('holiday')
    c.jumpToDayType('workday', 9)
    expect(c.timetable).toBe('workday')
  })

  it('label 输出中文日期、时间和日类型', () => {
    const c = new SimClock({ start: '2026-09-21T07:05:00' })
    expect(c.label).toEqual({ date: '9月21日 周一', time: '07:05', dayType: DAY_TYPE_LABEL.workday })
  })
})

describe('跳时间', () => {
  it('jumpToHour 跳到今天的该时刻；已经过了就跳到明天', () => {
    const c = new SimClock({ start: '2026-09-21T10:00:00' })
    c.jumpToHour(18.5)
    expect(c.label).toMatchObject({ date: '9月21日 周一', time: '18:30' })
    c.jumpToHour(8) // 8 点已过 → 明天 8 点
    expect(c.label).toMatchObject({ date: '9月22日 周二', time: '08:00' })
  })

  it('jumpToDayType 找到下一个该类型的日子', () => {
    const c = new SimClock({ start: '2026-09-21T10:00:00', holidays: ['2026-10-01'] })
    c.jumpToDayType('weekend', 15)
    expect(c.label).toMatchObject({ date: '9月26日 周六', time: '15:00' })
    c.jumpToDayType('holiday', 9)
    expect(c.label).toMatchObject({ date: '10月1日 周四', time: '09:00', dayType: '节假日' })
  })

  it('跳时间触发 jump 事件（世界状态需要重置）', () => {
    const c = new SimClock({ start: '2026-09-21T10:00:00' })
    const got = []
    c.on((ev) => got.push(ev))
    c.jumpTo(new Date('2026-09-22T12:00:00').getTime())
    expect(got[0]).toBe('jump')
    expect(c.label.time).toBe('12:00')
  })
})

describe('日曲线', () => {
  it('activity 在 0~1 之间，早高峰高于凌晨', () => {
    for (const day of ['workday', 'weekend', 'holiday']) {
      for (const kind of ['people', 'cars']) {
        for (let h = 0; h <= 24; h += 0.5) {
          const v = activity(kind, day, h)
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
      }
    }
    expect(activity('cars', 'workday', 8.5)).toBeGreaterThan(activity('cars', 'workday', 3))
  })

  it('activity 在节点之间线性插值', () => {
    // workday people: [5.5, 0.04] → [7, 0.3]，中点 6.25 应为 0.17
    expect(activity('people', 'workday', 6.25)).toBeCloseTo(0.17, 6)
  })

  it('daylight 正午最亮、深夜为 0', () => {
    expect(daylight(12)).toBe(1)
    expect(daylight(0)).toBe(0)
    expect(daylight(6.5)).toBeGreaterThan(0)
  })
})
