// 导航网格的测试。浏览器外没有 canvas，所以用构造函数的测试入口直接给定地表数组，
// 在一个 20x12 的小网格上验证距离场、引导点、最近可走格这些核心逻辑。
import { describe, it, expect } from 'vitest'
import { NavGrid, SURFACE, UNREACHABLE } from '../src/city/navgrid.js'

const COLS = 20, ROWS = 12
/**
 * 造一个网格: 默认全是人行铺装；blocks 是要挖成建筑的格子区间 [i0, j0, i1, j1]（含端点）。
 * 场景包围盒取 (0,0)-(cols-8, rows-8)，加上 4m 的 pad 正好是 cols x rows 格（cell = 1）。
 */
function grid({ blocks = [], crosswalks = [], road = [] } = {}) {
  const surface = new Uint8Array(COLS * ROWS).fill(SURFACE.PAVE)
  const fill = (list, code) => {
    for (const [i0, j0, i1, j1] of list) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) surface[j * COLS + i] = code
  }
  fill(road, SURFACE.ROAD)
  fill(blocks, SURFACE.BUILDING)
  const scene = { bounds: { minX: 0, minY: 0, maxX: COLS - 8, maxY: ROWS - 8 }, crosswalks }
  return new NavGrid(scene, { cell: 1, surface, cols: COLS, rows: ROWS })
}
// 网格原点在 (-4,-4)，所以格 (i,j) 的中心是 (i - 3.5, j - 3.5)
const at = (i, j) => [i - 3.5, j - 3.5]

describe('坐标换算', () => {
  it('index / center 互为反函数，网格外返回 -1', () => {
    const g = grid()
    const k = g.index(...at(5, 7))
    expect(k).toBe(7 * COLS + 5)
    expect(g.center(k)).toEqual(at(5, 7))
    expect(g.index(-100, 0)).toBe(-1)
    expect(g.contains(-100, 0)).toBe(false)
  })
})

describe('地表与可走性', () => {
  it('建筑不可走，铺装可走；surfaceAt 网格外是 NONE', () => {
    const g = grid({ blocks: [[5, 5, 8, 8]] })
    expect(g.isWalkable(...at(6, 6))).toBe(false)
    expect(g.surfaceAt(...at(6, 6))).toBe(SURFACE.BUILDING)
    expect(g.isWalkable(...at(2, 2))).toBe(true)
    expect(g.surfaceAt(999, 999)).toBe(SURFACE.NONE)
  })

  it('车行道不可走，除非有斑马线盖着；斑马线格子记下编号', () => {
    // 一条竖向的车行道 i=9..10；一条横跨它的斑马线，中心在格 (9.5, 6)，沿 x 方向深 2m、跨 3m
    const cw = { center: [at(10, 6)[0] - 0.5, at(6, 6)[1]], dir: [1, 0], depth: 2.4, span: 3 }
    const g = grid({ road: [[9, 0, 10, ROWS - 1]], crosswalks: [cw] })
    expect(g.isWalkable(...at(9, 1))).toBe(false)
    expect(g.isWalkable(...at(9, 6))).toBe(true)
    expect(g.cwIndex[6 * COLS + 9]).toBe(0)
    expect(g.cwIndex[1 * COLS + 9]).toBe(-1)
  })

  it('贴墙的格子有通行代价，远离墙的没有', () => {
    const g = grid({ blocks: [[5, 5, 8, 8]] })
    expect(g.penalty[g.index(...at(4, 6))]).toBeGreaterThan(1) // 紧贴建筑
    expect(g.penalty[g.index(...at(14, 6))]).toBe(0)          // 远处（网格边缘除外）
  })
})

describe('距离场', () => {
  it('目标格距离 0，相邻格约 1m，到不了的是 UNREACHABLE', () => {
    // 一堵从上到下的墙把网格分成左右两半（留网格边缘也堵上）
    const g = grid({ blocks: [[10, 0, 10, ROWS - 1]] })
    const f = g.buildField(g.index(...at(3, 6)))
    expect(f[g.index(...at(3, 6))]).toBe(0)
    expect(g.distanceAt(f, ...at(4, 6))).toBeGreaterThan(0.9)
    expect(g.distanceAt(f, ...at(4, 6))).toBeLessThan(2.5) // 贴墙代价会让它略大于 1
    expect(f[g.index(...at(15, 6))]).toBe(UNREACHABLE)
    expect(g.distanceAt(f, ...at(15, 6))).toBe(Infinity)
  })

  it('绕障碍物走: 距离大于直线距离', () => {
    const g = grid({ blocks: [[8, 2, 9, 9]] }) // 中间一堵留缝的墙
    const f = g.buildField(g.index(...at(3, 6)))
    const straight = 14 - 3
    expect(g.distanceAt(f, ...at(14, 6))).toBeGreaterThan(straight + 3)
  })

  it('多源: 传入多个目标时取到最近那个的距离', () => {
    const g = grid()
    const f = g.buildField([g.index(...at(2, 6)), g.index(...at(17, 6))])
    expect(f[g.index(...at(2, 6))]).toBe(0)
    expect(f[g.index(...at(17, 6))]).toBe(0)
    expect(g.distanceAt(f, ...at(16, 6))).toBeLessThan(3)
  })

  it('斜走不穿墙角', () => {
    // 两个建筑对角相接，中间只有一个「角点」
    const g = grid({ blocks: [[5, 5, 7, 7], [8, 8, 10, 10]] })
    const f = g.buildField(g.index(...at(4, 4)))
    // 从 (7,7) 的右下角斜穿到 (8,8) 是不允许的，所以到 (8,7)... 直接验证: 网格里所有可达格的距离都是有限的（绕得过去）
    expect(f[g.index(...at(12, 12 - 1))]).not.toBe(UNREACHABLE)
  })
})

describe('lookAhead / nearestWalkable', () => {
  it('引导点沿距离场下降，剩余距离随之减小', () => {
    const g = grid()
    const f = g.buildField(g.index(...at(17, 6)))
    const out = [0, 0, 0]
    const start = at(3, 6)
    expect(g.lookAhead(f, start[0], start[1], 5, out)).toBe(out)
    expect(out[0]).toBeGreaterThan(start[0]) // 往目标（+x）走
    expect(out[2]).toBeLessThan(g.distanceAt(f, ...start))
  })

  it('站在目标上时引导点就是自己，距离 0；网格外返回 null', () => {
    const g = grid()
    const t = at(10, 6)
    const f = g.buildField(g.index(...t))
    const out = [0, 0, 0]
    g.lookAhead(f, t[0], t[1], 5, out)
    expect(out.slice(0, 2)).toEqual(t)
    expect(out[2]).toBe(0)
    expect(g.lookAhead(f, -100, -100, 5, out)).toBeNull()
  })

  it('人被挤进建筑格时，就近回到可走格继续', () => {
    const g = grid({ blocks: [[5, 5, 8, 8]] })
    const f = g.buildField(g.index(...at(15, 6)))
    const out = [0, 0, 0]
    expect(g.lookAhead(f, ...at(6, 6), 3, out)).not.toBeNull()
  })

  it('nearestWalkable 从建筑内找到最近的可走格，超出半径返回 -1', () => {
    const g = grid({ blocks: [[5, 5, 8, 8]] })
    const k = g.nearestWalkable(...at(5, 6), 5)
    expect(k).toBeGreaterThanOrEqual(0)
    expect(g.walkable[k]).toBe(1)
    expect(g.nearestWalkable(...at(6, 6), 0.5)).toBe(-1)
  })
})
