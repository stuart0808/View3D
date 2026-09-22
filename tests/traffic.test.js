// 车流的测试。手工拼一个小路网: 一条 300m 的东西向四车道路 + 中点一个 T 形路口向北的支路。
// 导航网格用假对象（没有行人、没有建筑），验证路网构建、铺车、跟车、路口通过、需求缩放、出入口限流。
import { describe, it, expect } from 'vitest'
import { Traffic } from '../src/city/traffic.js'
import { SURFACE } from '../src/city/navgrid.js'
import { makeRandom } from '../src/city/geometry.js'
import { laneLayout } from '../src/city/roads.js'

// 节点: w(-150,0) 度1，x(0,0) 度3，e(150,0) 度1，n(0,-150) 度1
const graph = {
  nodes: { w: { pos: [-150, 0], radius: 7.3, degree: 1 }, x: { pos: [0, 0], radius: 7.3, degree: 3 }, e: { pos: [150, 0], radius: 7.3, degree: 1 }, n: { pos: [0, -150], radius: 4.4, degree: 1 } },
  edges: [
    { a: 'w', b: 'x', width: 14.6, points: [[-150, 0], [0, 0]], ext: [0, 4.4] },
    { a: 'x', b: 'e', width: 14.6, points: [[0, 0], [150, 0]], ext: [4.4, 0] },
    { a: 'x', b: 'n', width: 8.8, points: [[0, 0], [0, -150]], ext: [7.3, 0] },
  ],
}
const scene = () => ({ roadGraph: graph, lanes: [], crosswalks: [], areas: [], buildings: [], bounds: { minX: -200, minY: -200, maxX: 200, maxY: 200 } })
// 假导航网格: 到处都是车行道（没有人行道，出入口 / 匝道都不会建）
const nav = { surfaceAt: () => SURFACE.ROAD, contains: () => true, isWalkable: () => false }
const make = (opts = {}) => new Traffic(scene(), nav, makeRandom(9), { signals: null, ...opts })
const onRoad = (T) => T.cars.filter((c) => c.mode === 'lane' || c.mode === 'turn')

describe('路网', () => {
  it('每条边两个方向，车道数按路宽，车道两端在路口处截短', () => {
    const T = make()
    expect(T.ways.length).toBe(6)
    const main = T.ways.find((w) => w.from === 'w' && w.to === 'x')
    expect(main.n).toBe(laneLayout(14.6).n) // 2
    expect(main.lanes[0].len).toBeLessThan(150) // 路口处截掉了
    expect(main.lanes[0].len).toBeGreaterThan(130)
    expect(main.twin.from).toBe('x')
  })

  it('路口的进口道 / 出路登记正确；度 1 的节点是入口', () => {
    const T = make()
    expect(T.nodes.x.out.length).toBe(3)
    expect(T.nodes.x.inn.length).toBe(3)
    expect(T.entries.length).toBe(3)
  })
})

describe('运行', () => {
  it('开场按密度铺车，全部在车道上且不重叠', () => {
    const T = make()
    expect(T.cars.length).toBeGreaterThan(3)
    expect(T.cars.length).toBeLessThanOrEqual(T.target)
    for (const lane of T.lanes) {
      for (let i = 1; i < lane.cars.length; i++) expect(lane.cars[i].s - lane.cars[i - 1].s).toBeGreaterThanOrEqual(12 - 1e-6)
    }
  })

  it('推进后车在动，车道上的车始终按 s 排序、彼此不叠', () => {
    const T = make()
    const before = T.cars.map((c) => c.s)
    for (let i = 0; i < 400; i++) T.update(0.25, false)
    expect(T.cars.some((c, i) => c.s !== before[i])).toBe(true)
    for (const lane of T.lanes) {
      for (let i = 1; i < lane.cars.length; i++) {
        const a = lane.cars[i - 1], b = lane.cars[i]
        if (a.isGhost || b.isGhost) continue
        expect(b.s - a.s).toBeGreaterThan(CAR_LEN_MIN)
      }
    }
  })

  it('车能通过路口转到下一条路（turn 模式出现且结束）', () => {
    const T = make()
    let sawTurn = false
    for (let i = 0; i < 800; i++) {
      T.update(0.25, false)
      if (T.cars.some((c) => c.mode === 'turn')) sawTurn = true
    }
    expect(sawTurn).toBe(true)
    // 路口的 turning 列表和实际在路口里的车一致
    expect(T.nodes.x.turning.length).toBe(T.cars.filter((c) => c.mode === 'turn').length)
  })

  it('出图的车从入口补回来，在途车数维持在目标附近', () => {
    const T = make()
    for (let i = 0; i < 1200; i++) T.update(0.25, false)
    expect(onRoad(T).length).toBeGreaterThan(T.target * 0.5)
    expect(onRoad(T).length).toBeLessThanOrEqual(T.target + 3)
  })

  it('setDemand 缩放目标车数，最低 12%', () => {
    const T = make()
    const base = T.baseTarget
    T.setDemand(0.5)
    expect(T.target).toBe(Math.round(base * 0.5))
    T.setDemand(0)
    expect(T.target).toBe(Math.round(base * 0.12))
  })

  it('实例矩阵按车数写，朝向是单位向量', () => {
    const T = make()
    T.update(0.25, true)
    expect(T.mesh.count).toBe(T.cars.length)
    const a = T.mesh.instanceMatrix.array
    expect(Math.hypot(a[0], a[2])).toBeCloseTo(1)
  })
})

// 车道上前后两辆车中心距至少要大于一个车长减一点（刹停时 gap = CAR_LEN + 2.5 的余量）
const CAR_LEN_MIN = 4.0
