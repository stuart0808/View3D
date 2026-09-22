// Transit 类的测试: 按时刻表发车、列车运行与停站、到站回调、跳时间重铺、夜间停运。
// 导航网格用假对象（车站出入口落点），三维网格在 node 里能正常建。
import { describe, it, expect } from 'vitest'
import { SimClock } from '../src/city/clock.js'
import { Transit } from '../src/city/transit.js'

// 一条 6km 长的直线地铁（够铺好几列车），三个站；一条环线
const scene = (lines) => ({ buildings: [], transit: { lines } })
const M1 = { id: 'M1', name: '1号线', kind: 'metro', color: '#f2c230', points: [[0, 0], [6000, 0]], stations: [{ name: 'A', pos: [200, 0] }, { name: 'B', pos: [3000, 0] }, { name: 'C', pos: [5800, 0] }] }
const M3 = { id: 'M3', name: '环线', kind: 'metro', color: '#3b7ddd', loop: true, points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], stations: [{ name: 'B', pos: [1000, 0] }, { name: 'D', pos: [0, 1000] }] }
const nav = { contains: () => true, nearestWalkable: (x, y) => Math.round(x) * 10000 + Math.round(y), center: (k) => [Math.floor(k / 10000), k % 10000] }
const make = (start, lines = [M1]) => { const clock = new SimClock({ start }); return { clock, T: new Transit(scene(lines), nav, clock) } }

describe('车站', () => {
  it('同名车站合并为换乘站，出入口最多两个', () => {
    const { T } = make('2026-09-21T08:00:00', [M1, M3])
    expect(T.stations.size).toBe(4) // A B C D
    expect(T.stations.get('B').lines.length).toBe(2)
    for (const st of T.stations.values()) expect(st.entrances.length).toBeLessThanOrEqual(2)
  })

  it('portals 给人群用: 每个出入口一条，换乘站权重更高', () => {
    const { T } = make('2026-09-21T08:00:00', [M1, M3])
    const ps = T.portals()
    expect(ps.length).toBeGreaterThan(0)
    const b = ps.find((p) => p.station === 'B'), a = ps.find((p) => p.station === 'A')
    expect(b.weight).toBeGreaterThan(a.weight)
  })
})

describe('发车与运行', () => {
  it('早高峰开场时线路上已经铺了车，夜里一列都没有', () => {
    expect(make('2026-09-21T08:00:00').T.trains.length).toBeGreaterThan(2)
    expect(make('2026-09-21T02:00:00').T.trains.length).toBe(0)
  })

  it('按间隔从端点发车: 推进一个间隔后车数增加', () => {
    const { clock, T } = make('2026-09-21T08:00:00')
    const n0 = T.trains.length
    // 3 分钟一班，两个方向 → 推 190 秒至少各发一班
    for (let i = 0; i < 190; i++) { clock.tick(1); T.update(1) }
    expect(T.trains.length).toBeGreaterThanOrEqual(n0 + 1)
    expect(T.stats().headwayMin.M1).toBe(3)
  })

  it('列车到站时触发 onArrive，站名正确；停站期间不动', () => {
    const { clock, T } = make('2026-09-21T08:00:00')
    T.trains = []
    T.lines[0].next = { 1: Infinity, [-1]: Infinity } // 关掉自动发车，只观察这一列
    T.trains.push({ line: T.lines[0], dir: 1, s: 150, v: 10, stops: T.lines[0].stops, idx: 0, dwell: 0 })
    const arrived = []
    T.onArrive = (name) => arrived.push(name)
    let steps = 0
    while (!arrived.length && steps++ < 600) { clock.tick(0.25); T.update(0.25) }
    expect(arrived).toEqual(['A'])
    const t = T.trains[0]
    expect(t.s).toBeCloseTo(200)
    expect(t.dwell).toBeGreaterThan(0)
    const s0 = t.s
    T.update(1)
    expect(t.s).toBe(s0) // 停站中不动
  })

  it('跳时间后按新时刻重新铺车（jump 事件）', () => {
    const { clock, T } = make('2026-09-21T08:00:00')
    clock.jumpToHour(2)
    expect(T.trains.length).toBe(0)
    clock.jumpToHour(18)
    expect(T.trains.length).toBeGreaterThan(2)
  })

  it('实例矩阵按车厢数写: 不超过 列车数 × 编组（线路端点外的车厢不画）', () => {
    const { T } = make('2026-09-21T08:00:00')
    T.update(0.1, true)
    const max = T.trains.reduce((n, t) => n + t.line.spec.cars, 0)
    expect(T.meshes.metro.count).toBeGreaterThan(0)
    expect(T.meshes.metro.count).toBeLessThanOrEqual(max)
  })
})
