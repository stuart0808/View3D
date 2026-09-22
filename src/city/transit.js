// 轨道交通: 地铁（地下，用「透视叠加」的方式画线路/车站/列车）和铁路（高架桥，实体）。
// 列车按时刻表发车: 两类交通各有「工作日 / 节假日」两套时刻表，由仿真时钟决定用哪一套、此刻的发车间隔是多少。
// 核心区里的车站有出入口: 列车到站时乘客成批涌出，人群也会把车站当作离开的出口。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CURB_H } from './ground.js'

import { RAIL_H } from './roads.js'
import { stationLayouts, buildStationMeshes } from './stations.js'
export { RAIL_H }

/**
 * 时刻表: [起始小时, 发车间隔(分钟)]，间隔 0 = 停运。想换成真实时刻表，改这里或在 new Transit 时传 timetables。
 */
export const TIMETABLES = {
  metro: {
    workday: [[0, 0], [5.5, 8], [7, 3], [9.5, 6], [16.5, 3], [19.5, 6], [22, 10], [23.5, 0]],
    holiday: [[0, 0], [6, 10], [8.5, 5], [21.5, 8], [23.5, 0]],
  },
  rail: {
    workday: [[0, 0], [6, 30], [7, 15], [9.5, 30], [17, 15], [19.5, 30], [23, 0]],
    holiday: [[0, 0], [6.5, 30], [8, 20], [20, 30], [23, 0]],
  },
}

const SPEC = {
  metro: { vmax: 17, accel: 1.0, dwell: 35, cars: 6, carLen: 19, width: 3.0, height: 3.4 },
  rail: { vmax: 30, accel: 0.6, dwell: 120, cars: 8, carLen: 25, width: 3.3, height: 3.9 },
}

export function headwayAt(kind, timetable, hour, tables = TIMETABLES) {
  let h = 0
  for (const [from, gap] of tables[kind][timetable]) if (hour >= from) h = gap
  return h
}

export class Transit {
  constructor(scene, nav, clock, { timetables = TIMETABLES } = {}) {
    this.clock = clock
    this.tables = timetables
    this.group = new THREE.Group()
    this.group.name = 'transit'
    this.lines = (scene.transit?.lines || []).map((l) => this.#prepareLine(l))
    this.buildings = scene.buildings || [] // 站前广场选边要看建筑
    this.trains = []
    this.onArrive = null // (stationName, line) => void
    this.#buildStations(nav)
    this.#buildTrack()
    this.#buildTrainMeshes()
    this.unsub = clock.on((ev) => ev === 'jump' && this.#populate())
    this.#populate()
  }

  #prepareLine(l) {
    const pts = l.loop ? [...l.points, l.points[0]] : l.points
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    const line = { ...l, pts, cum, len: cum[cum.length - 1], spec: SPEC[l.kind] || SPEC.metro, next: { 1: 0, [-1]: 0 } }
    line.stops = l.stations.map((st) => ({ name: st.name, pos: st.pos, s: project(pts, cum, st.pos) })).sort((a, b) => a.s - b.s)
    return line
  }

  /** 同名车站是换乘站，只建一次。落在导航网格里的站生成 1~2 个地面出入口，供人群当作出入口用 */
  #buildStations(nav) {
    this.stations = new Map()
    for (const line of this.lines) {
      for (const st of line.stops) {
        let rec = this.stations.get(st.name)
        if (!rec) this.stations.set(st.name, (rec = { name: st.name, pos: st.pos, lines: [], entrances: [] }))
        rec.lines.push(line)
      }
    }
    for (const st of this.stations.values()) {
      const seen = new Set()
      for (const [dx, dy] of [[22, 14], [-22, -14], [14, -22], [-14, 22]]) {
        // 站点压在核心区边界上（比如正好在边界那条主干路底下）也算: 就近 60m 内找得到人行道就设出入口
        const cell = nav.nearestWalkable(st.pos[0] + dx, st.pos[1] + dy, nav.contains(st.pos[0], st.pos[1]) ? 40 : 60)
        if (cell < 0 || seen.has(cell) || st.entrances.length >= 2) continue
        seen.add(cell)
        st.entrances.push(nav.center(cell))
      }
    }
  }

  /** 给人群用的出入口: [{ pos, weight, station }] */
  portals() {
    const out = []
    for (const st of this.stations.values()) for (const p of st.entrances) out.push({ pos: p, weight: 3 * st.lines.length, station: st.name })
    return out
  }

  // -------------------------------------------------------------------------
  // 线路、车站的网格
  // -------------------------------------------------------------------------
  #buildTrack() {
    const xray = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false })
    for (const line of this.lines) {
      const elevated = line.kind === 'rail'
      const y = elevated ? RAIL_H : 0.7
      const strips = [], piers = [], rails = []
      let acc = 12
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const [ax, ay] = line.pts[i], [bx, by] = line.pts[i + 1]
        const L = Math.hypot(bx - ax, by - ay)
        if (L < 0.2) continue
        const ang = Math.atan2(-(by - ay), bx - ax)
        const box = (w, h, yc, side = 0) => {
          const g = new THREE.BoxGeometry(L + 0.3, h, w).toNonIndexed()
          g.translate(0, 0, side)
          g.rotateY(ang)
          g.translate((ax + bx) / 2, yc, (ay + by) / 2)
          g.deleteAttribute('uv')
          return g
        }
        if (elevated) {
          strips.push(box(10, 0.9, y - 0.45))
          for (const sd of [-2.6, -1.1, 1.1, 2.6]) rails.push(box(0.16, 0.18, y + 0.09, sd))
          for (; acc < L; acc += 30) {
            const p = new THREE.BoxGeometry(2.2, y - 0.9, 3.2).toNonIndexed()
            p.rotateY(ang)
            p.translate(ax + ((bx - ax) * acc) / L, (y - 0.9) / 2, ay + ((by - ay) * acc) / L)
            p.deleteAttribute('uv')
            piers.push(p)
          }
          acc -= L
        } else strips.push(box(5, 0.05, y))
      }
      const add = (geos, mat, cast) => {
        if (!geos.length) return
        const m = new THREE.Mesh(mergeGeometries(geos), mat)
        m.castShadow = cast
        m.receiveShadow = cast
        if (!cast) m.renderOrder = 10
        this.group.add(m)
      }
      if (elevated) {
        add(strips, new THREE.MeshStandardMaterial({ color: '#b9bec6', roughness: 0.9 }), true)
        add(piers, new THREE.MeshStandardMaterial({ color: '#c4c8ce', roughness: 0.9 }), true)
        add(rails, new THREE.MeshStandardMaterial({ color: '#4a4f57', roughness: 0.6 }), false)
      } else add(strips, xray(line.color, 0.55), false)
    }

    // 车站（出入口亭、高铁站房、综合枢纽）在 stations.js 里画；布局按「有哪些线」自动分类
    this.group.add(buildStationMeshes(stationLayouts(this.stations, this.buildings)))
  }

  #buildTrainMeshes() {
    this.meshes = {}
    for (const kind of ['metro', 'rail']) {
      const sp = SPEC[kind]
      const geo = new THREE.BoxGeometry(sp.carLen - 1, sp.height, sp.width)
      geo.translate(0, sp.height / 2, 0)
      const mat = kind === 'metro'
        ? new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false })
        : new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 })
      const mesh = new THREE.InstancedMesh(geo, mat, 600)
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.castShadow = kind === 'rail'
      if (kind === 'metro') mesh.renderOrder = 12
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.setColorAt(0, new THREE.Color('#fff'))
      this.meshes[kind] = mesh
      this.group.add(mesh)
    }
  }

  // -------------------------------------------------------------------------
  // 运行
  // -------------------------------------------------------------------------
  #headway(line) { return headwayAt(line.kind, this.clock.timetable, this.clock.hour, this.tables) * 60 }

  #spawn(line, dir, s) {
    const stops = dir === 1 ? line.stops : [...line.stops].reverse()
    const idx = stops.findIndex((q) => (dir === 1 ? q.s > s + 1 : q.s < s - 1))
    this.trains.push({ line, dir, s, v: line.spec.vmax * 0.6, stops, idx: idx < 0 ? stops.length : idx, dwell: 0 })
  }

  /** 开场 / 跳时间之后: 按当前间隔把线路上铺满车，相当于「一直在按这张时刻表运行」 */
  #populate() {
    this.trains = []
    for (const line of this.lines) {
      const hw = this.#headway(line)
      line.next = { 1: this.clock.t / 1000, [-1]: this.clock.t / 1000 + hw / 2 }
      if (!hw) continue
      const gap = hw * line.spec.vmax * 0.62 // 算上停站，平均速度大约是最高速度的六成
      for (const dir of [1, -1]) for (let s = (dir === 1 ? 0.3 : 0.8) * gap; s < line.len; s += gap) this.#spawn(line, dir, dir === 1 ? s : line.len - s)
    }
  }

  update(dt, write = true) {
    const now = this.clock.t / 1000
    for (const line of this.lines) {
      const hw = this.#headway(line)
      for (const dir of [1, -1]) {
        if (hw && now >= line.next[dir]) { this.#spawn(line, dir, dir === 1 ? 0 : line.len); line.next[dir] = now + hw }
        else if (!hw) line.next[dir] = now
      }
    }
    for (const t of this.trains) {
      const sp = t.line.spec
      if (t.dwell > 0) { t.dwell -= dt; continue }
      const stop = t.stops[t.idx]
      const toStop = stop ? Math.abs(stop.s - t.s) : Infinity
      const want = Math.min(sp.vmax, Math.sqrt(2 * sp.accel * Math.max(0, toStop - 0.5)) + 0.4)
      t.v += THREE.MathUtils.clamp(want - t.v, -sp.accel * 1.4 * dt, sp.accel * dt)
      const step = Math.min(t.v * dt, toStop)
      t.s += step * t.dir
      if (stop && toStop - step < 0.6) { // 到站
        t.s = stop.s
        t.v = 0
        t.dwell = sp.dwell
        t.idx++
        this.onArrive?.(stop.name, t.line)
      }
    }
    this.trains = this.trains.filter((t) => (t.dir === 1 ? t.s < t.line.len - 0.5 : t.s > 0.5) || t.dwell > 0)
    if (write) this.#write()
  }

  #write() {
    const count = { metro: 0, rail: 0 }
    const col = new THREE.Color()
    for (const t of this.trains) {
      const { line } = t, sp = line.spec, mesh = this.meshes[line.kind] || this.meshes.metro
      const y = line.kind === 'rail' ? RAIL_H + 0.2 : 1.0
      for (let k = 0; k < sp.cars; k++) {
        let s = t.s - t.dir * (k * sp.carLen + sp.carLen / 2)
        if (line.loop) s = ((s % line.len) + line.len) % line.len
        else if (s < 0 || s > line.len) continue
        const i = count[line.kind]++
        if (i >= 600) break
        const p = sample(line.pts, line.cum, s), o = i * 16, a = mesh.instanceMatrix.array
        a[o] = p.dx; a[o + 1] = 0; a[o + 2] = p.dy; a[o + 3] = 0
        a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0
        a[o + 8] = -p.dy; a[o + 9] = 0; a[o + 10] = p.dx; a[o + 11] = 0
        a[o + 12] = p.x; a[o + 13] = y; a[o + 14] = p.y; a[o + 15] = 1
        mesh.setColorAt(i, col.set(line.kind === 'rail' ? (k === 0 || k === sp.cars - 1 ? '#f4f5f7' : '#e3e6ea') : line.color))
      }
    }
    for (const kind of ['metro', 'rail']) {
      const m = this.meshes[kind]
      m.count = count[kind]
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    }
  }

  stats() {
    const by = {}
    for (const t of this.trains) by[t.line.id] = (by[t.line.id] || 0) + 1
    return { trains: by, timetable: this.clock.timetable, headwayMin: Object.fromEntries(this.lines.map((l) => [l.id, this.#headway(l) / 60])) }
  }

  dispose() {
    this.unsub?.()
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose() })
  }
}

function sample(pts, cum, s) {
  let i = 1
  while (i < cum.length - 1 && cum[i] < s) i++
  const a = pts[i - 1], b = pts[i], l = cum[i] - cum[i - 1] || 1
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / l))
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / l, dy: (b[1] - a[1]) / l }
}

function project(pts, cum, p) {
  let best = Infinity, bs = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)
    if (d < best) { best = d; bs = cum[i - 1] + Math.sqrt(l2) * t }
  }
  return bs
}
