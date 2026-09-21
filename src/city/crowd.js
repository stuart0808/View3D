// 人群: 出入口生成 → 逛几家店（进门、停留、出门）→ 从出入口离开。
// 这是「示意性」仿真: 后端只需给聚合量（总人数、各建筑吸引力），小人的具体路径由前端生成。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { UNREACHABLE, SURFACE } from './navgrid.js'
import { signedArea, interiorPoints } from './geometry.js'
import { CURB_H } from './ground.js'
import { GROUPS } from './demand.js'

const FREE = 0, WALK = 1, ENTER = 2, INSIDE = 3, EXIT = 4, IDLE = 5 // IDLE: 在公园/广场里站着歇会儿
const PALETTE = ['#f5f5f4', '#f5f5f4', '#e7e5e4', '#d6d3d1', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1f2937', '#1f2937', '#9a6b4b', '#3b5b8c']

export function personGeometry() {
  const body = new THREE.CapsuleGeometry(0.2, 0.95, 3, 8)
  body.scale(1.25, 1, 0.9)
  body.translate(0, 0.68, 0)
  const head = new THREE.SphereGeometry(0.17, 10, 8)
  head.translate(0, 1.56, 0)
  const geo = mergeGeometries([body, head])
  // 下半身压暗一点，远看有「上衣 + 裤子」的层次
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const v = pos.getY(i) < 0.72 ? 0.55 : 1
    colors.set([v, v, v], i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geo
}

export const PEOPLE_PALETTE = PALETTE

export class Crowd {
  constructor(scene, nav, rand, { capacity = 4000, peopleScale = 1.5, signals = null, demand = null } = {}) {
    this.nav = nav
    this.demand = demand // 需求模型（人群分组 + 场馆活动）。为 null 时退回「随机逛几家店」的老逻辑
    this.base = 600 // 高峰人数；有需求模型时，实际应有人数由它按时刻算
    this.groupActive = GROUPS.map(() => 0)
    this.groupTargets = GROUPS.map(() => 0)
    this._demandTimer = 0
    this.colorsDirty = false
    this.signals = signals
    this.rand = rand
    this.capacity = capacity
    this.peopleScale = peopleScale
    this.population = 600
    this.dwellScale = 1
    this.shopRatio = 0.8 // 进店逛的人占比，其余是纯路过
    this.high = 0 // 已用到的最大槽位
    this.active = 0
    this.insideCount = 0
    this.ready = false
    this.spawnDebt = 0

    const n = capacity
    this.state = new Uint8Array(n)
    this.x = new Float32Array(n); this.y = new Float32Array(n)
    this.vx = new Float32Array(n); this.vy = new Float32Array(n)
    this.speed = new Float32Array(n)
    this.lane = new Float32Array(n)
    this.dest = new Int16Array(n)
    this.stops = new Uint8Array(n)
    this.timer = new Float32Array(n)
    this.phase = new Float32Array(n)
    this.scale = new Float32Array(n)
    this.hx = new Float32Array(n); this.hy = new Float32Array(n) // 在店内时的热力落点
    this.door = new Uint8Array(n) // 进的是这栋楼的第几扇门
    this.group = new Uint8Array(n) // 属于哪类人群（GROUPS 的下标）
    this.afterEvent = new Uint8Array(n) // 刚看完演出出来: 下一步多半是回家
    this.ex = new Float32Array(n); this.ey = new Float32Array(n) // 出门后先走到的门外落脚点
    this.heatSamples = new Float32Array(n * 3)
    this.heatCount = 0

    this.#buildDestinations(scene)
    this.#buildMesh()

    // 邻域查询用的哈希网格
    this.hashCell = 1.6
    this.hashCols = Math.ceil((nav.cols * nav.cell) / this.hashCell) + 1
    this.hashRows = Math.ceil((nav.rows * nav.cell) / this.hashCell) + 1
    this.hashHead = new Int32Array(this.hashCols * this.hashRows)
    this.hashNext = new Int32Array(n)
    this._la = [0, 0, 0]
  }

  #buildDestinations(scene) {
    const nav = this.nav
    const byId = new Map(scene.buildings.map((b) => [b.id, b]))
    const doorCount = new Map()
    for (const d of scene.doors || []) doorCount.set(d.building, (doorCount.get(d.building) || 0) + 1)

    this.buildings = new Map()
    for (const b of scene.buildings) {
      this.buildings.set(b.id, {
        attraction: b.attraction ?? 1,
        area: Math.abs(signedArea(b.polygon)),
        interior: interiorPoints(b.polygon, b.holes || [], 40, this.rand),
        visitors: 0,
      })
    }

    // 目的地按「楼」建，而不是按「门」: 一栋楼的所有门共用一张多源距离场，人自然会走向离自己最近的那扇门。
    // 城区里几百扇门，每扇门一张场的话内存和预热时间都撑不住。
    this.dests = []
    const byBuilding = new Map()
    for (const d of scene.doors || []) {
      if (!byId.has(d.building)) continue
      const cell = nav.nearestWalkable(d.pos[0] + d.normal[0] * 1.6, d.pos[1] + d.normal[1] * 1.6, 8)
      if (cell < 0) continue
      if (!byBuilding.has(d.building)) byBuilding.set(d.building, [])
      byBuilding.get(d.building).push({ x: d.pos[0], y: d.pos[1], cell, c: nav.center(cell) })
    }
    for (const [id, doors] of byBuilding) {
      const CAT = { shop: 'shop', block: 'office', residential: 'home', venue: 'venue' }
      this.dests.push({ type: 'door', building: id, kind: byId.get(id).kind, cat: CAT[byId.get(id).kind] || 'shop', enRoute: 0, doors, cells: doors.map((q) => q.cell), x: doors[0].x, y: doors[0].y, c: doors[0].c, field: null, weight: 0 })
    }
    for (const p of scene.portals || []) {
      const cell = nav.nearestWalkable(p.pos[0], p.pos[1], 25)
      if (cell < 0) continue
      this.dests.push({ type: 'portal', x: p.pos[0], y: p.pos[1], cell, c: nav.center(cell), field: null, weight: p.weight ?? 1, station: p.station || null, queue: 0 })
    }
    // 公园、广场里撒一些「歇脚点」，人会走过去站一会儿再走
    for (const a of scene.areas || []) {
      if (a.kind !== 'park' && a.kind !== 'plaza') continue
      const area = Math.abs(signedArea(a.polygon))
      const n = Math.max(2, Math.min(10, Math.round(area / 450)))
      const pts = interiorPoints(a.polygon, a.holes || [], n * 4, this.rand).filter(([x, y]) => nav.isWalkable(x, y)).slice(0, n)
      for (const [x, y] of pts) {
        const cell = nav.index(x, y)
        this.dests.push({ type: 'spot', cat: a.kind, x, y, cell, c: nav.center(cell), field: null, weight: ((area / 1000) * (a.kind === 'park' ? 0.8 : 0.5)) / pts.length })
      }
    }
    // 「逛」的目的地 = 店门 + 歇脚点
    this.doors = this.dests.map((d, i) => (d.type !== 'portal' ? i : -1)).filter((i) => i >= 0)
    this.portals = this.dests.map((d, i) => (d.type === 'portal' ? i : -1)).filter((i) => i >= 0)
    this.byCat = {}
    this.dests.forEach((d, i) => { if (d.cat) (this.byCat[d.cat] ||= []).push(i) })
    this.pendingFields = this.dests.map((_, i) => i)
    this.#refreshWeights()
  }

  #refreshWeights() {
    for (const d of this.dests) {
      if (d.type !== 'door') continue
      const b = this.buildings.get(d.building)
      d.weight = b.attraction * (b.area / 1000)
    }
  }

  /** { 建筑id: 吸引力 }，接后端算出来的各店客流/消费权重 */
  setAttraction(map) {
    for (const [id, v] of Object.entries(map)) {
      const b = this.buildings.get(id)
      if (b) b.attraction = v
    }
    this.#refreshWeights()
  }

  #buildMesh() {
    const geo = personGeometry()
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, vertexColors: true })
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity)
    this.mesh.name = 'crowd'
    this.mesh.count = 0
    this.mesh.castShadow = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const c = (this._col = new THREE.Color())
    for (let i = 0; i < this.capacity; i++) this.mesh.setColorAt(i, c.set(PALETTE[(this.rand() * PALETTE.length) | 0]))
  }

  /** 每帧花几毫秒算距离场，算完之前不出人，避免首帧卡死 */
  #warmup(budgetMs = 12) {
    const t0 = performance.now()
    while (this.pendingFields.length && performance.now() - t0 < budgetMs) {
      const i = this.pendingFields.pop()
      this.dests[i].field = this.nav.buildField(this.dests[i].cells || this.dests[i].cell)
    }
    if (this.pendingFields.length) return false
    // 预热: 直接把人撒在半路上，开场就是热闹的
    const ref = this.portals.length ? this.dests[this.portals[0]].field : null
    this.reachable = []
    if (ref) for (let k = 0; k < ref.length; k++) if (ref[k] !== UNREACHABLE && this.nav.penalty[k] < 1) this.reachable.push(k)
    this.#refreshDemand(true)
    const n = Math.min(this.population, this.capacity)
    for (let i = 0; i < n && this.reachable.length; i++) {
      const k = this.reachable[(this.rand() * this.reachable.length) | 0]
      const [x, y] = this.nav.center(k)
      this.#spawn(x, y, true)
    }
    this.ready = true
    return true
  }

  #pick(list, x, y, exclude = -1) {
    // 按 权重 × 距离衰减 抽一个当前位置可达的目的地
    let total = 0
    const w = this._w || (this._w = new Float32Array(this.dests.length))
    for (const i of list) {
      const d = this.dests[i]
      w[i] = 0
      if (i === exclude || !d.field) continue
      const dist = this.nav.distanceAt(d.field, x, y)
      if (dist === Infinity) continue
      w[i] = d.weight * (d.type !== 'portal' ? Math.exp(-dist / 140) : 1) + 1e-6
      total += w[i]
    }
    if (total <= 0) return -1
    let r = this.rand() * total
    for (const i of list) {
      r -= w[i]
      if (r <= 0 && w[i] > 0) return i
    }
    return -1
  }

  #free(i) {
    this.state[i] = FREE
    this.active--
    this.groupActive[this.group[i]]--
  }

  /**
   * 选下一站。有需求模型时: 先按「所属人群 × 当前时段」的偏好抽一个活动类别，再在这一类里按吸引力和距离抽具体地点。
   * 场馆只在活动进场时段可选，权重随「还差多少观众」变化；刚散场出来的人多半直接回家。
   */
  #chooseNext(i, x, y, exclude = -1) {
    if (!this.demand) return -2
    const mix = { ...(this.afterEvent[i] ? { leave: 8, shop: 2 } : this.demand.mix(this.group[i])) }
    this.afterEvent[i] = 0
    delete mix.venue
    for (const di of this.byCat.venue || []) {
      const d = this.dests[di], ph = this.demand.phaseOf(d.building)
      d.open = false
      if (!ph || ph.phase !== 'ingress') continue
      // 「此刻应该已经到场的人数」随进场进度增长（开场前 75 分钟开始，越临近越多），还差多少就有多大吸引力
      const need = ph.ev.attendance * Math.min(1, ph.progress * 1.15 + 0.05) - this.buildings.get(d.building).visitors - d.enRoute
      if (need <= 0) continue
      d.open = true
      mix.venue = (mix.venue || 0) + 60 * (need / ph.ev.attendance)
    }
    let total = 0
    for (const [cat, wgt] of Object.entries(mix)) { if (cat !== 'leave' && !(this.byCat[cat] || []).length) mix[cat] = 0; else total += wgt }
    let r = this.rand() * total, chosen = 'leave'
    for (const [cat, wgt] of Object.entries(mix)) { r -= wgt; if (wgt > 0 && r <= 0) { chosen = cat; break } }
    if (chosen === 'leave') return this.#pick([...this.portals, ...(this.byCat.home || [])], x, y)
    const list = chosen === 'venue' ? this.byCat.venue.filter((di) => this.dests[di].open) : this.byCat[chosen]
    const got = this.#pick(list, x, y, exclude)
    if (got >= 0 && this.dests[got].cat === 'venue') this.dests[got].enRoute++
    return got >= 0 ? got : this.#pick(this.portals, x, y)
  }

  #spawn(x, y, midway = false) {
    let i = 0
    while (i < this.capacity && this.state[i] !== FREE) i++
    if (i >= this.capacity) return -1
    let dest
    if (this.demand) {
      // 进场的是哪类人: 缺口最大的那一类；各类都不缺（多出来的是活动观众）就按观众构成抽
      let g = 0, best = -Infinity
      this.groupTargets.forEach((t, k) => { const gap = t - this.groupActive[k]; if (gap > best) { best = gap; g = k } })
      if (best <= 0) { const r = this.rand(); g = r < 0.35 ? 0 : r < 0.8 ? 2 : r < 0.95 ? 3 : 1 }
      this.group[i] = g
      this.afterEvent[i] = 0
      dest = this.#chooseNext(i, x, y)
      if (midway && dest >= 0 && this.dests[dest].type === 'portal') dest = this.#chooseNext(i, x, y) // 铺场时少放一些「正要走」的人
      const pal = GROUPS[g].colors
      this.mesh.setColorAt(i, this._col.set(pal[(this.rand() * pal.length) | 0]))
      this.colorsDirty = true
    } else {
      const shopper = this.rand() < this.shopRatio && this.doors.length > 0
      this.stops[i] = shopper ? 1 + ((this.rand() * 3) | 0) : 0
      if (midway && shopper && this.rand() < 0.5) this.stops[i] = Math.max(0, this.stops[i] - 1)
      dest = this.stops[i] > 0 ? this.#pick(this.doors, x, y) : this.#pick(this.portals, x, y)
    }
    if (dest < 0) return -1
    this.state[i] = WALK
    this.x[i] = x + (this.rand() - 0.5) * 0.6
    this.y[i] = y + (this.rand() - 0.5) * 0.6
    this.vx[i] = this.vy[i] = 0
    this.speed[i] = 1.15 + this.rand() * 0.45
    this.lane[i] = (this.rand() * 2 - 1) * 1.7
    this.dest[i] = dest
    this.phase[i] = this.rand() * 6.28
    this.scale[i] = midway ? 1 : 0
    this.high = Math.max(this.high, i + 1)
    this.active++
    this.groupActive[this.group[i]]++
    // 铺场（开场 / 跳时间）: 此刻大部分上班族在楼里、观众在场馆里，不该全撒在街上
    const d = this.dests[dest]
    if (midway && this.demand && d.type === 'door' && d.cat !== 'home' && this.rand() < (d.cat === 'office' ? 0.85 : d.cat === 'venue' ? 0.9 : 0.45)) {
      if (d.cat === 'venue') d.enRoute = Math.max(0, d.enRoute - 1)
      this.door[i] = (this.rand() * d.doors.length) | 0
      this.#goInside(i, d)
      this.timer[i] *= 0.15 + this.rand() * 0.85
    }
    return i
  }

  #arrive(i) {
    const d = this.dests[this.dest[i]]
    if (d.type === 'portal') return this.#free(i)
    if (d.cat === 'venue') d.enRoute = Math.max(0, d.enRoute - 1)
    if (d.type === 'spot') {
      this.state[i] = IDLE
      this.vx[i] = this.vy[i] = 0
      this.timer[i] = (8 + this.rand() * 25) * 60 * this.dwellScale // 在公园/广场歇 8~33 分钟
      return
    }
    let best = 0, bd = Infinity
    d.doors.forEach((q, k) => { const dd = (q.x - this.x[i]) ** 2 + (q.y - this.y[i]) ** 2; if (dd < bd) { bd = dd; best = k } })
    this.door[i] = best
    this.state[i] = ENTER
    this.timer[i] = 0.45
  }

  /** 离开当前停留点（店或歇脚点），去下一站 */
  #leaveShop(i) {
    const d = this.dests[this.dest[i]]
    const wasInside = d.type === 'door'
    if (wasInside) {
      const b = this.buildings.get(d.building)
      b.visitors = Math.max(0, b.visitors - 1)
      this.insideCount--
    }
    this.stops[i] = Math.max(0, this.stops[i] - 1)
    const from = wasInside ? d.doors[this.door[i]].c : d.c
    let next = this.#chooseNext(i, from[0], from[1], this.dest[i])
    if (next === -2) next = this.stops[i] > 0 ? this.#pick(this.doors, from[0], from[1], this.dest[i]) : this.#pick(this.portals, from[0], from[1])
    if (next < 0) return this.#free(i)
    this.dest[i] = next
    if (!wasInside) { this.state[i] = WALK; return }
    this.state[i] = EXIT
    this.timer[i] = 0.45
    const dq = d.doors[this.door[i]]
    this.x[i] = dq.x; this.y[i] = dq.y
    this.ex[i] = dq.c[0]; this.ey[i] = dq.c[1]
  }

  /** 有需求模型时: 各人群的应有人数 + 活动观众 = 总应有人数 */
  #refreshDemand(force = false) {
    this._demandTimer = 20 // 仿真秒
    if (!this.demand) return
    this.groupTargets = this.demand.targets(this.base)
    this.population = this.groupTargets.reduce((a, b) => a + b, 0) + this.demand.eventExtra()
  }

  /** 手动跳时间之后: 清空所有人，按当前目标人数重新撒一遍 */
  reseed() {
    this.state.fill(FREE)
    this.high = this.active = this.insideCount = 0
    this.groupActive.fill(0)
    for (const d of this.dests) if (d.enRoute) d.enRoute = 0
    for (const b of this.buildings.values()) b.visitors = 0
    this.#refreshDemand(true)
    if (!this.ready) return
    const n = Math.min(this.population, this.capacity)
    for (let i = 0; i < n && this.reachable.length; i++) {
      const [px, py] = this.nav.center(this.reachable[(this.rand() * this.reachable.length) | 0])
      this.#spawn(px, py, true)
    }
    this.#writeInstances()
  }

  /** dt = 仿真秒。write=false 时只推进状态不写实例矩阵（一帧里有多个子步时，只有最后一步需要写） */
  update(dt, write = true) {
    if (!this.ready && !this.#warmup()) return
    const { nav, state, x, y, vx, vy } = this
    const la = this._la

    this._demandTimer -= dt
    if (this._demandTimer <= 0) this.#refreshDemand()

    // 维持目标人数
    const want = Math.min(this.population, this.capacity)
    if (this.active < want && this.portals.length) {
      this.spawnDebt += Math.min(40, (want - this.active) * 0.5 + 2) * dt
      while (this.spawnDebt >= 1) {
        this.spawnDebt -= 1
        const p = this.dests[this.#pickPortal()]
        this.#spawn(p.c[0], p.c[1])
      }
    }

    // 哈希网格
    this.hashHead.fill(-1)
    for (let i = 0; i < this.high; i++) {
      if (state[i] !== WALK) continue
      const h = this.#hash(x[i], y[i])
      this.hashNext[i] = this.hashHead[h]
      this.hashHead[h] = i
    }

    const steer = 1 - Math.exp(-dt * 5)
    this.heatCount = 0
    for (let i = 0; i < this.high; i++) {
      const s = state[i]
      if (s === FREE) continue
      const d = this.dests[this.dest[i]]

      if (s === INSIDE) {
        this.timer[i] -= dt
        const k = this.heatCount++ * 3
        this.heatSamples[k] = this.hx[i]; this.heatSamples[k + 1] = this.hy[i]; this.heatSamples[k + 2] = 1
        if (this.timer[i] <= 0) this.#leaveShop(i)
        continue
      }
      if (s === IDLE) {
        this.timer[i] -= dt
        if (this.timer[i] <= 0) this.#leaveShop(i)
        continue
      }
      if (s === ENTER || s === EXIT) {
        this.timer[i] -= dt
        const dq = d.doors ? d.doors[this.door[i]] : d
        const tx = s === ENTER ? dq.x : this.ex[i], ty = s === ENTER ? dq.y : this.ey[i]
        x[i] += (tx - x[i]) * Math.min(1, dt * 6)
        y[i] += (ty - y[i]) * Math.min(1, dt * 6)
        this.scale[i] = THREE.MathUtils.clamp(s === ENTER ? this.timer[i] / 0.45 : 1 - this.timer[i] / 0.45, 0, 1)
        if (this.timer[i] <= 0) {
          if (s === ENTER) this.#goInside(i, d)
          else state[i] = WALK
        }
        continue
      }

      // WALK
      this.scale[i] = Math.min(1, this.scale[i] + dt * 3)
      const look = nav.lookAhead(d.field, x[i], y[i], 5, la)
      if (!look) { this.#free(i); continue }
      if (la[2] < 1.4) { this.#arrive(i); continue }
      let gx = la[0] - x[i], gy = la[1] - y[i]
      let gl = Math.hypot(gx, gy) || 1
      if (la[2] > 6) {
        // 每人一条固定的横向偏移，让人流铺满人行道而不是排成一条线
        const ox = la[0] - (gy / gl) * this.lane[i], oy = la[1] + (gx / gl) * this.lane[i]
        if (nav.isWalkable(ox, oy)) { gx = ox - x[i]; gy = oy - y[i]; gl = Math.hypot(gx, gy) || 1 }
      }
      let ax = (gx / gl) * this.speed[i], ay = (gy / gl) * this.speed[i]

      // 分离
      const hc = Math.floor((x[i] - nav.minX) / this.hashCell), hr = Math.floor((y[i] - nav.minY) / this.hashCell)
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const c = hc + di, r = hr + dj
          if (c < 0 || r < 0 || c >= this.hashCols || r >= this.hashRows) continue
          for (let j = this.hashHead[r * this.hashCols + c]; j >= 0; j = this.hashNext[j]) {
            if (j === i) continue
            const dx = x[i] - x[j], dy = y[i] - y[j]
            const dd = dx * dx + dy * dy
            if (dd > 0.81 || dd < 1e-6) continue
            const dl = Math.sqrt(dd), f = ((0.9 - dl) / 0.9) * 2.2
            ax += (dx / dl) * f; ay += (dy / dl) * f
          }
        }
      }

      vx[i] += (ax - vx[i]) * steer
      vy[i] += (ay - vy[i]) * steer
      const nx = x[i] + vx[i] * dt, ny = y[i] + vy[i] * dt
      // 红灯: 正要从路沿踏上斑马线的人停下等；已经在路面上的继续走完
      if (this.signals) {
        const kn = nav.index(nx, ny)
        if (kn >= 0 && nav.cwIndex[kn] >= 0 && nav.surfaceAt(x[i], y[i]) !== SURFACE.ROAD && !this.signals.canWalk(nav.cwIndex[kn])) {
          vx[i] *= 0.5; vy[i] *= 0.5
          continue
        }
      }
      if (nav.isWalkable(nx, ny)) { x[i] = nx; y[i] = ny }
      else if (nav.isWalkable(nx, y[i])) { x[i] = nx; vy[i] *= 0.3 }
      else if (nav.isWalkable(x[i], ny)) { y[i] = ny; vx[i] *= 0.3 }
      else { vx[i] *= 0.2; vy[i] *= 0.2 }
      this.phase[i] += dt * 9 * this.speed[i]
    }
    if (write) this.#writeInstances()
  }

  #goInside(i, d) {
    if (d.cat === 'home' && this.demand) return this.#free(i) // 回到住处 = 离开仿真
    this.state[i] = INSIDE
    this.scale[i] = 0
    this.timer[i] = (5 + this.rand() * 20) * 60 * this.dwellScale // 逛一家店 5~25 分钟（仿真时间）
    if (this.demand && d.cat === 'office') this.timer[i] = this.demand.officeStay(this.rand)
    if (this.demand && d.cat === 'venue') {
      const ph = this.demand.phaseOf(d.building)
      // 观众待到散场，再花 0~20 分钟陆续走出来
      if (ph && ph.phase !== 'egress') { this.timer[i] = (ph.ev.end - this.demand.clock.t) / 1000 + this.rand() * 1200; this.afterEvent[i] = 1 }
    }
    const b = this.buildings.get(d.building)
    b.visitors++
    this.insideCount++
    // 热力落点: 取几个候选内点里离这扇门最近的，热区就会聚在对应店面后面
    const dq = d.doors[this.door[i]]
    let best = null, bestD = Infinity
    for (let t = 0; t < 4 && b.interior.length; t++) {
      const p = b.interior[(this.rand() * b.interior.length) | 0]
      const dd = (p[0] - dq.x) ** 2 + (p[1] - dq.y) ** 2
      if (dd < bestD) { bestD = dd; best = p }
    }
    this.hx[i] = best ? best[0] : dq.x
    this.hy[i] = best ? best[1] : dq.y
  }

  /** 列车到站: 这一站的出入口排上 n 个人，接下来进场的人优先从这里出来（成批涌出，而不是均匀地从各个口冒出来） */
  arrive(station, n) {
    const ps = this.portals.filter((i) => this.dests[i].station === station)
    for (const i of ps) this.dests[i].queue += n / ps.length
  }

  #pickPortal() {
    let qTotal = 0
    for (const i of this.portals) qTotal += Math.max(0, this.dests[i].queue)
    if (qTotal >= 1) {
      let r = this.rand() * qTotal
      for (const i of this.portals) {
        r -= Math.max(0, this.dests[i].queue)
        if (r <= 0) { this.dests[i].queue -= 1; return i }
      }
    }
    let total = 0
    for (const i of this.portals) total += this.dests[i].weight
    let r = this.rand() * total
    for (const i of this.portals) { r -= this.dests[i].weight; if (r <= 0) return i }
    return this.portals[0]
  }

  #hash(px, py) {
    const c = Math.max(0, Math.min(this.hashCols - 1, Math.floor((px - this.nav.minX) / this.hashCell)))
    const r = Math.max(0, Math.min(this.hashRows - 1, Math.floor((py - this.nav.minY) / this.hashCell)))
    return r * this.hashCols + c
  }

  #writeInstances() {
    const arr = this.mesh.instanceMatrix.array
    const S = this.peopleScale
    for (let i = 0; i < this.high; i++) {
      const o = i * 16
      const st = this.state[i]
      if (st === FREE || st === INSIDE || this.scale[i] <= 0.001) {
        arr[o] = arr[o + 5] = arr[o + 10] = 0
        arr[o + 12] = arr[o + 13] = arr[o + 14] = 0
        arr[o + 15] = 1
        continue
      }
      const s = S * this.scale[i]
      const v = Math.hypot(this.vx[i], this.vy[i])
      const yaw = v > 0.05 ? Math.atan2(this.vx[i], this.vy[i]) : 0
      const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s
      arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0
      arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0
      arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0
      arr[o + 12] = this.x[i]
      arr[o + 13] = CURB_H + Math.abs(Math.sin(this.phase[i])) * 0.06 * s * Math.min(1, v)
      arr[o + 14] = this.y[i]
      arr[o + 15] = 1
    }
    this.mesh.count = this.high
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.colorsDirty) { this.mesh.instanceColor.needsUpdate = true; this.colorsDirty = false }
  }

  /** (x,y) 半径 r 内正在走路的人数；onRoadOnly 时只数脚下是车行道的（= 正在过马路的），车流据此让行 */
  countNear(px, py, r, onRoadOnly = false) {
    const { nav, hashCell, hashCols, hashRows } = this
    const c0 = Math.max(0, Math.floor((px - r - nav.minX) / hashCell)), c1 = Math.min(hashCols - 1, Math.floor((px + r - nav.minX) / hashCell))
    const r0 = Math.max(0, Math.floor((py - r - nav.minY) / hashCell)), r1 = Math.min(hashRows - 1, Math.floor((py + r - nav.minY) / hashCell))
    let n = 0
    for (let rr = r0; rr <= r1; rr++) {
      for (let cc = c0; cc <= c1; cc++) {
        for (let j = this.hashHead[rr * hashCols + cc]; j >= 0; j = this.hashNext[j]) {
          if ((this.x[j] - px) ** 2 + (this.y[j] - py) ** 2 > r * r) continue
          if (!onRoadOnly || nav.surfaceAt(this.x[j], this.y[j]) === SURFACE.ROAD) n++
        }
      }
    }
    return n
  }

  stats() {
    const perBuilding = {}
    for (const [id, b] of this.buildings) perBuilding[id] = b.visitors
    const groups = this.demand ? GROUPS.map((g, k) => ({ id: g.id, label: g.label, active: this.groupActive[k], target: this.groupTargets[k] })) : null
    return { active: this.active, inside: this.insideCount, walking: this.active - this.insideCount, perBuilding, groups, events: this.demand?.upcoming() || [] }
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
