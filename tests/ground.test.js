// 地面层的测试: 底座 / 路面 / 铺装 / 区域 / 标线 / 高架 / 背景楼块都能从 scene.json 的多边形建出来，
// 标线数量和车道数、斑马线跨度对得上，高架桥墩按 28m 间距、护栏在匝道口留缺口。在 node 里跑（贴图返回 null）。
import { describe, it, expect } from 'vitest'
import { buildGround, buildElevated, buildBackdrop, CURB_H } from '../src/city/ground.js'
import { ELEVATED_H } from '../src/city/roads.js'
import { makeRandom } from '../src/city/geometry.js'

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
const style = { slab: '#eee', road: '#555', pavement: '#ddd', grass: '#7a4', park: '#8b5', plaza: '#ccc', water: '#48c', parking: '#666', marking: '#fff', centerLine: '#fc0', underDeck: '#999', background: '#f4f2ee', backdrop: '#cfd3d8' }
const scene = () => ({
  angle: 0,
  bounds: { minX: 0, minY: 0, maxX: 300, maxY: 200 },
  site: [{ polygon: rect(0, 0, 300, 200), holes: [] }],
  pavement: [{ polygon: rect(0, 20, 300, 60), holes: [] }, { polygon: rect(0, 120, 300, 80), holes: [] }],
  areas: [{ kind: 'park', polygon: rect(10, 130, 60, 50), holes: [] }, { kind: 'water', polygon: rect(20, 140, 20, 20), holes: [] }, { kind: 'plaza', polygon: rect(200, 30, 40, 40), holes: [] }],
  lanes: [
    { width: 14.6, points: [[0, 100], [300, 100]] }, // 双向四车道: 双黄线 + 每侧一条白虚线
    { width: 7.3, points: [[150, 0], [150, 200]] }, // 双向两车道: 黄虚线
  ],
  crosswalks: [{ center: [150, 100], dir: [0, 1], span: 12, depth: 3 }],
  elevated: [],
})
const named = (g, name) => { let m = null; g.traverse((o) => { if (o.name === name) m = o }); return m }
const bbox = (mesh) => { mesh.geometry.computeBoundingBox(); return mesh.geometry.boundingBox }

describe('buildGround', () => {
  it('底座、路面、铺装、区域、标线、高架都挂在组里；铺装顶面 = CURB_H', () => {
    const g = buildGround(scene(), style)
    expect(g.name).toBe('ground')
    for (const n of ['areas', 'markings', 'elevated']) expect(named(g, n), n).toBeTruthy()
    // 前三个 Mesh: 底座、路面、铺装
    const meshes = g.children.filter((o) => o.isMesh)
    expect(meshes.length).toBeGreaterThanOrEqual(3)
    expect(bbox(meshes[0]).min.y).toBeCloseTo(-1.62)
    expect(bbox(meshes[1]).max.y).toBeCloseTo(0)
    expect(bbox(meshes[2]).max.y).toBeCloseTo(CURB_H)
  })

  it('区域按类型各一个网格: 公园抬高、水面贴在路面标高', () => {
    const areas = named(buildGround(scene(), style), 'areas')
    const park = areas.children.find((m) => m.name === 'park'), water = areas.children.find((m) => m.name === 'water')
    expect(park && water && areas.children.find((m) => m.name === 'plaza')).toBeTruthy()
    expect(bbox(park).max.y).toBeCloseTo(0.24)
    expect(bbox(water).max.y).toBeCloseTo(0.05)
    expect(areas.children.find((m) => m.name === 'green')).toBeUndefined()
  })

  it('标线数: 四车道路 2 条黄实线 + 2 条白虚线，两车道路 1 条黄虚线，斑马线 9 条，停车位线逐条加', () => {
    const count = (sc, pl = []) => named(buildGround(sc, style, pl), 'markings').children[0].count
    const base = count(scene())
    // 300m 双黄实线 2 条；300m 白虚线 2 条 × 40 段 (3+4.5 → 300/7.5 = 40)；200m 黄虚线 27 段 (200/7.5 → 26 完整 + 1)；斑马线 floor((12-1.2)/1.1) = 9
    expect(base).toBe(2 + 80 + 27 + 9)
    expect(count(scene(), [{ pos: [5, 5], angle: 0, length: 5, width: 0.12 }, { pos: [8, 5], angle: 0, length: 5, width: 0.12 }])).toBe(base + 2)
  })

  it('≥3 车道的路不画中心线，改建实体中央隔离带；桥下带 median 的路建桥下隔离带', () => {
    const sc = scene()
    sc.lanes = [{ width: 22, points: [[0, 100], [300, 100]] }]
    const mk = named(buildGround(sc, style), 'markings')
    expect(mk.children.length).toBe(2) // 标线 + 隔离带
    expect(bbox(mk.children[1]).max.y).toBeCloseTo(0.45)
    sc.lanes = [{ width: 22, median: 3, points: [[0, 100], [300, 100]] }]
    const mk2 = named(buildGround(sc, style), 'markings')
    expect(mk2.children.length).toBe(2)
    expect(bbox(mk2.children[1]).max.z - bbox(mk2.children[1]).min.z).toBeCloseTo(6) // 宽 = median × 2
  })
})

describe('buildElevated', () => {
  const sc = () => ({ elevated: [{ polygon: rect(0, 90, 300, 20), holes: [] }], lanes: [{ width: 14.6, level: 1, points: [[0, 100], [300, 100]] }] })

  it('桥面顶面 = ELEVATED_H，桥墩 11 根（14 + 28k < 300），护栏在匝道口留缺口', () => {
    const g = buildElevated(sc(), style)
    const [deck, rails, piers] = g.children
    expect(bbox(deck).max.y).toBeCloseTo(ELEVATED_H)
    expect(piers.geometry.attributes.position.count).toBe(11 * 36) // 每根盒子 36 个顶点（非索引）
    const full = rails.geometry.attributes.position.count
    const gapped = buildElevated(sc(), style, [[[100, 90], [130, 90]]]).children[1].geometry.attributes.position.count
    expect(gapped).toBeLessThan(full)
    expect(full - gapped).toBeLessThanOrEqual(13 * 36) // 缺口 30m + 两侧 3.4m 容差 → 最多 13 段
  })

  it('没有高架时返回空组', () => {
    expect(buildElevated({ elevated: [], lanes: [] }, style).children.length).toBe(0)
  })
})

describe('buildBackdrop', () => {
  it('楼块都在场景范围之外，且沿街区方向旋转后仍在 3.4 倍半径内', () => {
    const sc = scene()
    sc.angle = 0.3
    const m = buildBackdrop(sc, style, makeRandom(4))
    expect(m.name).toBe('backdrop')
    const pos = m.geometry.attributes.position
    expect(pos.count).toBeGreaterThan(0)
    const R = Math.hypot(300, 200) / 2
    let inside = 0
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - 150, dz = pos.getZ(i) - 100
      // 转回街区坐标系
      const lx = dx * Math.cos(0.3) + dz * Math.sin(0.3), ly = -dx * Math.sin(0.3) + dz * Math.cos(0.3)
      if (Math.abs(lx) < R * 0.6 && Math.abs(ly) < R * 0.6) inside++
      expect(Math.hypot(dx, dz)).toBeLessThan(R * 3.4 + 250)
    }
    expect(inside).toBe(0)
  })
})
