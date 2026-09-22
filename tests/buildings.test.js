// 程序化建筑的测试。导航网格用假对象（到处都是人行道 → 商铺每面都临街），
// 验证: 各类楼都能建出网格、每个顶点 / 实例带建筑编号、楼高按层数 × 层高、原型确定性、隐藏补丁。
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildBuildings, hideable, hiddenBuilding, FLOOR_H } from '../src/city/buildings.js'
import { makeRandom } from '../src/city/geometry.js'

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
const ellipse = (cx, cy, rx, ry, n = 24) => Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((i / n) * Math.PI * 2), cy + ry * Math.sin((i / n) * Math.PI * 2)])
const nav = { contains: () => true, isWalkable: () => true }
const style = { roof: '#d6d3cc' }
const scene = () => ({
  angle: 0,
  buildings: [
    { id: 'R', kind: 'residential', floors: 11, polygon: rect(0, 0, 40, 14), holes: [] },
    { id: 'O', kind: 'block', floors: 8, polygon: rect(60, 0, 30, 30), holes: [] },
    { id: 'M', kind: 'shop', floors: 3, polygon: rect(0, 40, 70, 50), holes: [] }, // 3500㎡ → 商场
    { id: 'S', kind: 'shop', floors: 2, polygon: rect(100, 40, 20, 12), holes: [] }, // 小商铺
    { id: 'V', kind: 'venue', venue: { type: 'stadium' }, polygon: ellipse(200, 100, 90, 70), holes: [] },
    { id: 'T', kind: 'venue', venue: { type: 'opera' }, polygon: ellipse(400, 100, 50, 35), holes: [] },
  ],
})
const build = (seed = 1) => buildBuildings(scene(), nav, makeRandom(seed), style)
const child = (g, name) => g.group.children.find((m) => m.name === name)

describe('buildBuildings', () => {
  it('墙体 / 幕墙 / 屋面 / 草坪 / 三种实例网格都建出来了，屋顶热力层非空', () => {
    const g = build()
    for (const n of ['walls', 'curtainWalls', 'roofs', 'pitch', 'glass', 'signs', 'details']) expect(child(g, n), n).toBeTruthy()
    expect(g.heatGeometry).toBeTruthy()
    expect(g.heatGeometry.attributes.position.count).toBeGreaterThan(0)
    expect(child(g, 'signs').count).toBeGreaterThan(0) // 商铺有招牌
  })

  it('每个顶点和每个实例都带建筑编号，编号落在 0..n-1', () => {
    const g = build()
    for (const m of g.group.children) {
      const bid = m.geometry.attributes.bid
      expect(bid, m.name).toBeTruthy()
      const n = m.isInstancedMesh ? m.count : bid.count
      for (let i = 0; i < n; i++) { expect(bid.array[i]).toBeGreaterThanOrEqual(0); expect(bid.array[i]).toBeLessThan(6) }
    }
  })

  it('墙体最高点 ≈ 最高楼（住宅 11 层）加女儿墙 / 楼梯间；草坪只属于体育场', () => {
    const g = build()
    const walls = child(g, 'walls')
    walls.geometry.computeBoundingBox()
    const hRes = 11 * FLOOR_H.residential
    expect(walls.geometry.boundingBox.max.y).toBeGreaterThanOrEqual(hRes)
    expect(walls.geometry.boundingBox.max.y).toBeLessThan(hRes + 4) // 体育场 25m 罩棚也没超过
    const pitch = child(g, 'pitch')
    for (let i = 0; i < pitch.geometry.attributes.bid.count; i++) expect(pitch.geometry.attributes.bid.array[i]).toBe(4)
  })

  it('同样的场景 + 随机种子 → 完全一样的构件数（确定性）', () => {
    const a = build(3), b = build(3)
    for (const n of ['glass', 'signs', 'details']) expect(child(a, n).count).toBe(child(b, n).count)
    expect(child(a, 'walls').geometry.attributes.position.count).toBe(child(b, 'walls').geometry.attributes.position.count)
  })

  it('小商铺每个开间有遮阳篷（带俯仰的细部）；商场没有', () => {
    const g = build()
    const det = child(g, 'details'), bid = det.geometry.attributes.bid.array
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3()
    const tilted = { 2: 0, 3: 0 }
    for (let i = 0; i < det.count; i++) {
      if (!(bid[i] in tilted)) continue
      det.getMatrixAt(i, m)
      m.decompose(p, q, s)
      // 绕 Y 以外的轴有转动 → 盒子是斜的
      if (Math.abs(q.x) > 1e-3 || Math.abs(q.z) > 1e-3) tilted[bid[i]]++
    }
    expect(tilted[3]).toBeGreaterThan(0)
    expect(tilted[2]).toBe(0)
  })
})

describe('hideable', () => {
  it('把 bid 属性和 hiddenBid uniform 注进顶点着色器，uniform 就是共享的 hiddenBuilding', () => {
    const mat = hideable(new THREE.MeshStandardMaterial())
    const shader = { uniforms: {}, vertexShader: 'void main() {\n#include <project_vertex>\n}' }
    mat.onBeforeCompile(shader)
    expect(shader.uniforms.hiddenBid).toBe(hiddenBuilding)
    expect(shader.vertexShader).toContain('attribute float bid')
    expect(shader.vertexShader).toContain('abs(bid - hiddenBid) < 0.5')
  })
})
