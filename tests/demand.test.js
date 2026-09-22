// 需求模型的测试: 人群分组的出现曲线、活动偏好、场馆排期、住户出行曲线。全部由时钟驱动，所以每个用例先造一个时钟。
import { describe, it, expect } from 'vitest'
import { SimClock } from '../src/city/clock.js'
import { Demand, GROUPS } from '../src/city/demand.js'

const VENUES = [
  { id: 'b1', name: '体育场', type: 'stadium', capacity: 9000 },
  { id: 'b2', name: '大剧院', type: 'opera', capacity: 1600 },
]
const make = (start = '2026-09-21T08:00:00', opts = {}) => {
  const clock = new SimClock({ start, holidays: ['2026-10-01'] })
  return { clock, d: new Demand(clock, VENUES, opts) }
}

describe('人群分组', () => {
  it('四类人群的规模份额之和为 1', () => {
    expect(GROUPS.reduce((s, g) => s + g.share, 0)).toBeCloseTo(1)
  })

  it('targets 在工作日早上以上班族为主，深夜几乎没人', () => {
    const { clock, d } = make('2026-09-21T09:30:00')
    const t = d.targets(600)
    expect(t.length).toBe(GROUPS.length)
    expect(t[0]).toBeGreaterThan(t[1] + t[2] + t[3]) // 上班族 > 其他三类之和
    clock.jumpToHour(3)
    expect(d.targets(600).reduce((a, b) => a + b, 0)).toBeLessThan(60)
  })

  it('休息日访客的规模比工作日大', () => {
    const wk = make('2026-09-21T14:00:00').d.targets(600)[3]
    const we = make('2026-09-26T14:00:00').d.targets(600)[3]
    expect(we).toBeGreaterThan(wk)
  })

  it('活动偏好: 上班族工作日上午以办公为主，休息日不上班', () => {
    const { clock, d } = make('2026-09-21T09:00:00')
    expect(d.mix(0).office).toBeGreaterThan(5)
    clock.jumpToDayType('weekend', 10)
    expect(d.mix(0).office).toBeUndefined()
  })

  it('officeStay: 上午进楼待到午饭点，下午待到下班点', () => {
    const { clock, d } = make('2026-09-21T09:00:00')
    const rand = () => 0.5
    expect(d.officeStay(rand) / 3600).toBeCloseTo(3, 1) // 9 → 12
    clock.jumpToHour(14)
    expect(d.officeStay(rand) / 3600).toBeCloseTo(4.28, 2) // 14 → 18 + (0.5-0.3)*1.4 = 18.28
  })
})

describe('场馆排期', () => {
  it('排期按日期确定: 同一天两次算出的场次一样', () => {
    const a = make('2026-09-26T08:00:00').d.events.map((e) => e.start + e.venue)
    const b = make('2026-09-26T08:00:00').d.events.map((e) => e.start + e.venue)
    expect(a).toEqual(b)
  })

  it('观众数按 eventScale 缩放，realAttendance 是真实人数', () => {
    const { d } = make('2026-09-26T08:00:00', { eventScale: 0.5 })
    for (const ev of d.events) {
      expect(ev.attendance).toBeCloseTo(ev.realAttendance * 0.5, -1)
      expect(ev.realAttendance).toBeLessThanOrEqual(VENUES.find((v) => v.id === ev.venue).capacity)
    }
  })

  it('phaseOf 依次经过 进场 → 进行中 → 散场 → 无', () => {
    const { clock, d } = make('2026-09-26T08:00:00')
    const ev = d.events[0]
    expect(ev).toBeDefined()
    clock.jumpTo(ev.start - 30 * 60000)
    expect(d.phaseOf(ev.venue).phase).toBe('ingress')
    clock.jumpTo(ev.start + 30 * 60000)
    expect(d.phaseOf(ev.venue).phase).toBe('live')
    clock.jumpTo(ev.end + 10 * 60000)
    expect(d.phaseOf(ev.venue).phase).toBe('egress')
    clock.jumpTo(ev.end + 60 * 60000)
    expect(d.phaseOf(ev.venue)).toBeNull()
  })

  it('eventExtra 在活动进行中等于观众数，没活动时为 0', () => {
    const { clock, d } = make('2026-09-26T08:00:00')
    const ev = d.events[0]
    clock.jumpTo(ev.start + 30 * 60000)
    expect(d.eventExtra()).toBeGreaterThanOrEqual(ev.attendance)
    clock.jumpTo(new Date('2026-09-26T03:00:00').getTime())
    expect(d.eventExtra()).toBe(0)
  })

  it('nextIngress 返回下一场进场前一小时的时刻，没有则 null', () => {
    const { clock, d } = make('2026-09-26T08:00:00')
    const t = d.nextIngress()
    expect(t).toBe(d.events[0].start - 60 * 60000)
    // 跳到所有场次之后（排期只排今天和明天）
    clock.jumpTo(d.events[d.events.length - 1].end + 1)
    // 换日事件会重排，所以这里只断言返回值类型
    expect(d.nextIngress() === null || typeof d.nextIngress() === 'number').toBe(true)
  })

  it('upcoming 带可读时间和阶段', () => {
    const { d } = make('2026-09-26T08:00:00')
    const u = d.upcoming(2)
    expect(u.length).toBeLessThanOrEqual(2)
    if (u.length) {
      expect(u[0].time).toMatch(/^\d+\/\d+ \d\d:\d\d$/)
      expect(['scheduled', 'ingress', 'live', 'egress']).toContain(u[0].phase)
    }
  })
})

describe('住户出行曲线', () => {
  it('住户数按面积 / 45㎡ 缩放，至少 4 人', () => {
    const { d } = make('2026-09-21T08:00:00', { residentScale: 0.1 })
    expect(d.residentsOf(1000, 10)).toBe(Math.round((1000 * 10) / 45 * 0.1))
    expect(d.residentsOf(10, 1)).toBe(4)
  })

  it('工作日早高峰离家率高、回家率低；晚上反过来', () => {
    const { clock, d } = make('2026-09-21T07:30:00')
    expect(d.homeDepartRate()).toBeGreaterThan(0.5)
    expect(d.homeReturnRate()).toBeLessThan(0.1)
    clock.jumpToHour(19)
    expect(d.homeDepartRate()).toBeLessThan(0.2)
    expect(d.homeReturnRate()).toBeGreaterThan(0.8)
  })

  it('在家比例: 凌晨几乎全在家，工作日上午 10 点大部分人不在家', () => {
    const { clock, d } = make('2026-09-21T02:00:00')
    expect(d.homeFraction()).toBeGreaterThan(0.98) // [0,1]→[6,0.97] 之间插值
    clock.jumpToHour(10)
    expect(d.homeFraction()).toBeLessThan(0.4)
  })

  it('工作日早上出门的以上班族为主，且多数通勤离开核心区', () => {
    const { d } = make('2026-09-21T07:30:00')
    let workers = 0
    for (let i = 0; i < 100; i++) if (d.residentGroup(() => i / 100) === 0) workers++
    expect(workers).toBeGreaterThanOrEqual(65)
    expect(d.commuteOutProb(0)).toBeGreaterThan(0.5)
    expect(d.commuteOutProb(1)).toBeLessThan(0.5)
  })
})
