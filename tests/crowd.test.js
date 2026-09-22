// 人群仿真的测试。用导航网格的测试入口造一个小场景: 一条街、两栋带门的楼、两个出入口，
// 没有需求模型（走「随机逛店」的老逻辑），验证生成 → 走路 → 进楼 → 出楼 → 离场的闭环和人数守恒。
import { describe, it, expect } from 'vitest'
import { NavGrid, SURFACE } from '../src/city/navgrid.js'
import { Crowd } from '../src/city/crowd.js'
import { makeRandom } from '../src/city/geometry.js'

const COLS = 80, ROWS = 40
/** 全铺装的 80x40 网格，两栋楼: A 在 (10..25, 10..20)，B 在 (50..65, 10..20)（格坐标，格中心 = 格号 - 3.5） */
function scene() {
  const surface = new Uint8Array(COLS * ROWS).fill(SURFACE.PAVE)
  const block = (i0, j0, i1, j1) => { for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) surface[j * COLS + i] = SURFACE.BUILDING }
  block(10, 10, 25, 20)
  block(50, 10, 65, 20)
  const g = (i, j) => [i - 3.5, j - 3.5] // 格 → 米
  const poly = (i0, j0, i1, j1) => [g(i0, j0), g(i1 + 1, j0), g(i1 + 1, j1 + 1), g(i0, j1 + 1)]
  const sc = {
    bounds: { minX: 0, minY: 0, maxX: COLS - 8, maxY: ROWS - 8 },
    buildings: [
      { id: 'A', kind: 'shop', floors: 2, polygon: poly(10, 10, 25, 20), holes: [] },
      { id: 'B', kind: 'shop', floors: 2, polygon: poly(50, 10, 65, 20), holes: [] },
    ],
    // 门在南墙中点，法线朝南（+y）
    doors: [{ building: 'A', pos: g(18, 21), normal: [0, 1] }, { building: 'B', pos: g(58, 21), normal: [0, 1] }],
    portals: [{ pos: g(4, 30), weight: 1 }, { pos: g(75, 30), weight: 1 }],
    areas: [],
    crosswalks: [],
  }
  const nav = new NavGrid(sc, { cell: 1, surface, cols: COLS, rows: ROWS })
  return { sc, nav }
}
const warm = (c) => { let n = 0; while (!c.ready && n++ < 500) c.update(0.1) }

describe('构建', () => {
  it('目的地 = 2 栋楼 + 2 个出入口；每栋楼的门落到了人行道上', () => {
    const { sc, nav } = scene()
    const c = new Crowd(sc, nav, makeRandom(1), { capacity: 200 })
    expect(c.dests.filter((d) => d.type === 'door').length).toBe(2)
    expect(c.portals.length).toBe(2)
    for (const d of c.dests) if (d.type === 'door') expect(nav.walkable[d.cells[0]]).toBe(1)
  })

  it('预热分帧算距离场，算完后 ready 且已按目标人数铺了人', () => {
    const { sc, nav } = scene()
    const c = new Crowd(sc, nav, makeRandom(1), { capacity: 200 })
    c.population = 50
    expect(c.ready).toBe(false)
    warm(c)
    expect(c.ready).toBe(true)
    expect(c.active).toBeGreaterThan(30)
    expect(c.active).toBeLessThanOrEqual(50)
  })
})

describe('运行', () => {
  it('人数向目标靠拢，且 active = 街上 + 楼内', () => {
    const { sc, nav } = scene()
    const c = new Crowd(sc, nav, makeRandom(2), { capacity: 300 })
    c.population = 120
    warm(c)
    for (let i = 0; i < 600; i++) c.update(0.5, false)
    const st = c.stats()
    expect(Math.abs(c.active - 120)).toBeLessThan(15)
    expect(st.walking + st.inside).toBe(st.active)
    // 有人进了楼
    expect(st.inside).toBeGreaterThan(0)
    expect(st.perBuilding.A + st.perBuilding.B).toBe(st.inside)
  })

  it('目标降为 0 后人陆续离场，楼内计数最终归零', () => {
    const { sc, nav } = scene()
    const c = new Crowd(sc, nav, makeRandom(3), { capacity: 300 })
    c.population = 60
    c.dwellScale = 0.01 // 店里只待几秒，加快测试
    warm(c)
    c.population = 0
    for (let i = 0; i < 4000 && c.active > 0; i++) c.update(0.5, false)
    expect(c.active).toBe(0)
    expect(c.insideCount).toBe(0)
    for (const b of c.buildings.values()) expect(b.visitors).toBe(0)
  })

  it('人都在可走的格子上', () => {
    const { sc, nav } = scene()
    const c = new Crowd(sc, nav, makeRandom(4), { capacity: 300 })
    c.population = 100
    warm(c)
    for (let i = 0; i < 300; i++) c.update(0.5, false)
    for (let i = 0; i < c.high; i++) {
      if (c.state[i] === 0 || c.state[i] === 3) continue // FREE / INSIDE
      expect(nav.isWalkable(c.x[i], c.y[i]) || nav.nearestWalkable(c.x[i], c.y[i], 1.5) >= 0).toBe(true)
    }
  })

  it('reseed 清空后按目标重铺；setAttraction 改变楼的权重', () => {
    const { sc, nav } = scene()
    const c = new Crowd(sc, nav, makeRandom(5), { capacity: 300 })
    c.population = 40
    warm(c)
    c.population = 80
    c.reseed()
    expect(c.active).toBeGreaterThan(50)
    const wA = c.dests.find((d) => d.building === 'A').weight
    c.setAttraction({ A: 5 })
    expect(c.dests.find((d) => d.building === 'A').weight).toBeCloseTo(wA * 5)
  })

  it('列车到站排队: 之后补的人优先从该站出入口进来', () => {
    const { sc, nav } = scene()
    sc.portals[0].station = 'S'
    const c = new Crowd(sc, nav, makeRandom(6), { capacity: 300 })
    c.population = 0
    warm(c)
    c.arrive('S', 10)
    c.population = 10
    for (let i = 0; i < 40; i++) c.update(0.5, false)
    const s0 = c.dests[c.portals[0]]
    // 新进来的人应该都在 S 站附近（10m 内）
    let near = 0, total = 0
    for (let i = 0; i < c.high; i++) if (c.state[i] !== 0) { total++; if (Math.hypot(c.x[i] - s0.x, c.y[i] - s0.y) < 45) near++ } // 20 秒里最多走 30m
    expect(total).toBeGreaterThan(0)
    expect(near / total).toBeGreaterThan(0.7)
  })
})
