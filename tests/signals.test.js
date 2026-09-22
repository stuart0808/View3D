// 红绿灯的测试: 相位函数、进口道分轴、行人起步窗口、灯头网格的生成。
import { describe, it, expect } from 'vitest' // vitest 的断言
import { Signals, phaseOf, makeTiming, armAngle, GREEN, YELLOW, CYCLE, WALK_WINDOW } from '../src/city/signals.js' // 被测模块

// 一个十字路口 X（节点 'x'），四条路: 东 e、西 w、北 n、南 s；再加一个 T 形路口和一个只有两条路的「节点」
const scene = { // 测试用的小路网
  roadGraph: { // 只用到 roadGraph 和 crosswalks
    nodes: { x: { degree: 4 }, t: { degree: 3 }, mid: { degree: 2 }, rb: { degree: 3, roundabout: true } }, // 十字、丁字、度 2、环岛各一个
    edges: [ // 边的下标就是进口道编号
      { a: 'x', b: 'e', points: [[0, 0], [50, 0]] },        // 0 东
      { a: 'w', b: 'x', points: [[-50, 0], [0, 0]] },       // 1 西（路口在末端）
      { a: 'x', b: 'n', points: [[0, 0], [0, -50]] },       // 2 北
      { a: 's', b: 'x', points: [[0, 50], [0, 0]] },        // 3 南
      { a: 't', b: 'p', points: [[100, 0], [150, 0]] },     // 4
      { a: 't', b: 'q', points: [[100, 0], [100, 50]] },    // 5
      { a: 'r', b: 't', points: [[50, 0], [100, 0]] },      // 6
      { a: 'mid', b: 'z', points: [[0, 100], [0, 150]] },   // 7 度 2 的节点，不设灯
    ],
  },
  crosswalks: [ // 三条斑马线
    { node: 'x', edge: 0, center: [8, 0], dir: [1, 0], span: 8, depth: 3 }, // 横跨东路
    { node: 'x', edge: 2, center: [0, -8], dir: [0, -1], span: 8, depth: 3 }, // 横跨北路
    { center: [30, 0], dir: [1, 0], span: 8, depth: 3 }, // 路段中途，没灯
  ],
}
const rand0 = () => 0 // 相位从 0 开始，方便断言

describe('phaseOf', () => { // 相位函数
  it('0 轴: 绿 → 黄 → 红，1 轴错开半个周期', () => {
    expect(phaseOf(0, 0)).toBe('G') // 0 轴开头是绿灯
    expect(phaseOf(GREEN + 1, 0)).toBe('Y') // 绿灯之后黄灯
    expect(phaseOf(GREEN + YELLOW + 1, 0)).toBe('R') // 黄灯之后红灯
    expect(phaseOf(0, 1)).toBe('R') // 1 轴开头是红灯
    expect(phaseOf(CYCLE / 2, 1)).toBe('G') // 1 轴半个周期后变绿
  })

  it('两轴永远不同时绿', () => { // 安全性质
    for (let t = 0; t < CYCLE; t += 0.5) expect(phaseOf(t, 0) === 'G' && phaseOf(t, 1) === 'G').toBe(false) // 逐个时刻检查
  })
})

describe('armAngle', () => { // 进口道方向角
  it('从路口向外的方向角；reversed 时从末端起算', () => {
    expect(armAngle([[0, 0], [50, 0]], false)).toBeCloseTo(0) // 向东
    expect(armAngle([[-50, 0], [0, 0]], true)).toBeCloseTo(Math.PI) // 路口在末端，向外指向 -x
    expect(armAngle([[0, 0], [0, -50]], false)).toBeCloseTo(-Math.PI / 2) // 向北（y 向下为负）
  })
})

describe('Signals 路口与分轴', () => {
  const S = new Signals(scene, rand0) // 相位从 0 开始

  it('只给度 ≥3 且不是环岛的节点设灯', () => {
    expect(S.has('x')).toBe(true) // 十字路口
    expect(S.has('t')).toBe(true) // 丁字路口
    expect(S.has('mid')).toBe(false) // 度 2 不是路口
    expect(S.has('rb')).toBe(false) // 环岛让行
  })

  it('东西两条路同轴，南北两条路同轴', () => {
    const ax = S.nodes.x.axisOf // 十字路口的分轴
    expect(ax[0]).toBe(ax[1]) // 东西同轴
    expect(ax[2]).toBe(ax[3]) // 南北同轴
    expect(ax[0]).not.toBe(ax[2]) // 两轴不同
  })

  it('state: 有灯的路口按轴返回，没灯的路口常绿', () => {
    expect(S.state('x', 0)).toBe('G') // t=0，0 轴绿
    expect(S.state('x', 2)).toBe('R') // 南北红
    expect(S.state('mid', 7)).toBe('G') // 没灯的路口常绿
  })

  it('update 推进相位，灯会变', () => {
    const S2 = new Signals(scene, rand0) // 新的一组灯
    S2.update(GREEN + 1) // 走过绿灯
    expect(S2.state('x', 0)).toBe('Y') // 变黄
    S2.update(YELLOW + 2) // 再走过黄灯和全红
    expect(S2.state('x', 0)).toBe('R') // 东西红
    expect(S2.state('x', 2)).toBe('G') // 南北绿
  })
})

describe('行人过街', () => {
  it('横跨东路的斑马线: 东西轴绿灯时不能走，南北轴绿灯刚开始时能走，窗口过了不能走', () => {
    const S = new Signals(scene, rand0) // 相位从 0 开始
    expect(S.canWalk(0)).toBe(false) // t=0 东西绿
    S.update(CYCLE / 2 + 1) // 南北绿刚开始
    expect(S.canWalk(0)).toBe(true) // 南北绿灯刚开始: 能走
    S.update(WALK_WINDOW) // 起步窗口过了
    expect(S.canWalk(0)).toBe(false) // 窗口过了: 不能走
  })

  it('路段中途的斑马线永远可以走', () => {
    const S = new Signals(scene, rand0) // 相位从 0 开始
    expect(S.canWalk(2)).toBe(true) // 第 3 条斑马线在路段中途
  })
})

describe('attachSites', () => {
  it('每个进口道一根杆、一个灯头、一条停车线，共 4 个网格', () => {
    const S = new Signals(scene, rand0) // 相位从 0 开始
    const sites = [0, 1, 2, 3].map((edge) => ({ node: 'x', edge, post: [5, 5], dx: 1, dy: 0, stopLine: { center: [3, 0], length: 7 } })) // 十字路口四个进口道
    S.attachSites(sites, 0.18) // 建灯具
    expect(S.group.children.length).toBe(4) // 杆、灯箱、灯头、停车线
    expect(S.lampMesh.count).toBe(4) // 每个进口道一个灯头
    // 推进后灯头颜色被写过（last 从 null 变成状态）
    S.update(0.1) // 推进一下，写入颜色
    expect(S.lamps.every((l) => l.last !== null)).toBe(true) // 每个灯头都写过颜色
    S.dispose() // 释放
  })
})

describe('场景编辑器的路口设置', () => {
  // 在同一个十字路口上加设置: 东西向绿灯 40 秒、南北向 10 秒；T 形路口设成无灯
  const edited = () => ({ // 改过设置的路网
    ...scene,
    roadGraph: { ...scene.roadGraph, nodes: { ...scene.roadGraph.nodes, x: { degree: 4, signal: { green: [40, 10] } }, t: { degree: 3, control: 'none' } } },
  })

  it('makeTiming: 周期 = 两轴绿灯 + 两次（黄 + 全红）；非法值回默认，最短 5 秒', () => {
    expect(makeTiming([40, 10])).toEqual({ green: [40, 10], start1: 45, cycle: 60 }) // 40 + 10 + 2 × 5
    expect(makeTiming().cycle).toBe(CYCLE) // 默认两轴各 22 秒，和原来一样
    expect(makeTiming([1, 'x']).green).toEqual([5, GREEN]) // 太短截到 5 秒，不是数字回默认
  })

  it('phaseOf 带配时: 各轴按自己的绿灯时长变色，两个轴永远不会同时绿', () => {
    const tm = makeTiming([40, 10]) // 东西 40 秒、南北 10 秒
    expect(phaseOf(39, 0, tm)).toBe('G') // 0 轴绿 40 秒
    expect(phaseOf(41, 0, tm)).toBe('Y') // 40 秒后变黄
    expect(phaseOf(46, 1, tm)).toBe('G') // 1 轴从第 45 秒开始绿
    expect(phaseOf(56, 1, tm)).toBe('Y') // 绿 10 秒后变黄
    for (let t = 0; t < tm.cycle; t += 0.5) expect(phaseOf(t, 0, tm) === 'G' && phaseOf(t, 1, tm) === 'G').toBe(false) // 逐个时刻检查不会同时绿
  })

  it('东西 / 南北按方向分配，和轴的编号无关；control = none 的路口不设灯', () => {
    const S = new Signals(edited(), rand0) // 带设置的路网
    expect(S.has('t')).toBe(false) // 无灯
    const ewAxis = S.nodes.x.axisOf[0] // 东路所在的轴
    expect(S.nodes.x.timing.green[ewAxis]).toBe(40) // 东西向 40 秒
    expect(S.nodes.x.timing.green[1 - ewAxis]).toBe(10) // 南北向 10 秒
    expect(S.state('x', 0)).toBe('G') // t = 0: 东西绿
    S.update(41) // 东西变黄
    expect(S.state('x', 0)).toBe('Y') // 东西变黄
    S.update(5) // t = 46: 南北绿
    expect(S.state('x', 2)).toBe('G') // 南北绿
  })

  it('行人起步窗口按对向轴的绿灯时长算（绿灯 - 9 秒，至少 4 秒）', () => {
    const S = new Signals(edited(), rand0) // 带设置的路网
    S.update(46) // 南北绿灯刚开始 1 秒: 横跨东路的斑马线能走
    expect(S.canWalk(0)).toBe(true) // 窗口内
    S.update(4) // 南北绿 10 秒，窗口只有 4 秒: 已经过了
    expect(S.canWalk(0)).toBe(false) // 窗口外
  })
})
