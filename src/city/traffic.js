// 车流（示意性，不是交通仿真）:
//   · 每条路按宽度分成单向 1~4 条车道，靠右行驶；进路段时按下一个路口要左转/直行/右转选内/中/外侧车道
//   · 跟车保持间距，看红绿灯，礼让行人
//   · 通行规则参照《道路交通安全法》第47条、《实施条例》第38/51/52条:
//       导向车道: 左转走最内侧、右转走最外侧、直行走中间；红灯可右转（先停、确认不妨碍行人和被放行车辆），不可左转/直行；
//       转弯让直行和行人；进环岛让环内车；行经人行横道遇行人停车让行
//   · 环岛: 环内逆时针单行，不设灯；高架: 独立一层，不与地面路网相交，靠自动生成的上/下匝道和桥下的主干路连通
//     （高架两端通到图外，所以匝道给地面路网带来了净流入和净流出）
//   · 停车场和带地下车库的楼: 车会从最外侧车道拐进去停下/消失，也会定时有车开出来汇入车流
import * as THREE from 'three'
import { carGeometry, carMaterial, CAR_COLORS, layoutParking } from './props.js'
import { SURFACE } from './navgrid.js'
import { signedArea } from './geometry.js'
import { CURB_H } from './ground.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { laneLayout, ELEVATED_H } from './roads.js'

const MIN_ROAD_WIDTH = 5.5 // 比这窄的路不走车
const CAR_LEN = 4.3
const V_MAX = 7.5, V_TURN = 4, V_LOT = 2.8, V_RAMP = 5.5, ACCEL = 2.5, BRAKE = 6
const RAMP_W = 4.4
const MERGE_LEN = 22 // 匝道到桥面标高后，并入/驶出主线的平段长度
const RAMP_LENS = [75, 60, 48] // 匝道水平长度（米），路段放得下就用长的；真实匝道更长，示例街区小，48m 时坡度约 13%

export class Traffic {
  constructor(scene, nav, rand, { density = 1 / 110, capacity = 1500, signals = null } = {}) {
    this.nav = nav
    this.rand = rand
    this.signals = signals
    this.crowd = null // 由引擎在人群建好后注入
    this.capacity = capacity
    this.cars = []
    this.parkingLines = []
    this.decor = new THREE.Group()
    this.decor.name = 'trafficDecor'
    this.#buildWays(scene)
    this.#buildRamps()
    this.#buildFacilities(scene)

    this.mesh = new THREE.InstancedMesh(carGeometry(), carMaterial(), capacity)
    this.mesh.name = 'traffic'
    this.mesh.count = 0
    this.mesh.castShadow = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.setColorAt(0, new THREE.Color('#fff')) // 先把 instanceColor 缓冲区建出来

    const total = this.ways.reduce((s, w) => s + w.lanes[0].len * w.n, 0)
    this.target = Math.min(400, Math.round(total * density))
    this.#seed()
  }

  // -------------------------------------------------------------------------
  // 路网
  // -------------------------------------------------------------------------
  #buildWays(scene) {
    const g = scene.roadGraph || { nodes: {}, edges: [] }
    this.nodes = {}
    for (const [id, n] of Object.entries(g.nodes)) this.nodes[id] = { ...n, busy: null, out: [], inn: [] }
    this.ways = []
    g.edges.forEach((e, edgeIndex) => {
      if (e.width < MIN_ROAD_WIDTH || e.points.length < 2) return
      const { n, laneW, offsets } = laneLayout(e.width, !!e.oneway)
      const pair = []
      for (const dir of e.oneway ? [e.oneway] : [1, -1]) {
        const pts = dir === 1 ? e.points : [...e.points].reverse()
        const from = dir === 1 ? e.a : e.b, to = dir === 1 ? e.b : e.a
        const way = { from, to, edge: e, edgeIndex, n, laneW, lanes: [], twin: null, level: e.level || 0, roundabout: !!e.roundabout }
        for (let k = 0; k < n; k++) {
          const lane = this.#makeLane(pts, offsets[k], this.nodes[from], this.nodes[to], way.roundabout)
          if (!lane) break
          Object.assign(lane, { way, k, off: offsets[k], cars: [], crosswalks: [], gates: [], onRamp: null, offRamp: null })
          lane.sample = (s) => samplePolyline(lane.pts, lane.cum, s, {})
          way.lanes.push(lane)
        }
        if (way.lanes.length !== n) continue
        this.ways.push(way)
        this.nodes[from].out.push(way)
        this.nodes[to].inn.push(way)
        pair.push(way)
      }
      if (pair.length === 2) { pair[0].twin = pair[1]; pair[1].twin = pair[0] }
    })
    this.lanes = this.ways.flatMap((w) => w.lanes)
    for (const lane of this.lanes) {
      for (const c of lane.way.level ? [] : scene.crosswalks || []) {
        const hit = projectOnPolyline(lane.pts, lane.cum, c.center[0], c.center[1])
        if (hit.dist < lane.way.edge.width * 0.6) lane.crosswalks.push({ s: hit.s, cw: c })
      }
      lane.crosswalks.sort((a, b) => a.s - b.s)
      // 停车线: 进路口前最后一条斑马线的外侧；没有斑马线就停在车道尽头
      const last = lane.crosswalks[lane.crosswalks.length - 1]
      lane.stopS = last && lane.len - last.s < 25 ? Math.max(1, last.s - last.cw.depth / 2 - 1.4) : lane.len - 1
    }
    this.entries = this.ways.filter((w) => this.nodes[w.from].degree <= 1)
  }

  /** 中心线向右偏移 off 得到车道线（右 = (-dy, dx)，图像坐标 y 向下），两端在路口处截短 */
  #makeLane(center, off, nodeFrom, nodeTo, ring = false) {
    const n = center.length
    const out = []
    for (let i = 0; i < n; i++) {
      const a = center[Math.max(0, i - 1)], b = center[Math.min(n - 1, i + 1)]
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1
      out.push([center[i][0] - (dy / l) * off, center[i][1] + (dx / l) * off])
    }
    let cum = cumulative(out)
    // 环道的弧段本来就短（两个进口之间常常只有二三十米），少截一点、放宽最短长度，否则内圈车道会被丢掉
    const k = ring ? 0.5 : 1.05
    const trimA = nodeFrom.degree >= 3 ? nodeFrom.radius * k : 0
    const trimB = nodeTo.degree >= 3 ? nodeTo.radius * k : 0
    const len = cum[cum.length - 1]
    if (len - trimA - trimB < (ring ? 3 : 8)) return null
    const pts = slicePolyline(out, cum, trimA, len - trimB)
    cum = cumulative(pts)
    return { pts, cum, len: cum[cum.length - 1] }
  }

  /**
   * 高架匝道。对高架的每个行驶方向:
   *   在它正下方、同向的地面路里找「紧贴桥面外侧的那条车道」，整条留作匝道车道（别的车不走，否则会从匝道里穿过去）；
   *   靠前的一段放上桥匝道，靠后的一段放下桥匝道。匝道低的那一半避开斑马线。
   */
  #buildRamps() {
    this.ramps = []
    for (const ew of this.ways.filter((w) => w.level)) {
      const eLane = ew.lanes[ew.n - 1]
      const deckHalf = ew.edge.width / 2
      const found = { on: null, off: null }
      for (const sw of this.ways) {
        if (sw.level || sw.roundabout || sw.n < 2) continue
        const k = sw.lanes.findIndex((l) => l.off - RAMP_W / 2 > deckHalf - 0.15) // 匝道全宽都要在桥面外侧，否则爬升段会和主桥穿模
        if (k < 0 || (sw.reserved !== undefined && sw.reserved !== k)) continue
        const sl = sw.lanes[k]
        for (const type of ['on', 'off']) for (const RAMP_LEN of RAMP_LENS) {
          if (sl.len < RAMP_LEN + 28) continue
          // 上桥匝道尽量靠路段前部，下桥匝道尽量靠后部
          const starts = []
          for (let s0 = 12; s0 + RAMP_LEN <= sl.len - 16; s0 += 4) starts.push(s0)
          if (type === 'off') starts.reverse()
          for (const s0 of starts) {
            const a = sl.sample(s0), b = sl.sample(s0 + RAMP_LEN)
            const ha = projectOnPolyline(eLane.pts, eLane.cum, a.x, a.y), hb = projectOnPolyline(eLane.pts, eLane.cum, b.x, b.y)
            if (ha.dist > deckHalf + 9 || hb.dist > deckHalf + 9 || hb.s - ha.s < RAMP_LEN * 0.8) continue // 要在桥的正侧下方、且同向
            if (type === 'on' ? hb.s + MERGE_LEN > eLane.len - 8 : ha.s - MERGE_LEN < 8) continue // 桥上还要留出并线平段
            if (ha.s < 10 || hb.s > eLane.len - 10) continue
            const low = type === 'on' ? [s0 - 6, s0 + RAMP_LEN * 0.55] : [s0 + RAMP_LEN * 0.45, s0 + RAMP_LEN + 6]
            if (sl.crosswalks.some((c) => c.s > low[0] && c.s < low[1])) continue
            const better = !found[type] || (type === 'on' ? ha.s < found[type].es0 : ha.s > found[type].es0)
            if (better) found[type] = { type, eLane, sLane: sl, ss0: s0, es0: ha.s, es1: hb.s, rlen: RAMP_LEN }
            break
          }
          if (found[type]?.sLane === sl) break // 这条路上已经用较长的长度放下了，不再试更短的
        }
      }
      // 同一方向上: 先上桥、后下桥，两者不能重叠
      if (found.on && found.off && found.off.es0 - MERGE_LEN < found.on.es1 + MERGE_LEN + 10) found.off = null
      for (const r of [found.on, found.off]) {
        if (!r) continue
        r.sLane.way.reserved = r.sLane.k
        // 走法和真匝道一样: 坡段全程贴在桥面外侧、正好在地面匝道车道的上方（不和主桥重叠）；
        // 到了桥面标高，再用一段平的并线段横移进/出主线最外侧车道。pts: [x, y, 高度, 是否并线段]
        const smooth = (t) => t * t * (3 - 2 * t)
        const slope = [], merge = []
        for (let i = 0; i <= 14; i++) {
          const t = i / 14, B = r.sLane.sample(r.ss0 + r.rlen * t)
          slope.push([B.x, B.y, ELEVATED_H * smooth(r.type === 'on' ? t : 1 - t), 0])
        }
        const top = r.type === 'on' ? slope[slope.length - 1] : slope[0] // 坡顶
        const eTop = r.eLane.sample(r.type === 'on' ? r.es1 : r.es0)
        const dX = top[0] - eTop.x, dY = top[1] - eTop.y // 坡顶相对主线车道的横向偏移
        for (let i = 0; i <= 8; i++) {
          const u = i / 8
          const es = r.type === 'on' ? r.es1 + MERGE_LEN * u : r.es0 - MERGE_LEN * (1 - u)
          const A = r.eLane.sample(es), k = r.type === 'on' ? 1 - smooth(u) : smooth(u)
          merge.push([A.x + dX * k, A.y + dY * k, ELEVATED_H, 1])
        }
        r.pts = r.type === 'on' ? [...slope, ...merge.slice(1)] : [...merge, ...slope.slice(1)]
        r.eFrom = r.es0 - MERGE_LEN // 下桥: 车在主线上的这个位置开始驶出
        r.eTo = r.es1 + MERGE_LEN   // 上桥: 车在主线上的这个位置完成汇入
        r.gap = merge.map((q) => [q[0], q[1]]) // 主桥护栏在这一段要留缺口
        r.cum = cumulative(r.pts)
        r.len = r.cum[r.cum.length - 1]
        r.cars = []
        if (r.type === 'on') r.sLane.onRamp = r
        else r.eLane.offRamp = r
        this.ramps.push(r)
      }
    }
    this.#buildRampMeshes()
  }

  #buildRampMeshes() {
    if (!this.ramps.length) return
    const boxes = [], rails = [], piers = []
    const dir = new THREE.Vector3(), right = new THREE.Vector3(), upv = new THREE.Vector3(), worldUp = new THREE.Vector3(0, 1, 0), m = new THREE.Matrix4()
    for (const r of this.ramps) {
      let sincePier = 0
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i], b = r.pts[i + 1]
        const hm = (a[2] + b[2]) / 2 - 0.03 // 比主桥面低一点点，和桥面重叠的部分被桥面盖住，不会闪烁
        if (hm < 0.12) continue // 已经贴地的那一小段不用画
        dir.set(b[0] - a[0], b[2] - a[2], b[1] - a[1])
        const L = dir.length()
        // 显式构造基: X 沿坡面前进方向，Z 水平向右，Y 垂直坡面。用「两向量间最短旋转」会带上滚转，桥面就拧了
        dir.normalize()
        right.crossVectors(dir, worldUp).normalize()
        upv.crossVectors(right, dir)
        m.makeBasis(dir, upv, right).setPosition((a[0] + b[0]) / 2, hm - 0.28, (a[1] + b[1]) / 2)
        boxes.push(new THREE.BoxGeometry(L + 0.15, 0.5, RAMP_W).applyMatrix4(m))
        // 哪一侧朝着主桥: 看主线车道在匝道的左边还是右边（局部 +Z = 行进方向的右侧）
        const e = r.eLane.sample(projectOnPolyline(r.eLane.pts, r.eLane.cum, a[0], a[1]).s)
        const bridgeSide = (e.x - a[0]) * right.x + (e.y - a[1]) * right.z > 0 ? 1 : -1
        for (const sgn of [-1, 1]) {
          // 朝桥的一侧: 并线段不设护栏（车要横移过去）；坡段接近桥面标高时主桥自己的护栏已经在那儿了
          if (sgn === bridgeSide && (b[3] || a[3] || hm > ELEVATED_H - 0.9)) continue
          const g = new THREE.BoxGeometry(L + 0.15, 0.9, 0.22)
          g.translate(0, 0.7, sgn * (RAMP_W / 2 - 0.1))
          rails.push(g.applyMatrix4(m))
        }
        sincePier += L
        if (hm > 2.2 && hm < ELEVATED_H - 0.6 && sincePier > 14) {
          sincePier = 0
          const pg = new THREE.BoxGeometry(1.0, hm - 0.5, 1.6)
          pg.rotateY(Math.atan2(-(b[1] - a[1]), b[0] - a[0]))
          pg.translate((a[0] + b[0]) / 2, (hm - 0.5) / 2, (a[1] + b[1]) / 2)
          piers.push(pg)
        }
      }
    }
    const add = (geos, color) => {
      if (!geos.length) return
      const mesh = new THREE.Mesh(mergeGeometries(geos.map((g) => { g.deleteAttribute('uv'); return g.toNonIndexed() })), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }))
      mesh.castShadow = mesh.receiveShadow = true
      this.decor.add(mesh)
    }
    add(boxes, '#666a72')
    add(rails, '#eef0f2')
    add(piers, '#c4c8ce')
  }

  /** 给红绿灯用: 每个有灯路口的每个进口道，灯杆位置 + 停车线 */
  signalSites() {
    const sites = []
    for (const way of this.ways) {
      if (!this.signals?.has(way.to)) continue
      const outer = way.lanes[way.n - 1], inner = way.lanes[0]
      const po = outer.sample(outer.stopS), pi = inner.sample(inner.stopS)
      const side = way.laneW / 2 + 1.6
      sites.push({
        node: way.to, edge: way.edgeIndex, dx: po.dx, dy: po.dy,
        post: [po.x - po.dy * side, po.y + po.dx * side],
        stopLine: { center: [(po.x + pi.x) / 2 + po.dx * 0.5, (po.y + pi.y) / 2 + po.dy * 0.5], length: way.laneW * way.n - 0.5 },
      })
    }
    return sites
  }

  // -------------------------------------------------------------------------
  // 停车场 / 地下车库
  // -------------------------------------------------------------------------
  #buildFacilities(scene) {
    this.facilities = []
    const outerLanes = this.lanes.filter((l) => l.k === l.way.n - 1)
    const driveways = []

    const findGate = (cx, cy, maxDist) => {
      let best = null
      for (const lane of outerLanes) {
        if (lane.len < 40 || lane.way.level || lane.way.roundabout || lane.way.reserved === lane.k) continue
        const hit = projectOnPolyline(lane.pts, lane.cum, cx, cy)
        const s = Math.min(lane.len - 20, Math.max(14, hit.s))
        const p = lane.sample(s)
        // 设施必须在这条车道的右手边（右进右出，不横穿对向车道）
        if ((cx - p.x) * -p.dy + (cy - p.y) * p.dx <= 0) continue
        const d = Math.hypot(cx - p.x, cy - p.y)
        if (d < maxDist && (!best || d < best.d)) best = { lane, s, point: [p.x, p.y], d, dx: p.dx, dy: p.dy }
      }
      return best
    }
    const clearOf = (a, b, skipStart) => { // a→b 不穿建筑/水/绿化
      const L = Math.hypot(b[0] - a[0], b[1] - a[1])
      for (let t = skipStart; t < L; t += 1) {
        const sf = this.nav.surfaceAt(a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L)
        if (sf === SURFACE.BUILDING || sf === SURFACE.WATER || sf === SURFACE.GREEN) return false
      }
      return true
    }

    // 露天停车场
    for (const area of (scene.areas || []).filter((a) => a.kind === 'parking')) {
      const c = centroid(area.polygon)
      const gate = findGate(c[0], c[1], 120)
      const entry = gate ? nearestOnPolygon(area.polygon, gate.point) : null
      const usable = !!gate && clearOf(entry, gate.point, 0.5)
      const lay = layoutParking(area, scene.angle || 0, usable ? entry : null)
      this.parkingLines.push(...lay.lines)
      const fac = { type: 'lot', gate: usable ? gate : null, stalls: lay.stalls, timer: 3 + this.rand() * 8, waiting: null }
      for (const st of fac.stalls) {
        st.car = null
        st.reserved = false
        st.pathOut = usable ? dedupe([...st.route, entry, gate.point]) : null
        if (this.rand() < 0.6) {
          st.car = this.#newCar()
          Object.assign(st.car, { mode: 'parked', x: st.pos[0], y: st.pos[1], dx: st.dir[0], dy: st.dir[1], stall: st })
        }
      }
      if (usable) { gate.lane.gates.push({ s: gate.s, fac }); driveways.push([entry, gate]) }
      this.facilities.push(fac)
    }

    // 地下车库: 面积够大、且旁边有能走车的路的楼
    for (const b of scene.buildings || []) {
      const area = Math.abs(signedArea(b.polygon))
      if (area < 1200) continue
      const c = centroid(b.polygon)
      const gate = findGate(c[0], c[1], 110)
      if (!gate) continue
      const entry = nearestOnPolygon(b.polygon, gate.point)
      const L = Math.hypot(gate.point[0] - entry[0], gate.point[1] - entry[1])
      if (L > 30 || L < 3 || !clearOf(entry, gate.point, 1.5)) continue
      const nrm = [(gate.point[0] - entry[0]) / L, (gate.point[1] - entry[1]) / L]
      const inside = [entry[0] - nrm[0] * 5, entry[1] - nrm[1] * 5]
      const capacity = Math.round(area / 45)
      const fac = {
        type: 'garage', building: b.id, gate, capacity, occupied: Math.round(capacity * (0.45 + this.rand() * 0.3)), reserved: 0,
        pathOut: [inside, entry, gate.point], entry, normal: nrm, timer: 4 + this.rand() * 10, waiting: null,
      }
      gate.lane.gates.push({ s: gate.s, fac })
      driveways.push([entry, gate])
      this.facilities.push(fac)
    }
    for (const lane of this.lanes) lane.gates.sort((a, b) => a.s - b.s)
    this.garages = this.facilities.filter((f) => f.type === 'garage')
    this.#buildDecor(driveways)
  }

  /** 出入口的压路沿车道（盖在人行道上的一条沥青）+ 车库门洞 */
  #buildDecor(driveways) {
    const asphalt = new THREE.MeshStandardMaterial({ color: '#6a6f77', roughness: 0.95 })
    const dark = new THREE.MeshStandardMaterial({ color: '#1e2228', roughness: 0.9 })
    for (const [entry, gate] of driveways) {
      const side = gate.lane.way.laneW / 2 // 车道中心 → 右侧路沿
      const end = [gate.point[0] - gate.dy * side, gate.point[1] + gate.dx * side]
      const dx = end[0] - entry[0], dy = end[1] - entry[1], L = Math.hypot(dx, dy)
      if (L < 0.5) continue
      const strip = new THREE.Mesh(new THREE.BoxGeometry(L, 0.02, 5.6), asphalt)
      strip.position.set((entry[0] + end[0]) / 2, CURB_H + 0.012, (entry[1] + end[1]) / 2)
      strip.rotation.y = Math.atan2(-dy, dx)
      strip.receiveShadow = true
      this.decor.add(strip)
    }
    for (const f of this.garages) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.0, 5.6), dark)
      door.position.set(f.entry[0] + f.normal[0] * 0.12, CURB_H + 1.5, f.entry[1] + f.normal[1] * 0.12)
      door.rotation.y = Math.atan2(-f.normal[1], f.normal[0])
      this.decor.add(door)
    }
  }

  garageInfo(buildingId) {
    const f = this.garages.find((g) => g.building === buildingId)
    return f ? { capacity: f.capacity, occupied: f.occupied, entry: f.entry, normal: f.normal } : null
  }

  // -------------------------------------------------------------------------
  // 车
  // -------------------------------------------------------------------------
  #newCar() {
    const car = {
      mode: 'lane', lane: null, s: 0, v: 0, level: 0, move: 'S', rtor: false, x: 0, y: 0, dx: 1, dy: 0, scale: 1, wait: 0, push: 0, nextWay: null, nextPlan: null, parkAt: null,
      color: CAR_COLORS[(this.rand() * CAR_COLORS.length) | 0], vmax: V_MAX * (0.8 + this.rand() * 0.35),
    }
    this.cars.push(car)
    this.colorsDirty = true
    return car
  }

  #remove(car) {
    const i = this.cars.indexOf(car)
    if (i >= 0) this.cars.splice(i, 1)
    this.colorsDirty = true
  }

  /** 从 way 开到 nextWay 算左转/直行/右转（y 向下的坐标里叉积为正 = 右转） */
  #moveOf(way, nextWay) {
    if (!nextWay) return 'S'
    const a = way.lanes[0], b = nextWay.lanes[0]
    const d0 = dirAt(a.pts, a.pts.length - 1), d2 = dirAt(b.pts, 1)
    const cross = d0[0] * d2[1] - d0[1] * d2[0]
    return cross > 0.4 ? 'R' : cross < -0.4 ? 'L' : 'S'
  }

  /**
   * 进入某条路时就定好: 到头后去哪条路、因此该走哪条导向车道。
   *   ≥3 车道: 最内侧左转专用、最外侧右转专用、中间直行；2 车道: 内侧左转+直行、外侧右转+直行；1 车道: 混行
   */
  #plan(way) {
    const opts = this.nodes[way.to].out.filter((w) => w !== way.twin)
    const nextWay = opts.length ? opts[(this.rand() * opts.length) | 0] : null
    const move = this.#moveOf(way, nextWay)
    const n = way.n
    let k = (this.rand() * n) | 0
    if (nextWay && n > 1 && !way.roundabout) {
      if (move === 'L') k = 0
      else if (move === 'R') k = n - 1
      else if (n >= 3) k = 1 + ((this.rand() * (n - 2)) | 0)
    } else if (way.roundabout && n > 1) k = move === 'R' ? n - 1 : 0 // 环内: 下个口出环走外圈，继续绕走内圈
    // 这条路上有匝道车道: 要上桥的车走它，其余的车让开
    if (way.reserved !== undefined) {
      const ramp = way.lanes[way.reserved].onRamp
      if (ramp && this.rand() < 0.3) return { lane: way.lanes[way.reserved], nextWay, move, ramp }
      if (k === way.reserved) k = k > 0 ? k - 1 : k + 1
    }
    return { lane: way.lanes[k], nextWay, move }
  }

  #enterLane(car, lane, nextWay, s = 0, ramp = null) {
    car.takeRamp = ramp || (lane.offRamp && lane.offRamp.eFrom > s + 5 && this.rand() < 0.45 ? lane.offRamp : null)
    car.h = undefined
    car.mode = 'lane'
    car.move = this.#moveOf(lane.way, nextWay)
    car.rtor = false
    car.level = lane.way.level
    car.lane = lane
    car.s = s
    car.nextWay = nextWay
    car.nextPlan = nextWay ? this.#plan(nextWay) : null
    car.turn = null
    car.parkAt = null
    // 这条车道旁有停车场/车库且有空位 → 一定概率拐进去
    for (const g of lane.gates) {
      if (g.s < s + 15 || this.rand() > (this.roadCount > this.target ? 0.7 : 0.25)) continue // 路上车多时更愿意停进去
      const f = g.fac
      if (f.type === 'lot') {
        const free = f.stalls.filter((st) => !st.car && !st.reserved)
        if (!free.length) continue
        const st = free[(this.rand() * free.length) | 0]
        st.reserved = true
        car.parkAt = { gate: g, fac: f, stall: st }
      } else {
        if (f.occupied + f.reserved >= f.capacity) continue
        f.reserved++
        car.parkAt = { gate: g, fac: f }
      }
      break
    }
    const idx = lane.cars.findIndex((c) => c.s > s)
    if (idx < 0) lane.cars.push(car)
    else lane.cars.splice(idx, 0, car)
    samplePolyline(lane.pts, lane.cum, s, car)
  }

  #seed() {
    let guard = this.target * 20, n = 0
    while (n < this.target && guard-- > 0 && this.ways.length) {
      const way = this.ways[(this.rand() * this.ways.length) | 0]
      const plan = this.#plan(way)
      const s = this.rand() * plan.lane.len
      if (plan.lane.cars.some((c) => Math.abs(c.s - s) < 12)) continue
      const car = this.#newCar()
      car.v = V_MAX * 0.6
      this.#enterLane(car, plan.lane, plan.nextWay, s, plan.ramp && plan.ramp.ss0 > s + 5 ? plan.ramp : null)
      n++
    }
  }

  get roadCount() {
    let n = 0
    for (const c of this.cars) if (c.mode === 'lane' || c.mode === 'turn' || c.mode === 'ramp') n++
    return n
  }

  update(dt) {
    if (!this.ways.length) return
    // 出图的车从入口补回来
    if (this.entries.length && this.roadCount < this.target) {
      const plan = this.#plan(this.entries[(this.rand() * this.entries.length) | 0])
      // 每条入口路按长度限流（约 45m 一辆/车道），否则补进来的车会全堆在高架这类直通路上
      const onWay = plan.lane.way.lanes.reduce((n, l) => n + l.cars.length, 0)
      if (onWay < (plan.lane.len / 45) * plan.lane.way.n && !plan.lane.cars.some((c) => c.s < 14)) {
        const car = this.#newCar()
        car.v = V_MAX * 0.6
        this.#enterLane(car, plan.lane, plan.nextWay, 0, plan.ramp)
      }
    }
    this.#updateFacilities(dt)
    for (const car of [...this.cars]) {
      if (car.mode === 'lane') this.#updateLane(car, dt)
      else if (car.mode === 'turn') this.#updateTurn(car, dt)
      else if (car.mode === 'path') this.#updatePath(car, dt)
      else if (car.mode === 'ramp') this.#updateRamp(car, dt)
    }
    this.#write()
  }

  #updateLane(car, dt) {
    const lane = car.lane
    // 前方最近的障碍: 前车 / 有行人的斑马线 / 红灯 / 进不去的路口
    let gap = Infinity
    car.why = ''
    const limit = (g, why) => { if (g < gap) { gap = g; car.why = why } }
    const idx = lane.cars.indexOf(car)
    if (idx + 1 < lane.cars.length) limit(lane.cars[idx + 1].s - car.s - CAR_LEN - 2.5, 'ahead')

    // 礼让行人；但人流不断时会永远等下去，所以等够 5 秒就缓慢通过（push 计时期间不再让）
    let yielding = false
    if (car.push > 0) car.push -= dt
    else if (this.crowd) {
      for (const { s, cw } of lane.crosswalks) {
        const d = s - cw.depth / 2 - 1.2 - (car.s + CAR_LEN / 2)
        if (d < -1 || d > 22) continue
        if (this.crowd.countNear(cw.center[0], cw.center[1], cw.span / 2, true) > 0) { limit(d, 'crosswalk'); yielding = true }
      }
    }
    // 路中间有行人（不限于斑马线）也要让: 看车头前方 5m、9m 两个点
    if (this.crowd && !lane.way.level && car.push <= 0) {
      for (const ahead of [5, 9]) {
        if (this.crowd.countNear(car.x + car.dx * ahead, car.y + car.dy * ahead, 1.6, true) > 0) { limit(ahead - CAR_LEN / 2 - 1.5, 'pedAhead'); yielding = true; break }
      }
    }
    car.wait = yielding && car.v < 0.3 ? car.wait + dt : 0
    if (car.wait > 5) { car.push = 5; car.wait = 0 }

    const toEnd = lane.len - car.s
    let vmax = car.vmax
    if (car.takeRamp) {
      const r = car.takeRamp
      const d = (r.type === 'on' ? r.ss0 : r.eFrom) - car.s
      if (d < 20) vmax = Math.min(vmax, V_RAMP)
      if (d <= 0) {
        lane.cars.splice(lane.cars.indexOf(car), 1)
        car.mode = 'ramp'
        car.ramp = { r, s: 0 }
        r.cars.push(car)
        return
      }
    }
    if (car.parkAt) {
      const d = car.parkAt.gate.s - car.s
      if (d < 14) vmax = Math.min(vmax, V_LOT + 0.8)
      if (d <= 0.3) return this.#leaveRoad(car)
    }
    if (car.nextPlan) {
      const node = this.nodes[lane.way.to]
      const signalized = this.signals?.has(lane.way.to)
      const entryFull = car.nextPlan.lane.cars.some((c) => c.s < CAR_LEN + 4)
      let blocked = entryFull ? 'entryFull' : ''
      if (node.roundabout) {
        // 进环岛让环内车先行（实施条例第51条）；环内车不用让
        if (!lane.way.roundabout && this.#ringBusy(lane.way.to)) blocked = 'ringBusy'
      } else if (!signalized && node.busy && node.busy !== car) blocked = 'nodeBusy' // 没灯的普通路口一次只放一辆
      // 转弯让行人: 绿灯时先进路口、在出口斑马线前等（见 #updateTurn），不占着停车线堵后车；只有红灯右转才要求出口斑马线先清空
      const exitCw = car.nextPlan.lane.crosswalks[0]
      const exitPeds = car.move !== 'S' && exitCw && exitCw.s < 25 && this.crowd && this.crowd.countNear(exitCw.cw.center[0], exitCw.cw.center[1], exitCw.cw.span / 2, true) > 0
      const toLine = lane.stopS - (car.s + CAR_LEN / 2)
      if (toLine > -0.5) { // 车头已过停车线就不再管灯
        if (signalized && !car.rtor) {
          const st = this.signals.state(lane.way.to, lane.way.edgeIndex)
          if (st === 'R' && car.move === 'R') {
            // 红灯右转: 先在停车线停稳，出口斑马线没人、目标车道入口没车才走（实施条例第38条）
            if (car.v < 0.4 && toLine < 2 && !exitPeds && !entryFull) car.rtor = true
            else limit(toLine, 'redRight')
          } else if (st === 'R' || (st === 'Y' && toLine > car.v * 1.2)) limit(toLine, 'red')
        }
        if (blocked) limit(Math.max(0, toLine), blocked)
      } else if (entryFull) limit(toEnd - 1, 'entryFull')
      if (toEnd < 12) vmax = Math.min(vmax, V_TURN + 1.5)
    }
    if (car.push > 0) vmax = Math.min(vmax, 2.2)
    const want = gap === Infinity ? vmax : Math.min(vmax, Math.sqrt(Math.max(0, 2 * 3 * gap)))
    car.v += THREE.MathUtils.clamp(want - car.v, -BRAKE * dt, ACCEL * dt)
    if (gap < 0.2) car.v = 0
    car.s += car.v * dt

    if (car.s >= lane.len) {
      lane.cars.splice(lane.cars.indexOf(car), 1)
      if (!car.nextPlan) return this.#remove(car)
      this.#startTurn(car)
    } else samplePolyline(lane.pts, lane.cum, car.s, car)
  }

  #startTurn(car) {
    const a = car.lane, b = car.nextPlan.lane
    const p0 = a.pts[a.pts.length - 1], p2 = b.pts[0]
    const d0 = dirAt(a.pts, a.pts.length - 1), d2 = dirAt(b.pts, 1)
    // 控制点取两条切线的交点；近乎平行（直行）时退化成中点
    let p1 = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2]
    const cross = d0[0] * d2[1] - d0[1] * d2[0]
    if (Math.abs(cross) > 0.2) {
      const t = ((p2[0] - p0[0]) * d2[1] - (p2[1] - p0[1]) * d2[0]) / cross
      if (t > 0 && t < Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) * 1.5) p1 = [p0[0] + d0[0] * t, p0[1] + d0[1] * t]
    }
    let len = 0, prev = p0
    for (let k = 1; k <= 8; k++) { const q = bezier(p0, p1, p2, k / 8); len += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q }
    car.mode = 'turn'
    car.turn = { p0, p1, p2, len: Math.max(len, 1), u: 0, node: a.way.to, fromRing: a.way.roundabout }
    this.nodes[a.way.to].busy = car
  }

  #updateTurn(car, dt) {
    const t = car.turn
    let want = V_TURN
    // 出口斑马线上有行人 → 停在斑马线前（转弯让行人）
    const exitCw = car.nextPlan.lane.crosswalks[0]
    if (exitCw && exitCw.s < 25 && this.crowd && car.push <= 0) {
      const d = (1 - t.u) * t.len + exitCw.s - exitCw.cw.depth / 2 - 1.0 - CAR_LEN / 2
      if (d > -1 && d < 12 && this.crowd.countNear(exitCw.cw.center[0], exitCw.cw.center[1], exitCw.cw.span / 2, true) > 0) want = Math.min(want, Math.sqrt(Math.max(0, 6 * d)))
    }
    // 路口里前方 7m 内有别的转弯车 → 等它先走（谁进度靠前谁先走，避免互相等死）
    for (const o of this.cars) {
      if (o === car || o.mode !== 'turn' || o.turn.node !== t.node) continue
      const ox = o.x - car.x, oy = o.y - car.y
      if (ox * ox + oy * oy < 49 && ox * car.dx + oy * car.dy > 1 && o.turn.u >= t.u) { want = 0; break }
    }
    car.wait = want < 0.3 ? car.wait + dt : 0
    if (car.wait > 6) { car.push = 4; car.wait = 0 }
    if (car.push > 0) { car.push -= dt; want = Math.max(want, 2) }
    car.v += THREE.MathUtils.clamp(want - car.v, -BRAKE * dt, ACCEL * dt)
    t.u += (car.v * dt) / t.len
    if (t.u >= 1) {
      const node = this.nodes[t.node]
      if (node.busy === car) node.busy = null
      const plan = car.nextPlan
      return this.#enterLane(car, plan.lane, plan.nextWay, 0, plan.ramp)
    }
    const p = bezier(t.p0, t.p1, t.p2, t.u), q = bezier(t.p0, t.p1, t.p2, Math.min(1, t.u + 0.05))
    const d = norm(q[0] - p[0], q[1] - p[1])
    car.x = p[0]; car.y = p[1]; car.dx = d[0]; car.dy = d[1]
  }

  /** 环岛某个进口: 环内有车正要经过这里（或正在经过）→ 外面的车要等 */
  #ringBusy(nodeId) {
    for (const w of this.nodes[nodeId].inn) {
      if (!w.roundabout) continue
      for (const l of w.lanes) if (l.cars.some((c) => l.len - c.s < 16)) return true
    }
    return this.cars.some((c) => c.mode === 'turn' && c.turn.node === nodeId && c.turn.fromRing)
  }

  #updateRamp(car, dt) {
    const { r } = car.ramp
    const target = r.type === 'on' ? r.eLane : r.sLane
    const sT = r.type === 'on' ? r.eTo : r.ss0 + r.rlen
    let gap = Infinity
    const idx = r.cars.indexOf(car)
    if (idx > 0) gap = r.cars[idx - 1].ramp.s - car.ramp.s - CAR_LEN - 2.5 // 先上匝道的排在前面
    // 匝道尽头汇入: 目标车道前后要有空档，否则停在匝道口等
    const clear = !target.cars.some((c) => c.s > sT - 13 && c.s < sT + 8)
    if (!clear) gap = Math.min(gap, r.len - car.ramp.s - 0.5)
    const want = gap === Infinity ? V_RAMP : Math.min(V_RAMP, Math.sqrt(Math.max(0, 6 * gap)))
    car.v += THREE.MathUtils.clamp(want - car.v, -BRAKE * dt, ACCEL * dt)
    if (gap < 0.2) car.v = 0
    car.ramp.s += car.v * dt
    if (car.ramp.s >= r.len && clear) {
      r.cars.splice(idx, 1)
      car.ramp = null
      // 下桥后优先直行（匝道车道在路中间，不适合马上转弯）
      const plan = this.#plan(target.way)
      const opts = this.nodes[target.way.to].out.filter((w) => w !== target.way.twin)
      const straight = opts.find((w) => this.#moveOf(target.way, w) === 'S')
      this.#enterLane(car, target, r.type === 'off' && straight ? straight : plan.nextWay, sT)
      car.takeRamp = null
      return
    }
    const sp = Math.min(car.ramp.s, r.len)
    let i = 1
    while (i < r.cum.length - 1 && r.cum[i] < sp) i++
    const a = r.pts[i - 1], b = r.pts[i], l = r.cum[i] - r.cum[i - 1] || 1, t = (sp - r.cum[i - 1]) / l
    car.x = a[0] + (b[0] - a[0]) * t
    car.y = a[1] + (b[1] - a[1]) * t
    car.h = a[2] + (b[2] - a[2]) * t
    const d = norm(b[0] - a[0], b[1] - a[1])
    car.dx = d[0]; car.dy = d[1]
    car.slope = (b[2] - a[2]) / l
  }

  #startPath(car, pts, extra) {
    const cum = cumulative(pts)
    car.mode = 'path'
    car.path = { pts, cum, len: cum[cum.length - 1], s: 0, reverseUntil: 0, ...extra }
  }

  /** 从车道拐进停车场/车库 */
  #leaveRoad(car) {
    const { fac, stall } = car.parkAt
    car.lane.cars.splice(car.lane.cars.indexOf(car), 1)
    const out = fac.type === 'lot' ? stall.pathOut : fac.pathOut
    this.#startPath(car, [[car.x, car.y], ...[...out].reverse().slice(1)], { arriving: true, fac, stall })
  }

  #updateFacilities(dt) {
    for (const f of this.facilities) {
      if (!f.gate) continue
      // 等在出口的车: 目标车道上前后有空档才汇入
      if (f.waiting) {
        const { lane, s } = f.gate
        if (!lane.cars.some((c) => c.s > s - 14 && c.s < s + 8)) {
          const car = f.waiting
          f.waiting = null
          car.v = 2
          this.#enterLane(car, lane, this.#plan(lane.way).nextWay, s) // 车道固定用出入口所在的外侧车道
        }
        continue
      }
      f.timer -= dt
      if (f.timer > 0) continue
      f.timer = 7 + this.rand() * 16
      if (this.roadCount >= this.target) continue // 路上车已经够多就先不放车出来
      if (f.type === 'lot') {
        const parked = f.stalls.filter((st) => st.car && st.car.mode === 'parked')
        if (!parked.length) continue
        const st = parked[(this.rand() * parked.length) | 0]
        const car = st.car
        st.car = null
        // 先倒车退出车位（第一段），再正着开
        this.#startPath(car, st.pathOut, { arriving: false, fac: f, reverseUntil: Math.hypot(st.pathOut[1][0] - st.pathOut[0][0], st.pathOut[1][1] - st.pathOut[0][1]) })
      } else {
        if (f.occupied <= 0) continue
        f.occupied--
        const car = this.#newCar()
        car.scale = 0
        this.#startPath(car, f.pathOut, { arriving: false, fac: f })
        samplePolyline(car.path.pts, car.path.cum, 0, car)
      }
    }
  }

  #updatePath(car, dt) {
    const p = car.path
    const reversing = p.reverseUntil > p.s
    // 压过人行道时让行人
    let want = V_LOT
    const sgn = reversing ? -1 : 1
    const ax = car.x + car.dx * 3.2 * sgn, ay = car.y + car.dy * 3.2 * sgn
    if (this.crowd && this.nav.surfaceAt(ax, ay) === SURFACE.PAVE && this.crowd.countNear(ax, ay, 2.0) > 0) want = 0
    if (!p.arriving && p.fac.waiting && p.fac.waiting !== car && p.len - p.s < 8) want = 0 // 出口已经有车在等
    car.v += THREE.MathUtils.clamp(want - car.v, -BRAKE * dt, ACCEL * dt)
    p.s += car.v * dt

    const was = [car.dx, car.dy]
    samplePolyline(p.pts, p.cum, Math.min(p.s, p.len), car)
    const tx = reversing ? -car.dx : car.dx, ty = reversing ? -car.dy : car.dy
    const k = Math.min(1, dt * 5)
    const d = norm(was[0] + (tx - was[0]) * k, was[1] + (ty - was[1]) * k)
    car.dx = d[0]; car.dy = d[1]
    if (p.fac.type === 'garage') car.scale = THREE.MathUtils.clamp((p.arriving ? p.len - p.s : p.s) / 4, 0, 1) // 进出门洞时缩放

    if (p.s < p.len) return
    car.path = null
    car.v = 0
    if (!p.arriving) { car.mode = 'waiting'; p.fac.waiting = car; return }
    if (p.fac.type === 'lot') {
      const st = p.stall
      st.reserved = false
      st.car = car
      Object.assign(car, { mode: 'parked', x: st.pos[0], y: st.pos[1], dx: st.dir[0], dy: st.dir[1], stall: st })
    } else {
      p.fac.occupied++
      p.fac.reserved--
      this.#remove(car)
    }
  }

  #write() {
    const arr = this.mesh.instanceMatrix.array
    const n = Math.min(this.cars.length, this.capacity)
    for (let i = 0; i < n; i++) {
      const c = this.cars[i], o = i * 16, s = c.scale
      // 车头朝 +X；二维方向 (dx,dy) → 三维 (dx,0,dy)。压在人行道上时抬到路沿标高
      arr[o] = c.dx * s; arr[o + 1] = c.mode === 'ramp' ? (c.slope || 0) * s : 0; arr[o + 2] = c.dy * s; arr[o + 3] = 0
      arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0
      arr[o + 8] = -c.dy * s; arr[o + 9] = 0; arr[o + 10] = c.dx * s; arr[o + 11] = 0
      arr[o + 12] = c.x
      arr[o + 13] = c.mode === 'ramp' ? (c.h || 0) + 0.02 : c.level ? ELEVATED_H + 0.02 : (c.mode === 'path' || c.mode === 'waiting') && this.nav.surfaceAt(c.x, c.y) === SURFACE.PAVE ? CURB_H + 0.02 : 0.02
      arr[o + 14] = c.y; arr[o + 15] = 1
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.colorsDirty) {
      // 实例槽位 = 数组下标，增删车后颜色要跟着车走
      const col = new THREE.Color()
      for (let i = 0; i < n; i++) this.mesh.setColorAt(i, col.set(this.cars[i].color))
      this.mesh.instanceColor.needsUpdate = true
      this.colorsDirty = false
    }
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.decor.traverse((o) => { o.geometry?.dispose(); o.material?.dispose() })
  }
}

// ---------------------------------------------------------------------------
function norm(x, y) {
  const l = Math.hypot(x, y) || 1
  return [x / l, y / l]
}

function dirAt(pts, i) {
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, Math.max(1, i))]
  return norm(b[0] - a[0], b[1] - a[1])
}

function bezier(a, b, c, t) {
  const v = 1 - t
  return [v * v * a[0] + 2 * v * t * b[0] + t * t * c[0], v * v * a[1] + 2 * v * t * b[1] + t * t * c[1]]
}

function cumulative(pts) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  return cum
}

function samplePolyline(pts, cum, s, out) {
  let i = 1
  while (i < cum.length - 1 && cum[i] < s) i++
  const a = pts[i - 1], b = pts[i], l = cum[i] - cum[i - 1] || 1
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / l))
  out.x = a[0] + (b[0] - a[0]) * t
  out.y = a[1] + (b[1] - a[1]) * t
  out.dx = (b[0] - a[0]) / l
  out.dy = (b[1] - a[1]) / l
  return out
}

function slicePolyline(pts, cum, s0, s1) {
  const tmp = {}
  const out = []
  samplePolyline(pts, cum, s0, tmp); out.push([tmp.x, tmp.y])
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 + 0.01 && cum[i] < s1 - 0.01) out.push(pts[i])
  samplePolyline(pts, cum, s1, tmp); out.push([tmp.x, tmp.y])
  return out
}

function projectOnPolyline(pts, cum, x, y) {
  let best = { dist: Infinity, s: 0 }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2))
    const d = Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t)
    if (d < best.dist) best = { dist: d, s: cum[i - 1] + Math.sqrt(l2) * t }
  }
  return best
}

function centroid(poly) {
  let x = 0, y = 0
  for (const p of poly) { x += p[0]; y += p[1] }
  return [x / poly.length, y / poly.length]
}

function nearestOnPolygon(poly, p) {
  let best = null, bd = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    const q = [a[0] + dx * t, a[1] + dy * t], d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (d < bd) { bd = d; best = q }
  }
  return best
}

function dedupe(pts) {
  return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.4)
}
