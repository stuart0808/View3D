// 地面层: 地块底座、路面、人行铺装、面状区域、路面标线、高架桥体，以及四周雾化的背景楼块。
//
// 分层思路（从下到上）:
//   底座 slab      整个地块的一块厚板（-1.6m 起），让街区像「托盘」一样浮在背景上
//   路面 road      地块顶面整体铺深色 = 车行道；不单独画每条路，人行铺装盖上去之后剩下的就是路，天然无缝
//   铺装 pavement  人行道 / 街区内部，抬高 CURB_H 形成路沿
//   区域 areas     绿化 / 公园 / 广场是盖在铺装上的薄板；水体、停车场在脚本里已从铺装挖掉，铺在路面标高
//   标线 markings  车道线、中心线、斑马线、停车位线，一个 InstancedMesh；中央隔离带、桥下隔离带另建
//   高架 elevated  桥面 / 护栏 / 桥墩，标高 ELEVATED_H
// 所有几何体按材质合并，整层十几个 draw call。
// 几何体都是从 scene.json 的二维多边形拉伸 / 铺面得来: toGround 把 xy 平面上的形状翻到 xz 地面并抬到指定高度。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { makeShape, toGround, signedArea, edgeNormal } from './geometry.js'
import { laneLayout, hasMedian, ELEVATED_H } from './roads.js'

export const CURB_H = 0.18 // 路沿高度（米）: 人行铺装比路面高这么多，行人和路灯、树都立在这个标高上

/**
 * 建整个地面层，返回一个 Group（名字 'ground'）。
 * @param scene         scene.json（site / pavement / areas / lanes / crosswalks / elevated / angle）
 * @param style         配色表 { slab, road, pavement, grass, park, plaza, water, parking, marking, centerLine, underDeck }
 * @param parkingLines  停车位线（Traffic 排好车位后给的，画进标线层）
 * @param railGaps      高架护栏要留缺口的折线（匝道并线段）
 * @param islands       匝道岛（匝道坡体下方 + 空置的匝道车道），并进桥下隔离带
 */
export function buildGround(scene, style, parkingLines = [], railGaps = [], islands = []) {
  const group = new THREE.Group()
  group.name = 'ground'
  const std = (color, rough = 0.95) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 }) // 无金属感的哑光材质

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

  // 人行铺装: 抬高 CURB_H 的薄板，带分缝贴图
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
  group.add(buildMarkings(scene, style, parkingLines, islands))
  group.add(buildElevated(scene, style, railGaps))

  // 接住底座影子的透明地面（只显示阴影的材质），比底座底面还低一点
  const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.ShadowMaterial({ opacity: 0.13 }))
  shadowPlane.rotation.x = -Math.PI / 2
  shadowPlane.position.y = -1.6
  shadowPlane.receiveShadow = true
  group.add(shadowPlane)
  return group
}

/** 铺装分缝贴图: 一张只有边框的小方块，按世界坐标每 size 米重复一次，并转到街区主方向。没有 canvas（测试环境）时返回 null */
function tileTexture(angle, size = 2.4) {
  if (typeof document === 'undefined') return null
  const cv = document.createElement('canvas')
  cv.width = cv.height = 64
  const ctx = cv.getContext('2d')
  if (!ctx) return null
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
  // 每类区域的画法: height = 抬高的薄板厚度；flat = 直接铺在这个标高的面；tile = 分缝贴图的格子大小
  const SPEC = {
    green: { height: 0.34, color: style.grass, rough: 1 },
    park: { height: 0.24, color: style.park, rough: 1 },
    plaza: { height: 0.21, color: style.plaza, rough: 0.85, tile: 4.8 },
    water: { flat: 0.05, color: style.water, rough: 0.12, metal: 0.25 },
    parking: { flat: 0.012, color: style.parking, rough: 0.95 },
  }
  for (const [kind, spec] of Object.entries(SPEC)) { // 同类区域合并成一个网格，名字就是类型
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
function buildMarkings(scene, style, parkingLines, islands = []) {
  const items = [] // 每条标线一个实例: [x, z, angle, length, width, color, y]
  const medians = [], underDeck = [] // 要另建实体隔离带的路段
  const DASH = 3, GAP = 4.5 // 虚线: 3m 线 + 4.5m 空，国标的 4:6 近似
  // 沿折线画一条线: off 是相对中心线向右的偏移（右 = (-ty, tx)），dashed 决定虚实，carry 让虚线跨拐点连续
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
  for (const lane of scene.lanes || []) { // 每条路（一条 lane 记录 = 一条路的中心线 + 路宽）
    const y = 0.025 + (lane.level ? ELEVATED_H : 0)
    const { n, laneW, offsets } = laneLayout(lane.width, !!lane.oneway, lane.median || 0)
    if (lane.median) {
      // 桥下的路: 中间是一整条桥下隔离带（另建），两侧车道之间白虚线，最内侧画一条白实线当边线
      underDeck.push(lane)
      for (const sgn of [1, -1]) {
        stroke(lane.points, sgn * (offsets[0] - laneW / 2 + 0.15), 0.16, style.marking, false, y)
        for (let k = 1; k < n; k++) stroke(lane.points, sgn * (offsets[k] - laneW / 2), 0.18, style.marking, true, y)
      }
      continue
    }
    if (lane.oneway) {
      for (let k = 1; k < n; k++) stroke(lane.points, offsets[k] - laneW / 2, 0.18, style.marking, true, y)
      continue
    }
    if (hasMedian(lane.width)) medians.push(lane)
    else if (n >= 2) { stroke(lane.points, 0.2, 0.16, style.centerLine, false, y); stroke(lane.points, -0.2, 0.16, style.centerLine, false, y) }
    else stroke(lane.points, 0, 0.2, style.centerLine, true, y)
    for (let k = 1; k < n; k++) for (const sgn of [1, -1]) stroke(lane.points, sgn * k * laneW, 0.18, style.marking, true, y)
  }
  // 斑马线: 沿过街方向 dir 每 1.1m 一条 0.55m 宽的白条，条数按跨度算
  for (const c of scene.crosswalks || []) {
    const [tx, ty] = c.dir
    const ang = Math.atan2(-ty, tx)
    const n = Math.max(2, Math.floor((c.span - 1.2) / 1.1))
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 1.1
      items.push([c.center[0] - ty * off, c.center[1] + tx * off, ang, c.depth, 0.55, style.marking, 0.025])
    }
  }
  // 停车位线（Traffic 排好的）
  for (const l of parkingLines) items.push([l.pos[0], l.pos[1], -l.angle, l.length, l.width, style.marking, 0.025])

  const group = new THREE.Group()
  group.name = 'markings'
  // 单位平面 → 每个实例用缩放矩阵拉成 length x width 的条，贴在路面上方 2.5cm 免得和路面打架
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

  // 桥下隔离带（桥墩立在上面），以及匝道岛: 匝道坡体下面 + 匝道车道不用的那一段，都并进隔离带，
  // 看起来就是「匝道车道从隔离带里长出来 / 收回去」，而不是几条画着线却没车走的死车道
  const strips = [
    ...underDeck.map((l) => ({ pts: l.points, off: 0, width: l.median * 2 })),
    ...islands.map((i) => ({ pts: i.pts, off: 0, width: i.width })),
  ]
  if (strips.length) {
    const boxes = []
    for (const st of strips) {
      for (let i = 0; i + 1 < st.pts.length; i++) {
        const [ax, ay] = st.pts[i], [bx, by] = st.pts[i + 1]
        const L = Math.hypot(bx - ax, by - ay)
        if (L < 0.3) continue
        const b = new THREE.BoxGeometry(L + 0.1, 0.22, st.width)
        b.rotateY(Math.atan2(-(by - ay), bx - ax))
        b.translate((ax + bx) / 2, 0.11, (ay + by) / 2)
        boxes.push(b)
      }
    }
    const mesh = new THREE.Mesh(mergeGeometries(boxes), new THREE.MeshStandardMaterial({ color: style.underDeck, roughness: 1 }))
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}

/** 点到折线的最短距离（护栏留缺口用） */
function distToPolyline(x, y, pts) {
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t))
  }
  return best
}

/**
 * 高架: 桥面板（0.9m 厚，顶面 = ELEVATED_H）+ 两侧护栏（沿轮廓 3m 一段，匝道并线处留缺口）+ 桥墩（沿中心线每 28m 一根）。
 * 车和标线由别处抬到 ELEVATED_H。环形高架的轮廓带孔，内外两圈都要护栏。
 */
export function buildElevated(scene, style, railGaps = []) {
  const group = new THREE.Group()
  group.name = 'elevated'
  const decks = [], rails = [], piers = []
  for (const e of scene.elevated || []) {
    decks.push(toGround(new THREE.ExtrudeGeometry(makeShape(e.polygon, e.holes), { depth: 0.9, bevelEnabled: false }), ELEVATED_H - 0.9))
    // 护栏沿桥面轮廓一小段一小段地摆，匝道并线的地方（railGaps）跳过，车才不是「穿过护栏」上桥的
    for (const ring of [e.polygon, ...(e.holes || [])]) { // 环形高架有内孔，内外两圈都要有护栏
    const isHole = ring !== e.polygon
    const area = signedArea(ring) * (isHole ? -1 : 1) // 孔的「外侧」朝着孔里，法线要反过来
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length]
      const L = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (L < 0.3) continue
      const tx = (q[0] - p[0]) / L, ty = (q[1] - p[1]) / L
      const [ox, oy] = edgeNormal(ring, i, area)
      const n = Math.max(1, Math.round(L / 3))
      for (let k = 0; k < n; k++) {
        const s = (L * (k + 0.5)) / n
        const cx = p[0] + tx * s - ox * 0.22, cy = p[1] + ty * s - oy * 0.22
        if (railGaps.some((g) => distToPolyline(cx, cy, g) < 3.4)) continue
        const b = new THREE.BoxGeometry(L / n + 0.05, 1.0, 0.44)
        b.rotateY(Math.atan2(-ty, tx))
        b.translate(cx, ELEVATED_H + 0.5, cy)
        rails.push(b)
      }
    }
    }
  }
  // 桥墩: 沿高架中心线每 28m 一根，第一根离路段起点 14m；acc 跨折线段累计，拐点处不重置
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
  // 桥面 / 护栏 / 桥墩各合并成一个网格（去 uv、转非索引后才能合并）
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
 * 背景楼块，返回一个 Mesh（名字 'backdrop'）。正交相机下没有真正的「远处」，所以雾是假的:
 * 按离中心的距离把楼块颜色往背景色上混，并让每栋楼从上到下渐隐到背景色。
 */
export function buildBackdrop(scene, style, rand) {
  const b = scene.bounds
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
  const R = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2
  const ang = scene.angle || 0
  const ca = Math.cos(ang), sa = Math.sin(ang)
  const bg = new THREE.Color(style.background), tint = new THREE.Color(style.backdrop)
  const step = Math.min(240, Math.max(70, R * 0.55)) // 楼块网格间距: 场景再大，背景楼块也保持楼的尺度
  const range = Math.ceil((R * 3.4) / step) // 铺到 3.4 倍场景半径远
  const geos = []
  const col = new THREE.Color()

  // 以场景中心为原点、按街区方向旋转的方格网，每格放一个随机大小的楼块
  for (let gj = -range; gj <= range; gj++) {
    for (let gi = -range; gi <= range; gi++) {
      // 在旋转后的网格上摆放，和街区朝向一致
      const lx = (gi + (rand() - 0.5) * 0.35) * step, ly = (gj + (rand() - 0.5) * 0.35) * step
      const inner = R * 0.95 + step * 0.55
      if (Math.abs(lx) < inner && Math.abs(ly) < inner) continue // 场景本身的范围留空
      const dist = Math.hypot(lx, ly)
      if (dist > R * 3.4 || rand() < 0.22) continue
      const w = step * (0.4 + rand() * 0.32), d = step * (0.4 + rand() * 0.32), h = 30 + rand() * rand() * 140
      const fade = THREE.MathUtils.smoothstep(dist, R * 1.0, R * 3.2) * 0.75 + 0.18 // 越远越往背景色混（假雾）

      const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
      const pos = g.attributes.position, nor = g.attributes.normal
      const colors = new Float32Array(pos.count * 3)
      for (let v = 0; v < pos.count; v++) {
        // 顶面最亮，各侧面略有明暗差，才有体积感（MeshBasicMaterial 不受光照，明暗全靠顶点色）
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
