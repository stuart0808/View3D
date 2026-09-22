// 轨道交通: 地铁（地下，用「透视叠加」的方式画线路/车站/列车）和铁路（高架桥，实体）。
// 列车按时刻表发车: 两类交通各有「工作日 / 节假日」两套时刻表，由仿真时钟决定用哪一套、此刻的发车间隔是多少。
// 核心区里的车站有出入口: 列车到站时乘客成批涌出，人群也会把车站当作离开的出口。
//
// 数据来源: scene.transit.lines（脚本从 sidecar 换算成米）: { id, name, kind: 'metro'|'rail', color, loop, points, stations }
// 运行模型: 每条线两个方向各自按发车间隔从端点放车（环线从 s=0 起），列车沿折线按弧长前进，
//   到站减速停 dwell 秒再走，到末端消失。没有信号闭塞，只靠间隔保证不追尾。
// 画法: 地铁在地下 → 线路、站点圆环、列车都用不做深度测试的材质「透过地面」显示；
//   铁路是实体高架桥（桥面 / 桥墩 / 钢轨），列车是实体盒子。车站模型见 stations.js。
//
// 数据结构:
//   line   { id, name, kind, color, loop, pts(环线已闭合), cum(累计弧长), len, spec, stops[{name,pos,s}], next{1,-1}(两个方向下次发车的仿真秒) }
//   train  { line, dir(1 沿点序 / -1 反向), s(车头弧长), v, stops(按行驶方向排), idx(下一站下标), dwell(剩余停站秒) }
//   station{ name, pos, lines[], entrances[[x,y]] }  同名站合并 = 换乘站
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CURB_H } from './ground.js'

import { RAIL_H } from './roads.js'
import { stationLayouts, buildStationMeshes } from './stations.js'
export { RAIL_H }

/**
 * 时刻表: [起始小时, 发车间隔(分钟)]，间隔 0 = 停运。想换成真实时刻表，改这里或在 new Transit 时传 timetables。
 * 地铁工作日: 5:30 首班 8 分钟一班 → 早高峰 7~9:30 三分钟 → 平峰 6 分钟 → 晚高峰 → 22 点后 10 分钟 → 23:30 末班；
 * 节假日没有早晚高峰，全天 5 分钟。铁路同理但间隔更长。
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

/** 两类列车的运行参数: 最高速 (m/s)、加速度、停站时长 (s)、编组节数、每节长度、车厢宽高（米） */
const SPEC = {
  metro: { vmax: 17, accel: 1.0, dwell: 35, cars: 6, carLen: 19, width: 3.0, height: 3.4 }, // 地铁 B 型车: 61km/h、6 节、每节 19m
  rail: { vmax: 30, accel: 0.6, dwell: 120, cars: 8, carLen: 25, width: 3.3, height: 3.9 }, // 城际动车: 108km/h（示意）、8 节、每节 25m
}

/** 某类交通在某套时刻表的某个时刻的发车间隔（分钟），0 = 停运。取「起始小时 ≤ hour」的最后一行 */
export function headwayAt(kind, timetable, hour, tables = TIMETABLES) {
  let h = 0
  for (const [from, gap] of tables[kind][timetable]) if (hour >= from) h = gap // 表按起始小时升序，最后一个满足的生效
  return h
}

export class Transit {
  /**
   * @param nav    导航网格，车站出入口要落在人行道上
   * @param clock  仿真时钟: 决定用哪套时刻表、此刻的间隔；跳时间时重新铺车
   */
  constructor(scene, nav, clock, { timetables = TIMETABLES } = {}) {
    this.clock = clock
    // 时刻表可以整套替换（测试 / 接真实数据）
    this.tables = timetables
    this.group = new THREE.Group()
    this.group.name = 'transit'
    this.lines = (scene.transit?.lines || []).map((l) => this.#prepareLine(l)) // 没有 transit 字段就是空数组，整个模块静默
    this.buildings = scene.buildings || [] // 站前广场选边要看建筑
    this.trains = []
    this.onArrive = null // (stationName, line) => void，引擎挂上去让人群从车站涌出
    this.#buildStations(nav)
    this.#buildTrack()
    this.#buildTrainMeshes()
    // 跳时间时按新时刻重新铺车；dispose 时取消订阅
    this.unsub = clock.on((ev) => ev === 'jump' && this.#populate())
    this.#populate()
  }

  /** 线路预处理: 环线首尾相接；算折线累计弧长 cum；每个车站投影到线上得到弧长位置 s，按 s 排序 */
  #prepareLine(l) {
    const pts = l.loop ? [...l.points, l.points[0]] : l.points // 环线补上回到起点的一段
    const cum = [0] // cum[i] = 到第 i 个点的弧长
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    const line = { ...l, pts, cum, len: cum[cum.length - 1], spec: SPEC[l.kind] || SPEC.metro, next: { 1: 0, [-1]: 0 } } // 未知 kind 按地铁处理
    line.stops = l.stations.map((st) => ({ name: st.name, pos: st.pos, s: project(pts, cum, st.pos) })).sort((a, b) => a.s - b.s) // 车站投影到线上，按弧长排
    return line
  }

  /** 同名车站是换乘站，只建一次。落在导航网格里的站生成 1~2 个地面出入口，供人群当作出入口用 */
  #buildStations(nav) {
    this.stations = new Map()
    for (const line of this.lines) { // 按站名归并，记下经过的线
      for (const st of line.stops) {
        let rec = this.stations.get(st.name)
        if (!rec) this.stations.set(st.name, (rec = { name: st.name, pos: st.pos, lines: [], entrances: [] }))
        rec.lines.push(line)
      }
    }
    for (const st of this.stations.values()) {
      const seen = new Set() // 同一格不重复
      for (const [dx, dy] of [[22, 14], [-22, -14], [14, -22], [-14, 22]]) { // 站点四周约 26m 处试四个方向
        // 站点压在核心区边界上（比如正好在边界那条主干路底下）也算: 就近 60m 内找得到人行道就设出入口
        const cell = nav.nearestWalkable(st.pos[0] + dx, st.pos[1] + dy, nav.contains(st.pos[0], st.pos[1]) ? 40 : 60)
        if (cell < 0 || seen.has(cell) || st.entrances.length >= 2) continue // 找不到人行道 / 重复 / 已有两个
        seen.add(cell)
        st.entrances.push(nav.center(cell)) // 格中心坐标
      }
    }
  }

  /** 给人群用的出入口: [{ pos, weight, station }] */
  portals() {
    const out = []
    for (const st of this.stations.values()) for (const p of st.entrances) out.push({ pos: p, weight: 3 * st.lines.length, station: st.name }) // 换乘站权重翻倍，人群更爱走那里
    return out
  }

  // -------------------------------------------------------------------------
  // 线路、车站的网格
  // -------------------------------------------------------------------------
  /**
   * 线路的网格。地铁: 一条 5m 宽的透视色带贴在 0.7m 高（透过地面看到）；
   * 铁路: 10m 宽桥面 + 四根钢轨 + 每 30m 一根桥墩，标高 RAIL_H。之后把车站模型一起挂上。
   */
  #buildTrack() {
    const xray = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false }) // 不测深度 = 透过一切显示；不做色调映射保持线路色鲜艳
    for (const line of this.lines) {
      const elevated = line.kind === 'rail' // 铁路走高架，地铁在地下
      const y = elevated ? RAIL_H : 0.7 // 地铁色带画在 0.7m，压在地面之上但被楼挡住的地方靠 xray 透出来
      const strips = [], piers = [], rails = [] // 桥面 / 桥墩 / 钢轨
      let acc = 12 // 到下一根桥墩的距离，第一根离起点 12m
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const [ax, ay] = line.pts[i], [bx, by] = line.pts[i + 1]
        const L = Math.hypot(bx - ax, by - ay)
        if (L < 0.2) continue
        const ang = Math.atan2(-(by - ay), bx - ax)
        // 沿这一段折线放一个盒子: w 宽、h 高、中心高 yc、横向偏移 side
        const box = (w, h, yc, side = 0) => {
          const g = new THREE.BoxGeometry(L + 0.3, h, w).toNonIndexed()
          g.translate(0, 0, side)
          g.rotateY(ang)
          g.translate((ax + bx) / 2, yc, (ay + by) / 2)
          g.deleteAttribute('uv')
          return g
        }
        if (elevated) {
          strips.push(box(10, 0.9, y - 0.45)) // 10m 宽、0.9m 厚的桥面板，顶面 = RAIL_H
          for (const sd of [-2.6, -1.1, 1.1, 2.6]) rails.push(box(0.16, 0.18, y + 0.09, sd)) // 双线四根钢轨，轨距 1.5m、线间距 3.7m
          for (; acc < L; acc += 30) {
            const p = new THREE.BoxGeometry(2.2, y - 0.9, 3.2).toNonIndexed() // 桥墩: 从地面顶到桥面板底
            p.rotateY(ang)
            p.translate(ax + ((bx - ax) * acc) / L, (y - 0.9) / 2, ay + ((by - ay) * acc) / L)
            p.deleteAttribute('uv')
            piers.push(p)
          }
          acc -= L
        } else strips.push(box(5, 0.05, y)) // 地铁: 5m 宽的薄色带
      }
      // 合并成一个网格；透视材质的不投影，并排在后面画
      const add = (geos, mat, cast) => {
        if (!geos.length) return
        const m = new THREE.Mesh(mergeGeometries(geos), mat)
        m.castShadow = cast
        m.receiveShadow = cast
        if (!cast) m.renderOrder = 10
        this.group.add(m)
      }
      if (elevated) {
        add(strips, new THREE.MeshStandardMaterial({ color: '#b9bec6', roughness: 0.9 }), true) // 桥面浅灰
        add(piers, new THREE.MeshStandardMaterial({ color: '#c4c8ce', roughness: 0.9 }), true)
        add(rails, new THREE.MeshStandardMaterial({ color: '#4a4f57', roughness: 0.6 }), false) // 钢轨深灰，不投影
      } else add(strips, xray(line.color, 0.55), false) // 地铁色带半透明
    }

    // 车站（出入口亭、高铁站房、综合枢纽）在 stations.js 里画；布局按「有哪些线」自动分类
    this.group.add(buildStationMeshes(stationLayouts(this.stations, this.buildings)))
  }

  /** 两类列车各一个 InstancedMesh（最多 600 节车厢），地铁用透视材质 */
  #buildTrainMeshes() {
    this.meshes = {}
    for (const kind of ['metro', 'rail']) {
      const sp = SPEC[kind]
      const geo = new THREE.BoxGeometry(sp.carLen - 1, sp.height, sp.width) // 车厢之间留 1m 缝
      geo.translate(0, sp.height / 2, 0) // 底面在 y=0
      const mat = kind === 'metro'
        ? new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false })
        : new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 })
      const mesh = new THREE.InstancedMesh(geo, mat, 600) // 最多 600 节车厢
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.castShadow = kind === 'rail' // 地下的车不投影
      if (kind === 'metro') mesh.renderOrder = 12 // 在线路色带（10）之后画
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage) // 每帧更新
      mesh.setColorAt(0, new THREE.Color('#fff')) // 先 setColorAt 一次，instanceColor 缓冲才会被创建
      this.meshes[kind] = mesh
      this.group.add(mesh)
    }
  }

  // -------------------------------------------------------------------------
  // 运行
  // -------------------------------------------------------------------------
  /** 这条线此刻的发车间隔（秒） */
  #headway(line) { return headwayAt(line.kind, this.clock.timetable, this.clock.hour, this.tables) * 60 }

  /** 在弧长 s 处放一列车。dir=1 沿点序、-1 反向；stops 按行驶方向排好，idx 指向下一个要停的站 */
  #spawn(line, dir, s) {
    const stops = dir === 1 ? line.stops : [...line.stops].reverse() // 反向行驶时站序也反过来
    const idx = stops.findIndex((q) => (dir === 1 ? q.s > s + 1 : q.s < s - 1)) // 第一个在前方 1m 以外的站
    this.trains.push({ line, dir, s, v: line.spec.vmax * 0.6, stops, idx: idx < 0 ? stops.length : idx, dwell: 0 }) // 初速六成；前方没站了 idx 越界，之后一路开到底
  }

  /** 开场 / 跳时间之后: 按当前间隔把线路上铺满车，相当于「一直在按这张时刻表运行」 */
  #populate() {
    this.trains = []
    for (const line of this.lines) {
      const hw = this.#headway(line)
      line.next = { 1: this.clock.t / 1000, [-1]: this.clock.t / 1000 + hw / 2 } // 两个方向错开半个间隔发车
      if (!hw) continue // 停运时段: 线上没车
      const gap = hw * line.spec.vmax * 0.62 // 算上停站，平均速度大约是最高速度的六成
      for (const dir of [1, -1]) for (let s = (dir === 1 ? 0.3 : 0.8) * gap; s < line.len; s += gap) this.#spawn(line, dir, dir === 1 ? s : line.len - s) // 两个方向的相位也错开
    }
  }

  /** 推进 dt 仿真秒: 到点发车 → 每列车加减速 / 停站 / 到站回调 → 出线的车删掉 → 写实例矩阵 */
  update(dt, write = true) {
    const now = this.clock.t / 1000
    // 发车: 每个方向到点就在端点放一列；停运时段把「下次发车」贴着 now 走，恢复运营时立刻发车
    for (const line of this.lines) {
      const hw = this.#headway(line)
      for (const dir of [1, -1]) {
        if (hw && now >= line.next[dir]) { this.#spawn(line, dir, dir === 1 ? 0 : line.len); line.next[dir] = now + hw }
        else if (!hw) line.next[dir] = now
      }
    }
    for (const t of this.trains) {
      const sp = t.line.spec
      if (t.dwell > 0) { t.dwell -= dt; continue } // 停站中: 只倒计时
      // 目标速度: 离下一站还有 toStop 米时，按 v² = 2·a·s 的刹车曲线限速，停站前刚好减到 0
      const stop = t.stops[t.idx] // 下一站；没有了就是 undefined
      const toStop = stop ? Math.abs(stop.s - t.s) : Infinity
      const want = Math.min(sp.vmax, Math.sqrt(2 * sp.accel * Math.max(0, toStop - 0.5)) + 0.4) // +0.4 保证最后半米也能挪过去
      t.v += THREE.MathUtils.clamp(want - t.v, -sp.accel * 1.4 * dt, sp.accel * dt) // 制动比牵引猛 40%
      const step = Math.min(t.v * dt, toStop) // 不会冲过站
      t.s += step * t.dir
      if (stop && toStop - step < 0.6) { // 到站
        t.s = stop.s // 对齐到站点
        t.v = 0
        t.dwell = sp.dwell // 开始停站计时
        t.idx++ // 下一站
        this.onArrive?.(stop.name, t.line) // 通知引擎放乘客
      }
    }
    // 到线路末端的车消失（环线的 s 在 #write 里取模，永远不会出线）
    this.trains = this.trains.filter((t) => (t.dir === 1 ? t.s < t.line.len - 0.5 : t.s > 0.5) || t.dwell > 0)
    if (write) this.#write()
  }

  /** 把每列车的每节车厢写成一个实例: 沿线路弧长倒推每节的位置和朝向；环线取模，非环线出线的车厢不画 */
  #write() {
    const count = { metro: 0, rail: 0 }
    const col = new THREE.Color()
    for (const t of this.trains) {
      const { line } = t, sp = line.spec, mesh = this.meshes[line.kind] || this.meshes.metro
      const y = line.kind === 'rail' ? RAIL_H + 0.2 : 1.0 // 铁路车厢坐在钢轨上；地铁略高于色带
      for (let k = 0; k < sp.cars; k++) {
        let s = t.s - t.dir * (k * sp.carLen + sp.carLen / 2) // 第 k 节的中心: 从车头往后退
        if (line.loop) s = ((s % line.len) + line.len) % line.len // 环线回绕
        else if (s < 0 || s > line.len) continue // 还没进线 / 已经出线的车厢不画
        const i = count[line.kind]++
        if (i >= 600) break // 实例上限
        // 4x4 矩阵: 车厢局部 X 沿线路切向 (dx, dy)，不缩放
        const p = sample(line.pts, line.cum, s), o = i * 16, a = mesh.instanceMatrix.array
        a[o] = p.dx; a[o + 1] = 0; a[o + 2] = p.dy; a[o + 3] = 0
        a[o + 4] = 0; a[o + 5] = 1; a[o + 6] = 0; a[o + 7] = 0
        a[o + 8] = -p.dy; a[o + 9] = 0; a[o + 10] = p.dx; a[o + 11] = 0
        a[o + 12] = p.x; a[o + 13] = y; a[o + 14] = p.y; a[o + 15] = 1
        // 铁路列车白色、首尾车厢更亮；地铁按线路色
        mesh.setColorAt(i, col.set(line.kind === 'rail' ? (k === 0 || k === sp.cars - 1 ? '#f4f5f7' : '#e3e6ea') : line.color))
      }
    }
    for (const kind of ['metro', 'rail']) {
      const m = this.meshes[kind]
      m.count = count[kind] // 只画写了的那些
      m.instanceMatrix.needsUpdate = true
      if (m.instanceColor) m.instanceColor.needsUpdate = true // 颜色随线路变，也要重传
    }
  }

  /** 给界面: 各线在途列车数、当前时刻表、各线发车间隔（分钟） */
  stats() {
    const by = {} // 线路 id → 在途列车数
    for (const t of this.trains) by[t.line.id] = (by[t.line.id] || 0) + 1
    return { trains: by, timetable: this.clock.timetable, headwayMin: Object.fromEntries(this.lines.map((l) => [l.id, this.#headway(l) / 60])) }
  }

  /** 取消时钟订阅并释放几何体 / 材质 */
  dispose() {
    this.unsub?.()
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose() })
  }
}

/** 折线上弧长 s 处的点和切向 */
function sample(pts, cum, s) {
  let i = 1
  while (i < cum.length - 1 && cum[i] < s) i++ // 找到 s 所在的段（线性扫描，点数不多）
  const a = pts[i - 1], b = pts[i], l = cum[i] - cum[i - 1] || 1
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / l)) // 段内参数，夹到 [0,1]（s 超出线路时停在端点）
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / l, dy: (b[1] - a[1]) / l }
}

/** 点 p 投影到折线上，返回最近点的弧长 */
function project(pts, cum, p) {
  let best = Infinity, bs = 0 // 最近距离、对应弧长
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) // 投影参数，夹到线段内
    const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)
    if (d < best) { best = d; bs = cum[i - 1] + Math.sqrt(l2) * t } // 更近就记下弧长
  }
  return bs
}
