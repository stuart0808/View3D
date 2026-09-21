// 地块底座、路面、人行铺装、车道线/斑马线，以及四周雾化的背景楼块。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { makeShape, toGround, offsetPolygon } from './geometry.js'
import { laneLayout, hasMedian, ELEVATED_H } from './roads.js'

export const CURB_H = 0.18

export function buildGround(scene, style, parkingLines = []) {
  const group = new THREE.Group()
  group.name = 'ground'
  const std = (color, rough = 0.95) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 })

  // 底座（浅色厚板）+ 路面（整块地块铺深色，人行铺装再盖在上面，天然无缝）
  const slabs = [], roadTops = []
  for (const s of scene.site || []) {
    const shape = makeShape(s.polygon, s.holes)
    slabs.push(toGround(new THREE.ExtrudeGeometry(shape, { depth: 1.6, bevelEnabled: false }), -1.62))
    roadTops.push(toGround(new THREE.ShapeGeometry(shape), 0))
  }
  if (slabs.length) {
    const slab = new THREE.Mesh(mergeGeometries(slabs), std(style.slab))
    slab.castShadow = true
    slab.receiveShadow = true
    group.add(slab)
    const road = new THREE.Mesh(mergeGeometries(roadTops), std(style.road))
    road.receiveShadow = true
    group.add(road)
  }

  const paves = (scene.pavement || []).map((p) =>
    toGround(new THREE.ExtrudeGeometry(makeShape(p.polygon, p.holes), { depth: CURB_H, bevelEnabled: false }), 0))
  if (paves.length) {
    const mat = std(style.pavement, 0.9)
    mat.map = tileTexture(scene.angle || 0)
    const pave = new THREE.Mesh(mergeGeometries(paves), mat)
    pave.receiveShadow = true
    group.add(pave)
  }

  group.add(buildAreas(scene, style))
  group.add(buildMarkings(scene, style, parkingLines))
  group.add(buildElevated(scene, style))

  // 接住底座影子的透明地面
  const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.ShadowMaterial({ opacity: 0.13 }))
  shadowPlane.rotation.x = -Math.PI / 2
  shadowPlane.position.y = -1.6
  shadowPlane.receiveShadow = true
  group.add(shadowPlane)
  return group
}

function tileTexture(angle, size = 2.4) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 64
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 64, 64)
  ctx.strokeStyle = 'rgba(150,150,150,0.35)'
  ctx.lineWidth = 2
  ctx.strokeRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1 / size, 1 / size)
  tex.rotation = angle
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/**
 * 面状区域。绿化/公园/广场是盖在人行铺装上的薄板（绿化带略高，像花池）；
 * 水体和停车场在脚本里已经从铺装中挖掉，这里只在路面标高上铺一层面。
 */
function buildAreas(scene, style) {
  const group = new THREE.Group()
  group.name = 'areas'
  const SPEC = {
    green: { height: 0.34, color: style.grass, rough: 1 },
    park: { height: 0.24, color: style.park, rough: 1 },
    plaza: { height: 0.21, color: style.plaza, rough: 0.85, tile: 4.8 },
    water: { flat: 0.05, color: style.water, rough: 0.12, metal: 0.25 },
    parking: { flat: 0.012, color: style.parking, rough: 0.95 },
  }
  for (const [kind, spec] of Object.entries(SPEC)) {
    const list = (scene.areas || []).filter((a) => a.kind === kind)
    if (!list.length) continue
    const geos = list.map((a) => {
      const shape = makeShape(a.polygon, a.holes)
      return spec.flat !== undefined
        ? toGround(new THREE.ShapeGeometry(shape), spec.flat)
        : toGround(new THREE.ExtrudeGeometry(shape, { depth: spec.height, bevelEnabled: false }), 0)
    })
    const mat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: spec.rough, metalness: spec.metal || 0 })
    if (spec.tile) mat.map = tileTexture(scene.angle || 0, spec.tile)
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat)
    mesh.name = kind
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}

/**
 * 路面标线，全部塞进一个 InstancedMesh（每个实例自带颜色）:
 *   中心线: 单向 1 车道黄虚线，2 车道双黄实线，≥3 车道改用实体中央隔离带（另建）；
 *   同向车道之间白虚线；单行路（环岛）只有车道分隔线；高架上的线抬到桥面标高。
 */
function buildMarkings(scene, style, parkingLines) {
  const items = [] // [x, z, angle, length, width, color, y]
  const medians = []
  const DASH = 3, GAP = 4.5
  const stroke = (pts, off, width, color, dashed, y) => {
    let carry = 0
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
      const L = Math.hypot(bx - ax, by - ay)
      if (L < 1e-3) continue
      const tx = (bx - ax) / L, ty = (by - ay) / L
      const ox = -ty * off, oy = tx * off, ang = Math.atan2(-ty, tx)
      if (!dashed) { items.push([ax + (tx * L) / 2 + ox, ay + (ty * L) / 2 + oy, ang, L + 0.05, width, color, y]); continue }
      let s = carry
      for (; s + DASH <= L; s += DASH + GAP) items.push([ax + tx * (s + DASH / 2) + ox, ay + ty * (s + DASH / 2) + oy, ang, DASH, width, color, y])
      carry = Math.max(0, s - L)
    }
  }
  for (const lane of scene.lanes || []) {
    const y = 0.025 + (lane.level ? ELEVATED_H : 0)
    const { n, laneW, offsets } = laneLayout(lane.width, !!lane.oneway)
    if (lane.oneway) {
      for (let k = 1; k < n; k++) stroke(lane.points, offsets[k] - laneW / 2, 0.18, style.marking, true, y)
      continue
    }
    if (hasMedian(lane.width)) medians.push(lane)
    else if (n >= 2) { stroke(lane.points, 0.2, 0.16, style.centerLine, false, y); stroke(lane.points, -0.2, 0.16, style.centerLine, false, y) }
    else stroke(lane.points, 0, 0.2, style.centerLine, true, y)
    for (let k = 1; k < n; k++) for (const sgn of [1, -1]) stroke(lane.points, sgn * k * laneW, 0.18, style.marking, true, y)
  }
  for (const c of scene.crosswalks || []) {
    const [tx, ty] = c.dir
    const ang = Math.atan2(-ty, tx)
    const n = Math.max(2, Math.floor((c.span - 1.2) / 1.1))
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 1.1
      items.push([c.center[0] - ty * off, c.center[1] + tx * off, ang, c.depth, 0.55, style.marking, 0.025])
    }
  }
  for (const l of parkingLines) items.push([l.pos[0], l.pos[1], -l.angle, l.length, l.width, style.marking, 0.025])

  const group = new THREE.Group()
  group.name = 'markings'
  const geo = new THREE.PlaneGeometry(1, 1)
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9 }), Math.max(1, items.length))
  mesh.count = items.length
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color()
  items.forEach(([x, z, ang, len, wid, color, y], i) => {
    q.setFromAxisAngle(up, ang)
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(len, 1, wid))
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, col.set(color))
  })
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  group.add(mesh)

  // 中央隔离带: 沿中心线的一条矮绿化带（路口、斑马线处 lanes 本来就是断开的，隔离带也就自然断开）
  if (medians.length) {
    const boxes = []
    for (const lane of medians) {
      const y0 = lane.level ? ELEVATED_H : 0
      for (let i = 0; i + 1 < lane.points.length; i++) {
        const [ax, ay] = lane.points[i], [bx, by] = lane.points[i + 1]
        const L = Math.hypot(bx - ax, by - ay)
        if (L < 0.5) continue
        const b = new THREE.BoxGeometry(L, 0.45, 1.3)
        b.rotateY(Math.atan2(-(by - ay), bx - ax))
        b.translate((ax + bx) / 2, y0 + 0.225, (ay + by) / 2)
        boxes.push(b)
      }
    }
    const median = new THREE.Mesh(mergeGeometries(boxes), new THREE.MeshStandardMaterial({ color: style.grass, roughness: 1 }))
    median.castShadow = median.receiveShadow = true
    group.add(median)
  }
  return group
}

/** 高架: 桥面板 + 两侧护栏 + 桥墩。车和标线由别处抬到 ELEVATED_H */
export function buildElevated(scene, style) {
  const group = new THREE.Group()
  group.name = 'elevated'
  const decks = [], rails = [], piers = []
  for (const e of scene.elevated || []) {
    decks.push(toGround(new THREE.ExtrudeGeometry(makeShape(e.polygon, e.holes), { depth: 0.9, bevelEnabled: false }), ELEVATED_H - 0.9))
    const inner = offsetPolygon(e.polygon, -0.45)
    if (inner) rails.push(toGround(new THREE.ExtrudeGeometry(makeShape(e.polygon, [inner]), { depth: 1.0, bevelEnabled: false }), ELEVATED_H))
  }
  for (const lane of scene.lanes || []) {
    if (!lane.level) continue
    let acc = 14
    for (let i = 0; i + 1 < lane.points.length; i++) {
      const [ax, ay] = lane.points[i], [bx, by] = lane.points[i + 1]
      const L = Math.hypot(bx - ax, by - ay)
      for (; acc < L; acc += 28) {
        const p = new THREE.BoxGeometry(1.6, ELEVATED_H - 0.9, 2.4)
        p.rotateY(Math.atan2(-(by - ay), bx - ax))
        p.translate(ax + ((bx - ax) * acc) / L, (ELEVATED_H - 0.9) / 2, ay + ((by - ay) * acc) / L)
        piers.push(p)
      }
      acc -= L
    }
  }
  const add = (geos, color) => {
    if (!geos.length) return
    const mesh = new THREE.Mesh(mergeGeometries(geos.map((g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g })), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }))
    mesh.castShadow = mesh.receiveShadow = true
    group.add(mesh)
  }
  add(decks, style.road)
  add(rails, style.slab)
  add(piers, '#c4c8ce')
  return group
}

/**
 * 背景楼块。正交相机下没有真正的「远处」，所以雾是假的:
 * 按离中心的距离把楼块颜色往背景色上混，并让每栋楼从上到下渐隐到背景色。
 */
export function buildBackdrop(scene, style, rand) {
  const b = scene.bounds
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
  const R = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2
  const ang = scene.angle || 0
  const ca = Math.cos(ang), sa = Math.sin(ang)
  const bg = new THREE.Color(style.background), tint = new THREE.Color(style.backdrop)
  const step = Math.max(70, R * 0.55)
  const range = Math.ceil((R * 3.4) / step)
  const geos = []
  const col = new THREE.Color()

  for (let gj = -range; gj <= range; gj++) {
    for (let gi = -range; gi <= range; gi++) {
      // 在旋转后的网格上摆放，和街区朝向一致
      const lx = (gi + (rand() - 0.5) * 0.35) * step, ly = (gj + (rand() - 0.5) * 0.35) * step
      const inner = R * 0.95 + step * 0.55
      if (Math.abs(lx) < inner && Math.abs(ly) < inner) continue
      const dist = Math.hypot(lx, ly)
      if (dist > R * 3.4 || rand() < 0.22) continue
      const w = step * (0.4 + rand() * 0.32), d = step * (0.4 + rand() * 0.32), h = 30 + rand() * rand() * 140
      const fade = THREE.MathUtils.smoothstep(dist, R * 1.0, R * 3.2) * 0.75 + 0.18

      const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
      const pos = g.attributes.position, nor = g.attributes.normal
      const colors = new Float32Array(pos.count * 3)
      for (let v = 0; v < pos.count; v++) {
        const shade = nor.getY(v) > 0.5 ? 1.0 : nor.getX(v) > 0.5 ? 0.9 : nor.getZ(v) > 0.5 ? 0.82 : 0.86
        const t = (pos.getY(v) + h / 2) / h // 0 底 → 1 顶
        col.copy(tint).multiplyScalar(shade).lerp(bg, fade)
        col.lerp(bg, (1 - t) * 0.95)
        colors.set([col.r, col.g, col.b], v * 3)
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      g.deleteAttribute('uv')
      g.rotateY(-ang)
      g.translate(cx + lx * ca - ly * sa, h / 2 - 40, cy + lx * sa + ly * ca)
      geos.push(g)
    }
  }
  const mesh = new THREE.Mesh(geos.length ? mergeGeometries(geos) : new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true }))
  mesh.name = 'backdrop'
  return mesh
}
