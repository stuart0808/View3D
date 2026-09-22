// 车流的测试。手工拼一个小路网: 一条 300m 的东西向四车道路 + 中点一个 T 形路口向北的支路。
// 导航网格用假对象（没有行人、没有建筑），验证路网构建、铺车、跟车、路口通过、需求缩放、出入口限流。
import { describe, it, expect } from 'vitest' // vitest 的断言
import { Traffic } from '../src/city/traffic.js' // 被测模块
import { SURFACE } from '../src/city/navgrid.js' // 路面类型常量
import { makeRandom } from '../src/city/geometry.js' // 可复现的随机数
import { laneLayout } from '../src/city/roads.js' // 车道数按路宽

// 节点: w(-150,0) 度1，x(0,0) 度3，e(150,0) 度1，n(0,-150) 度1
const graph = { // 手拼的小路网
  nodes: { w: { pos: [-150, 0], radius: 7.3, degree: 1 }, x: { pos: [0, 0], radius: 7.3, degree: 3 }, e: { pos: [150, 0], radius: 7.3, degree: 1 }, n: { pos: [0, -150], radius: 4.4, degree: 1 } }, // 四个节点: 两端、路口、北端
  edges: [ // 三条边
    { a: 'w', b: 'x', width: 14.6, points: [[-150, 0], [0, 0]], ext: [0, 4.4] }, // 西段，双向 2+2
    { a: 'x', b: 'e', width: 14.6, points: [[0, 0], [150, 0]], ext: [4.4, 0] }, // 东段，双向 2+2
    { a: 'x', b: 'n', width: 8.8, points: [[0, 0], [0, -150]], ext: [7.3, 0] }, // 北支路，双向 1+1
  ], // 边结束
}
const scene = () => ({ roadGraph: graph, lanes: [], crosswalks: [], areas: [], buildings: [], bounds: { minX: -200, minY: -200, maxX: 200, maxY: 200 } }) // 最小场景
// 假导航网格: 到处都是车行道（没有人行道，出入口 / 匝道都不会建）
const nav = { surfaceAt: () => SURFACE.ROAD, contains: () => true, isWalkable: () => false } // 到处都是车行道
const make = (opts = {}) => new Traffic(scene(), nav, makeRandom(9), { signals: null, ...opts }) // 不带红绿灯的车流
const onRoad = (T) => T.cars.filter((c) => c.mode === 'lane' || c.mode === 'turn') // 在路上（直行或转弯中）的车

describe('路网', () => { // 路网构建
  it('每条边两个方向，车道数按路宽，车道两端在路口处截短', () => {
    const T = make() // 新建车流
    expect(T.ways.length).toBe(6) // 3 条边 × 2 个方向
    const main = T.ways.find((w) => w.from === 'w' && w.to === 'x') // 西段往东的方向
    expect(main.n).toBe(laneLayout(14.6).n) // 2
    expect(main.lanes[0].len).toBeLessThan(150) // 路口处截掉了
    expect(main.lanes[0].len).toBeGreaterThan(130) // 截短后仍有 130 米以上
    expect(main.twin.from).toBe('x') // 对向是从路口出发的
  })

  it('路口的进口道 / 出路登记正确；度 1 的节点是入口', () => {
    const T = make() // 新建车流
    expect(T.nodes.x.out.length).toBe(3) // 路口有 3 条出路
    expect(T.nodes.x.inn.length).toBe(3) // 路口有 3 条进口道
    expect(T.entries.length).toBe(3) // 三个断头端都是入口
  })
})

describe('运行', () => { // 运行
  it('开场按密度铺车，全部在车道上且不重叠', () => {
    const T = make() // 新建车流
    expect(T.cars.length).toBeGreaterThan(3) // 铺了车
    expect(T.cars.length).toBeLessThanOrEqual(T.target) // 不超过目标车数
    for (const lane of T.lanes) { // 每条车道
      for (let i = 1; i < lane.cars.length; i++) expect(lane.cars[i].s - lane.cars[i - 1].s).toBeGreaterThanOrEqual(12 - 1e-6) // 前后车间距不小于 12 米
    }
  })

  it('推进后车在动，车道上的车始终按 s 排序、彼此不叠', () => {
    const T = make() // 新建车流
    const before = T.cars.map((c) => c.s) // 开场时各车的位置
    for (let i = 0; i < 400; i++) T.update(0.25, false) // 跑 100 秒
    expect(T.cars.some((c, i) => c.s !== before[i])).toBe(true) // 有车动了
    for (const lane of T.lanes) { // 每条车道
      for (let i = 1; i < lane.cars.length; i++) { // 相邻两辆车
        const a = lane.cars[i - 1], b = lane.cars[i] // 前后两辆
        if (a.isGhost || b.isGhost) continue // 变道时的影子车不算
        expect(b.s - a.s).toBeGreaterThan(CAR_LEN_MIN) // 不重叠
      }
    }
  })

  it('车能通过路口转到下一条路（turn 模式出现且结束）', () => {
    const T = make() // 新建车流
    let sawTurn = false // 有没有见过转弯中的车
    for (let i = 0; i < 800; i++) { // 跑 200 秒
      T.update(0.25, false) // 推进一步
      if (T.cars.some((c) => c.mode === 'turn')) sawTurn = true // 见到了
    }
    expect(sawTurn).toBe(true) // 车能进路口转弯
    // 路口的 turning 列表和实际在路口里的车一致
    expect(T.nodes.x.turning.length).toBe(T.cars.filter((c) => c.mode === 'turn').length) // 路口登记的转弯车和实际一致
  })

  it('出图的车从入口补回来，在途车数维持在目标附近', () => {
    const T = make() // 新建车流
    for (let i = 0; i < 1200; i++) T.update(0.25, false) // 跑 300 秒
    expect(onRoad(T).length).toBeGreaterThan(T.target * 0.5) // 不会越跑越少
    expect(onRoad(T).length).toBeLessThanOrEqual(T.target + 3) // 也不会超出目标
  })

  it('setDemand 缩放目标车数，最低 12%', () => {
    const T = make() // 新建车流
    const base = T.baseTarget // 基准目标车数
    T.setDemand(0.5) // 需求减半
    expect(T.target).toBe(Math.round(base * 0.5)) // 目标跟着减半
    T.setDemand(0) // 需求为 0
    expect(T.target).toBe(Math.round(base * 0.12)) // 保底 12%
  })

  it('实例矩阵按车数写，朝向是单位向量', () => {
    const T = make() // 新建车流
    T.update(0.25, true) // 推进并写实例矩阵
    expect(T.mesh.count).toBe(T.cars.length) // 每辆车一个实例
    const a = T.mesh.instanceMatrix.array // 矩阵数组
    expect(Math.hypot(a[0], a[2])).toBeCloseTo(1) // 第一辆车的朝向向量长度为 1
  })
})

// 车道上前后两辆车中心距至少要大于一个车长减一点（刹停时 gap = CAR_LEN + 2.5 的余量）
const CAR_LEN_MIN = 4.0 // 最短车身（米），判断重叠用

describe('场景编辑器的禁止左转', () => { // 禁止左转
  /** 从西往东开到路口 x 的车: 去北边是左转；禁止左转后应该全部直行去东边 */
  const nextFromWest = (noLeft) => { // 统计西来车辆的去向
    const g = { ...graph, nodes: { ...graph.nodes, x: { ...graph.nodes.x, noLeft } } } // 路口 x 设禁左
    const T = new Traffic({ ...scene(), roadGraph: g }, nav, makeRandom(9), { signals: null }) // 带设置的车流
    const seen = new Set() // 西来车辆选的下一条路的终点
    for (let i = 0; i < 400; i++) { // 跑 100 秒
      T.update(0.25, false) // 推进一步
      for (const c of T.cars) if (c.lane?.way.from === 'w' && c.lane.way.to === 'x' && c.nextWay) seen.add(c.nextWay.to) // 西来、正在开向路口、已经选好下一条路的车
    }
    return seen // 去过的终点
  }

  it('不禁左转时西来的车有左转去北边的；禁止后没有', () => {
    expect(nextFromWest(false).has('n')).toBe(true) // 随机选路，400 步里肯定有左转的
    const s = nextFromWest(true) // 禁左后的去向
    expect(s.has('n')).toBe(false) // 禁左
    expect(s.has('e')).toBe(true) // 直行照常
  })
})
