// 红绿灯的测试: 相位函数、进口道分轴、行人起步窗口、灯头网格的生成。
import { describe, it, expect } from 'vitest'
import { Signals, phaseOf, armAngle, GREEN, YELLOW, CYCLE, WALK_WINDOW } from '../src/city/signals.js'

// 一个十字路口 X（节点 'x'），四条路: 东 e、西 w、北 n、南 s；再加一个 T 形路口和一个只有两条路的「节点」
const scene = {
  roadGraph: {
    nodes: { x: { degree: 4 }, t: { degree: 3 }, mid: { degree: 2 }, rb: { degree: 3, roundabout: true } },
    edges: [
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
  crosswalks: [
    { node: 'x', edge: 0, center: [8, 0], dir: [1, 0], span: 8, depth: 3 }, // 横跨东路
    { node: 'x', edge: 2, center: [0, -8], dir: [0, -1], span: 8, depth: 3 }, // 横跨北路
    { center: [30, 0], dir: [1, 0], span: 8, depth: 3 }, // 路段中途，没灯
  ],
}
const rand0 = () => 0 // 相位从 0 开始，方便断言

describe('phaseOf', () => {
  it('0 轴: 绿 → 黄 → 红，1 轴错开半个周期', () => {
    expect(phaseOf(0, 0)).toBe('G')
    expect(phaseOf(GREEN + 1, 0)).toBe('Y')
    expect(phaseOf(GREEN + YELLOW + 1, 0)).toBe('R')
    expect(phaseOf(0, 1)).toBe('R')
    expect(phaseOf(CYCLE / 2, 1)).toBe('G')
  })

  it('两轴永远不同时绿', () => {
    for (let t = 0; t < CYCLE; t += 0.5) expect(phaseOf(t, 0) === 'G' && phaseOf(t, 1) === 'G').toBe(false)
  })
})

describe('armAngle', () => {
  it('从路口向外的方向角；reversed 时从末端起算', () => {
    expect(armAngle([[0, 0], [50, 0]], false)).toBeCloseTo(0)
    expect(armAngle([[-50, 0], [0, 0]], true)).toBeCloseTo(Math.PI) // 路口在末端，向外指向 -x
    expect(armAngle([[0, 0], [0, -50]], false)).toBeCloseTo(-Math.PI / 2)
  })
})

describe('Signals 路口与分轴', () => {
  const S = new Signals(scene, rand0)

  it('只给度 ≥3 且不是环岛的节点设灯', () => {
    expect(S.has('x')).toBe(true)
    expect(S.has('t')).toBe(true)
    expect(S.has('mid')).toBe(false)
    expect(S.has('rb')).toBe(false)
  })

  it('东西两条路同轴，南北两条路同轴', () => {
    const ax = S.nodes.x.axisOf
    expect(ax[0]).toBe(ax[1])
    expect(ax[2]).toBe(ax[3])
    expect(ax[0]).not.toBe(ax[2])
  })

  it('state: 有灯的路口按轴返回，没灯的路口常绿', () => {
    expect(S.state('x', 0)).toBe('G') // t=0，0 轴绿
    expect(S.state('x', 2)).toBe('R')
    expect(S.state('mid', 7)).toBe('G')
  })

  it('update 推进相位，灯会变', () => {
    const S2 = new Signals(scene, rand0)
    S2.update(GREEN + 1)
    expect(S2.state('x', 0)).toBe('Y')
    S2.update(YELLOW + 2)
    expect(S2.state('x', 0)).toBe('R')
    expect(S2.state('x', 2)).toBe('G')
  })
})

describe('行人过街', () => {
  it('横跨东路的斑马线: 东西轴绿灯时不能走，南北轴绿灯刚开始时能走，窗口过了不能走', () => {
    const S = new Signals(scene, rand0)
    expect(S.canWalk(0)).toBe(false) // t=0 东西绿
    S.update(CYCLE / 2 + 1) // 南北绿刚开始
    expect(S.canWalk(0)).toBe(true)
    S.update(WALK_WINDOW) // 起步窗口过了
    expect(S.canWalk(0)).toBe(false)
  })

  it('路段中途的斑马线永远可以走', () => {
    const S = new Signals(scene, rand0)
    expect(S.canWalk(2)).toBe(true)
  })
})

describe('attachSites', () => {
  it('每个进口道一根杆、一个灯头、一条停车线，共 4 个网格', () => {
    const S = new Signals(scene, rand0)
    const sites = [0, 1, 2, 3].map((edge) => ({ node: 'x', edge, post: [5, 5], dx: 1, dy: 0, stopLine: { center: [3, 0], length: 7 } }))
    S.attachSites(sites, 0.18)
    expect(S.group.children.length).toBe(4)
    expect(S.lampMesh.count).toBe(4)
    // 推进后灯头颜色被写过（last 从 null 变成状态）
    S.update(0.1)
    expect(S.lamps.every((l) => l.last !== null)).toBe(true)
    S.dispose()
  })
})
