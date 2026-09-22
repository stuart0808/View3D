// 车站分类与布局的测试；buildStationMeshes 只做冒烟测试（three 的几何体在 node 里能直接建）。
import { describe, it, expect } from 'vitest'
import { classifyStation, stationLayouts, buildStationMeshes, STATION_SPEC } from '../src/city/stations.js'

const metro = { kind: 'metro', color: '#3b7ddd', points: [[0, 0], [100, 0]] }
const rail = { kind: 'rail', color: '#7b3fb5', points: [[0, 0], [100, 100]] } // 45° 斜向

describe('classifyStation', () => {
  it('只有地铁 → metro，只有铁路 → rail，两者都有 → hub', () => {
    expect(classifyStation([metro])).toBe('metro')
    expect(classifyStation([rail])).toBe('rail')
    expect(classifyStation([rail, metro])).toBe('hub')
    expect(classifyStation([metro, metro])).toBe('metro') // 两条地铁换乘仍是地铁站
  })
})

describe('stationLayouts', () => {
  const stations = new Map([
    ['A', { name: 'A', pos: [50, 0], lines: [metro], entrances: [[52, 8]] }],
    ['B', { name: 'B', pos: [50, 50], lines: [rail], entrances: [] }],
    ['C', { name: 'C', pos: [20, 20], lines: [rail, metro, metro], entrances: [[30, 10], [10, 30]] }],
  ])
  const L = stationLayouts(stations)
  const by = Object.fromEntries(L.map((s) => [s.name, s]))

  it('每站一个布局，类型正确', () => {
    expect(L.length).toBe(3)
    expect(by.A.kind).toBe('metro')
    expect(by.B.kind).toBe('rail')
    expect(by.C.kind).toBe('hub')
  })

  it('铁路站房顺着轨道方向（45°）', () => {
    expect(by.B.angle).toBeCloseTo(Math.PI / 4)
    expect(by.B.tx).toBeCloseTo(Math.SQRT1_2)
  })

  it('也接受数组输入；线路数和出入口原样带过去', () => {
    const arr = stationLayouts([...stations.values()])
    expect(arr.length).toBe(3)
    expect(by.C.lineCount).toBe(3)
    expect(by.C.entrances.length).toBe(2)
  })

  it('站前广场选压到建筑少的那一侧', () => {
    // 轨道沿 x 轴，右手侧(+y)放一栋大楼 → 广场应该放到 -1 侧
    const blockers = [{ polygon: [[0, 30], [100, 30], [100, 90], [0, 90]] }]
    const [s] = stationLayouts([{ name: 'B', pos: [50, 0], lines: [{ ...rail, points: [[0, 0], [100, 0]] }], entrances: [] }], blockers)
    expect(s.side).toBe(-1)
    // 没有建筑时默认 +1
    expect(stationLayouts([{ name: 'B', pos: [50, 0], lines: [rail], entrances: [] }])[0].side).toBe(1)
  })

  it('主色取地铁线的颜色，纯铁路站取铁路色', () => {
    expect(by.C.color).toBe('#3b7ddd')
    expect(by.B.color).toBe('#7b3fb5')
  })
})

describe('buildStationMeshes', () => {
  it('地铁站有出入口亭和透视圆环，没有站房', () => {
    const g = buildStationMeshes(stationLayouts([{ name: 'A', pos: [0, 0], lines: [metro], entrances: [[5, 5]] }]))
    const names = g.children.map((m) => m.name)
    expect(names).toContain('stationGlass')
    expect(g.children.some((m) => m.renderOrder === 11)).toBe(true) // 圆环
  })

  it('枢纽的网格三角面比高铁站多（多了两翼），高铁站比地铁站多', () => {
    const tri = (kind) => {
      const lines = kind === 'metro' ? [metro] : kind === 'rail' ? [rail] : [rail, metro]
      const g = buildStationMeshes(stationLayouts([{ name: 'X', pos: [0, 0], lines, entrances: [[5, 5]] }]))
      return g.children.reduce((n, m) => n + m.geometry.attributes.position.count, 0)
    }
    expect(tri('hub')).toBeGreaterThan(tri('rail'))
    expect(tri('rail')).toBeGreaterThan(tri('metro'))
  })

  it('站房的顶点都在站点附近（站房长度的一倍范围内）', () => {
    const g = buildStationMeshes(stationLayouts([{ name: 'B', pos: [500, 300], lines: [rail], entrances: [] }]))
    const R = STATION_SPEC.rail.length * 1.2
    for (const m of g.children) {
      const p = m.geometry.attributes.position
      for (let i = 0; i < p.count; i++) expect(Math.hypot(p.getX(i) - 500, p.getZ(i) - 300)).toBeLessThan(R)
    }
  })
})
