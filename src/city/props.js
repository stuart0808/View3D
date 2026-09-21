// 场景「配景」: 树、停车位、停着的车。除了停车场/绿地的范围，其余全部按规则自动生成，不需要标记。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { SURFACE } from './navgrid.js'
import { signedArea, pointInPolygon, interiorPoints, distToPolygonEdge } from './geometry.js'
import { CURB_H } from './ground.js'

const TREE_COLORS = ['#9dbb9a', '#8fb093', '#a8c4a0', '#86a88f', '#b3c9a6']
export const CAR_COLORS = ['#f4f5f6', '#f4f5f6', '#dfe2e6', '#c3c8cf', '#8b929c', '#4b5563', '#2f3640', '#9aa9bd', '#b7a99a', '#a14d4d']

function inArea(x, y, a) {
  return pointInPolygon(x, y, a.polygon) && !(a.holes || []).some((h) => pointInPolygon(x, y, h))
}

// ---------------------------------------------------------------------------
// 树
// ---------------------------------------------------------------------------
function treeGeometry() {
  const trunk = new THREE.CylinderGeometry(0.13, 0.18, 2.0, 6).toNonIndexed()
  trunk.translate(0, 1.0, 0)
  const crown = new THREE.IcosahedronGeometry(1.7, 1)
  crown.scale(1, 0.85, 1)
  crown.translate(0, 3.2, 0)
  const crown2 = new THREE.IcosahedronGeometry(1.1, 1)
  crown2.translate(0.7, 4.2, 0.3)
  const parts = [trunk, crown, crown2]
  parts.forEach((g, i) => {
    const n = g.attributes.position.count
    const col = new Float32Array(n * 3)
    const v = i === 0 ? [0.5, 0.42, 0.36] : i === 1 ? [1, 1, 1] : [1.06, 1.06, 1.04]
    for (let k = 0; k < n; k++) col.set(v, k * 3)
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.deleteAttribute('uv')
  })
  return mergeGeometries(parts)
}

/** 行道树: 沿「人行铺装与车行道的交界」每隔一段种一棵，避开建筑、店门和斑马线 */
function streetTreeSpots(scene, nav, spacing = 9) {
  const spots = []
  const doors = scene.doors || [], crosswalks = scene.crosswalks || []
  const rings = []
  for (const p of scene.pavement || []) { rings.push(p.polygon); for (const h of p.holes || []) rings.push(h) }
  const INSET = 1.5
  for (const ring of rings) {
    let carry = spacing / 2
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (L < 1e-6) continue
      const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L
      let s = carry
      for (; s < L; s += spacing) {
        const px = a[0] + tx * s, py = a[1] + ty * s
        for (const sign of [1, -1]) {
          const nx = -ty * sign, ny = tx * sign
          if (nav.surfaceAt(px + nx * INSET, py + ny * INSET) !== SURFACE.PAVE) continue
          if (nav.surfaceAt(px - nx * INSET, py - ny * INSET) !== SURFACE.ROAD) continue
          const x = px + nx * INSET, y = py + ny * INSET
          let ok = true
          for (let k = 0; k < 8 && ok; k++) {
            const ang = (k / 8) * Math.PI * 2
            const sf = nav.surfaceAt(x + Math.cos(ang) * 2.4, y + Math.sin(ang) * 2.4)
            if (sf === SURFACE.BUILDING) ok = false
          }
          if (ok && doors.some((d) => Math.hypot(d.pos[0] - x, d.pos[1] - y) < 4)) ok = false
          if (ok && crosswalks.some((c) => Math.hypot(c.center[0] - x, c.center[1] - y) < c.span / 2 + 3.5)) ok = false
          if (ok) spots.push([x, y, CURB_H])
          break
        }
      }
      carry = s - L
    }
  }
  return spots
}

/** 绿地/公园里撒树: 随机采样 + 最小间距（泊松盘的穷人版） */
function areaTreeSpots(scene, rand) {
  const spots = []
  for (const a of scene.areas || []) {
    if (a.kind !== 'green' && a.kind !== 'park') continue
    const area = Math.abs(signedArea(a.polygon))
    const minDist = a.kind === 'green' ? 4.2 : 6.5
    const want = Math.min(900, Math.ceil(area / (a.kind === 'green' ? 30 : 75)))
    const placed = []
    for (const p of interiorPoints(a.polygon, a.holes || [], want * 3, rand)) {
      if (placed.length >= want) break
      const edge = Math.min(distToPolygonEdge(p[0], p[1], a.polygon), ...(a.holes || []).map((h) => distToPolygonEdge(p[0], p[1], h)))
      if (edge < 1.3) continue
      if (placed.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < minDist)) continue
      // 水池、建筑可能压在公园上，别种进去
      if ((scene.areas || []).some((w) => w.kind === 'water' && inArea(p[0], p[1], w))) continue
      placed.push(p)
    }
    for (const p of placed) spots.push([p[0], p[1], a.kind === 'green' ? 0.34 : 0.24])
  }
  return spots
}

export function buildTrees(scene, nav, rand) {
  let spots = [...streetTreeSpots(scene, nav), ...areaTreeSpots(scene, rand)]
  const MAX_TREES = 6000 // 城区级场景的绿地很多，超了就均匀抽稀
  if (spots.length > MAX_TREES) { const keep = MAX_TREES / spots.length; spots = spots.filter(() => rand() < keep) }
  const mesh = new THREE.InstancedMesh(treeGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), Math.max(1, spots.length))
  mesh.name = 'trees'
  mesh.count = spots.length
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color()
  spots.forEach(([x, y, h], i) => {
    const s = 0.75 + rand() * 0.55
    q.setFromAxisAngle(up, rand() * Math.PI * 2)
    m.compose(new THREE.Vector3(x, h, y), q, new THREE.Vector3(s, s * (0.9 + rand() * 0.3), s))
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.set(TREE_COLORS[(rand() * TREE_COLORS.length) | 0]))
  })
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  return mesh
}

// ---------------------------------------------------------------------------
// 停车场
// ---------------------------------------------------------------------------
/**
 * 给一块停车场排车位。通道方向从街区主方向的两条轴里挑「指向出入口」的那条，
 * 这样每条通道都通到出入口一侧预留的横向车道上，车能顺着 车位 → 通道 → 横向车道 → 出入口 开出去。
 * entry 为 null（接不上路的停车场）时只排车位，不留车道。
 * 返回 { lines: 车位线, stalls: [{ pos, dir(车头朝向), route(车位 → 出入口内侧的折线) }] }
 */
export function layoutParking(area, sceneAngle, entry) {
  const STALL_W = 2.6, STALL_L = 5.2, AISLE = 6.4, DRIVE = 6.5
  let cx = 0, cy = 0
  for (const p of area.polygon) { cx += p[0]; cy += p[1] }
  cx /= area.polygon.length
  cy /= area.polygon.length
  let ang = sceneAngle
  if (entry) {
    let best = -Infinity
    for (let k = 0; k < 4; k++) {
      const a = sceneAngle + (k * Math.PI) / 2
      const d = Math.cos(a) * (entry[0] - cx) + Math.sin(a) * (entry[1] - cy)
      if (d > best) { best = d; ang = a }
    }
  }
  const ca = Math.cos(ang), sa = Math.sin(ang)
  const toLocal = ([x, y]) => [x * ca + y * sa, -x * sa + y * ca]
  const toWorld = (u, v) => [u * ca - v * sa, u * sa + v * ca]
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
  for (const [u, v] of area.polygon.map(toLocal)) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v) }
  const inside = (u, v) => { const [x, y] = toWorld(u, v); return inArea(x, y, area) }
  const uEnd = maxU - (entry ? DRIVE : 1.0)
  const uDrive = maxU - DRIVE / 2
  const vEntry = entry ? Math.min(maxV - 2, Math.max(minV + 2, toLocal(entry)[1])) : 0

  const lines = [], stalls = []
  const vDir = [-sa, ca] // 局部 +v 在世界里的方向
  const addRow = (v0, vAisle, noseSign) => {
    for (let u = minU + 1.2; u + STALL_W <= uEnd - 0.3; u += STALL_W) {
      const ok = inside(u + 0.2, v0 + 0.2) && inside(u + STALL_W - 0.2, v0 + 0.2) && inside(u + 0.2, v0 + STALL_L - 0.2) && inside(u + STALL_W - 0.2, v0 + STALL_L - 0.2)
      if (!ok) continue
      const uc = u + STALL_W / 2
      stalls.push({
        pos: toWorld(uc, v0 + STALL_L / 2),
        dir: [vDir[0] * noseSign, vDir[1] * noseSign],
        route: entry ? [toWorld(uc, v0 + STALL_L / 2), toWorld(uc, vAisle), toWorld(uDrive, vAisle), toWorld(uDrive, vEntry)] : null,
      })
      for (const uu of [u, u + STALL_W]) lines.push({ pos: toWorld(uu, v0 + STALL_L / 2), angle: ang + Math.PI / 2, length: STALL_L, width: 0.14 })
    }
  }
  for (let v = minV + 1.2; v + STALL_L + AISLE <= maxV - 0.5; v += STALL_L * 2 + AISLE + 0.5) {
    const vAisle = v + STALL_L + AISLE / 2
    addRow(v, vAisle, -1) // 通道下方一排，车头背对通道
    if (v + STALL_L * 2 + AISLE <= maxV - 1.0) addRow(v + STALL_L + AISLE, vAisle, 1)
  }
  return { lines, stalls }
}

export function carGeometry() {
  const body = new THREE.BoxGeometry(4.3, 0.8, 1.78).toNonIndexed()
  body.translate(0, 0.62, 0)
  const cabin = new THREE.BoxGeometry(2.3, 0.62, 1.58).toNonIndexed()
  cabin.translate(-0.25, 1.3, 0)
  ;[body, cabin].forEach((g, i) => {
    const n = g.attributes.position.count
    const col = new Float32Array(n * 3).fill(i === 0 ? 1 : 0.32)
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.deleteAttribute('uv')
  })
  return mergeGeometries([body, cabin])
}

export function carMaterial() {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 })
}
