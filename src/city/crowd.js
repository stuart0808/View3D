// 人群仿真。
//
// 每个人是一个状态机: WALK（沿距离场走向目的地）→ ENTER（缩小、进门）→ INSIDE（在楼里，计时）→ EXIT（出门）→ WALK …
// 或者 IDLE（在公园 / 广场歇脚）；走到出入口 / 回到家 = FREE（离开仿真）。
// 数据全部是平铺的类型化数组（SoA），几千人每帧更新也只有几毫秒；渲染是一个 InstancedMesh。
//
// 目的地（dests）三种: door（一栋楼，含它所有的门，共用一张距离场）、portal（人流出入口 / 车站出入口）、spot（歇脚点）。
// 「去哪」由需求模型（demand.js）按人群和时段决定；没有需求模型时退回「随机逛几家店再离开」。
// 这是「示意性」仿真: 后端只需给聚合量（总人数、各建筑吸引力、人群曲线），小人的具体路径由前端生成。
//
// 运动: 目标方向 = 距离场的下坡方向 + 每人固定的横向偏移（铺满人行道）；加上邻居的分离力（哈希网格找邻居）；
// 一阶低通得到速度；撞墙时沿墙滑。红灯时正要踏上斑马线的人停下。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { UNREACHABLE, SURFACE } from './navgrid.js'
import { signedArea, interiorPoints } from './geometry.js'
import { CURB_H } from './ground.js'
import { GROUPS } from './demand.js'

const FREE = 0, WALK = 1, ENTER = 2, INSIDE = 3, EXIT = 4, IDLE = 5 // 状态; IDLE = 在公园/广场里站着歇会儿
// 没有需求模型时的小人配色（白灰为主，少量彩色）
const PALETTE = ['#f5f5f4', '#f5f5f4', '#e7e5e4', '#d6d3d1', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#334155', '#1f2937', '#1f2937', '#9a6b4b', '#3b5b8c']

/** 小人的几何体: 胶囊身体 + 球头，约 1.7m 高；下半身顶点色压暗，远看有「上衣 + 裤子」的层次 */
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
  /**
   * @param capacity    最多同时存在多少人（类型化数组的长度）
   * @param peopleScale 小人的显示放大倍数（等轴测远景里 1:1 的人太小）
   * @param signals     红绿灯，行人过街要看；可为 null
   * @param demand      需求模型；可为 null
   */
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

    // ---- 每个人的状态，按槽位 i 索引 ----
    const n = capacity
    this.state = new Uint8Array(n)
    this.x = new Float32Array(n); this.y = new Float32Array(n)
    this.vx = new Float32Array(n); this.vy = new Float32Array(n)
    this.speed = new Float32Array(n) // 步行速度 1.15~1.6 m/s
    this.lane = new Float32Array(n) // 相对引导线的横向偏移，让人流铺满人行道
    this.dest = new Int16Array(n) // 目的地 dests 下标
    this.stops = new Uint8Array(n) // 无需求模型时: 还要逛几家店
    this.timer = new Float32Array(n) // 停留 / 进出门的倒计时（仿真秒）
    this.phase = new Float32Array(n) // 走路起伏的相位
    this.scale = new Float32Array(n) // 显示缩放 0~1，进出门时渐变
    this.hx = new Float32Array(n); this.hy = new Float32Array(n) // 在店内时的热力落点
    this.door = new Uint8Array(n) // 进的是这栋楼的第几扇门
    this.group = new Uint8Array(n) // 属于哪类人群（GROUPS 的下标）
    this.afterEvent = new Uint8Array(n) // 刚看完演出出来: 下一步多半是回家
    this.home = new Int16Array(n).fill(-1) // 住户: 家是哪个目的地（dests 下标）；-1 = 不是核心区的住户
    this.ex = new Float32Array(n); this.ey = new Float32Array(n) // 出门后先走到的门外落脚点
    this.heatSamples = new Float32Array(n * 3)
    this.heatCount = 0

    this.#buildDestinations(scene)
    this.#buildMesh()

    // 邻域查询用的哈希网格: 1.6m 一格，每格一条链表（head/next），分离力只看 3x3 格
    this.hashCell = 1.6
    this.hashCols = Math.ceil((nav.cols * nav.cell) / this.hashCell) + 1
    this.hashRows = Math.ceil((nav.rows * nav.cell) / this.hashCell) + 1
    this.hashHead = new Int32Array(this.hashCols * this.hashRows)
    this.hashNext = new Int32Array(n)
    this._la = [0, 0, 0]
  }

  /** 把楼、出入口、歇脚点整理成目的地列表，并建每栋楼的统计记录（吸引力、面积、内点、在内人数） */
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
    for (const di of this.byCat.home || []) {
      const d = this.dests[di], b = byId.get(d.building)
      d.residents = this.demand ? this.demand.residentsOf(this.buildings.get(d.building).area, b.floors || 9) : 0
      Object.assign(d, { atHome: d.residents, away: 0, depAcc: 0, retAcc: 0 })
    }
    this.pendingFields = this.dests.map((_, i) => i)
    this.#refreshWeights()
  }

  /** 楼的抽样权重 = 吸引力 × 面积（千㎡）。#pick 时还会乘距离衰减 */
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

  /** 所有人一个 InstancedMesh；实例矩阵每步重写，颜色只在生成时写 */
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

  /**
   * 分帧预热: 每帧花 budgetMs 算几张距离场，全部算完才 ready。城区 127 张约 5 秒。
   * 算完后立刻按目标人数把人「撒在半路上」，开场就是热闹的，不用等人从出入口慢慢走进来。
   */
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

  /**
   * 从 list 里按 权重 × 距离衰减（e^(-d/140m)）抽一个从 (x,y) 可达的目的地；exclude 排除刚离开的那个。
   * 出入口不做距离衰减（离开时去哪个口是均匀的）。返回 dests 下标，没有可达的返回 -1
   */
  #pick(list, x, y, exclude = -1) {
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

  /** arrivedHome: 住户走回了自己家；否则住户是从出入口离开了核心区（记为「在外」，傍晚会回来） */
  #free(i, arrivedHome = false) {
    this.state[i] = FREE
    this.active--
    this.groupActive[this.group[i]]--
    if (this.home[i] >= 0) {
      const h = this.dests[this.home[i]]
      if (arrivedHome) h.atHome++
      else h.away++
      this.home[i] = -1
    }
  }

  /**
   * 选下一站。有需求模型时: 先按「所属人群 × 当前时段」的偏好抽一个活动类别，再在这一类里按吸引力和距离抽具体地点。
   * 场馆只在活动进场时段可选，权重随「还差多少观众」变化；刚散场出来的人多半直接回家。
   */
  #chooseNext(i, x, y, exclude = -1, noLeave = false) {
    if (!this.demand) return -2
    const mix = { ...(this.afterEvent[i] ? { leave: 8, shop: 2 } : this.demand.mix(this.group[i])) }
    this.afterEvent[i] = 0
    delete mix.venue
    if (noLeave) delete mix.leave
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
    if (chosen === 'leave') return this.home[i] >= 0 ? this.home[i] : this.#pick(this.portals, x, y) // 住户的「离开」就是回家
    const list = chosen === 'venue' ? this.byCat.venue.filter((di) => this.dests[di].open) : this.byCat[chosen]
    const got = this.#pick(list, x, y, exclude)
    if (got >= 0 && this.dests[got].cat === 'venue') this.dests[got].enRoute++
    return got >= 0 ? got : this.#pick(this.portals, x, y)
  }

  /** res = { home, fromHome }: 生成的是一位住户 —— 从家门口出来，或者从外面回来直奔家 */
  #spawn(x, y, midway = false, res = null) {
    let i = 0
    while (i < this.capacity && this.state[i] !== FREE) i++
    if (i >= this.capacity) return -1
    let dest
    if (this.demand) {
      // 进场的是哪类人: 缺口最大的那一类；各类都不缺（多出来的是活动观众）就按观众构成抽
      let g = 0, best = -Infinity
      this.groupTargets.forEach((t, k) => { const gap = t - this.groupActive[k]; if (gap > best) { best = gap; g = k } })
      if (best <= 0) { const r = this.rand(); g = r < 0.35 ? 0 : r < 0.8 ? 2 : r < 0.95 ? 3 : 1 }
      this.home[i] = res ? res.home : -1
      if (res) g = this.demand.residentGroup(this.rand)
      this.group[i] = g
      this.afterEvent[i] = 0
      if (res && !res.fromHome) dest = res.home // 从外面回来: 直接回家
      else if (res && this.rand() < this.demand.commuteOutProb(g)) dest = this.#pick(this.portals, x, y) // 通勤 / 外出办事: 去车站或出入口
      else dest = this.#chooseNext(i, x, y, res ? res.home : -1, !!res)
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
    if (dest < 0) { this.home[i] = -1; return -1 }
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

  /** 走到目的地: 出入口 → 离场；歇脚点 → IDLE；楼 → 挑最近的一扇门进去（ENTER 动画 0.45s） */
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
    if (force) { // 开场 / 跳时间: 按此刻的时段把住户分成「在家」和「在外」
      const f = this.demand.homeFraction()
      for (const di of this.byCat.home || []) {
        const d = this.dests[di]
        d.atHome = Math.round(d.residents * f)
        d.away = d.residents - d.atHome
        d.depAcc = d.retAcc = 0
      }
    }
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

  /**
   * 推进 dt 仿真秒。write=false 时只推进状态不写实例矩阵（一帧里有多个子步时，只有最后一步需要写）。
   * 顺序: 预热 → 刷新应有人数 → 住户出门 / 回家 → 从出入口补人到目标数 → 重建哈希网格 → 逐人更新 → 写实例
   */
  update(dt, write = true) {
    if (!this.ready && !this.#warmup()) return
    const { nav, state, x, y, vx, vy } = this
    const la = this._la

    this._demandTimer -= dt
    if (this._demandTimer <= 0) this.#refreshDemand()

    // 住户出行: 在家的人按时段的离家率出门，在外的人按回家率从车站 / 出入口回来
    if (this.demand && this.byCat.home && this.portals.length) {
      const dep = (this.demand.homeDepartRate() * dt) / 3600, ret = (this.demand.homeReturnRate() * dt) / 3600
      for (const di of this.byCat.home) {
        const d = this.dests[di]
        d.depAcc += d.atHome * dep
        d.retAcc += d.away * ret
        while (d.depAcc >= 1 && d.atHome > 0) {
          d.depAcc -= 1
          const q = d.doors[(this.rand() * d.doors.length) | 0]
          if (this.#spawn(q.c[0], q.c[1], false, { home: di, fromHome: true }) >= 0) d.atHome--
        }
        while (d.retAcc >= 1 && d.away > 0) {
          d.retAcc -= 1
          const pt = this.dests[this.#pickPortal()]
          if (this.#spawn(pt.c[0], pt.c[1], false, { home: di, fromHome: false }) >= 0) d.away--
        }
      }
    }

    // 维持目标人数: 缺多少就按比例补（每秒最多 40 人），用「欠账」累计小数部分
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

    const steer = 1 - Math.exp(-dt * 5) // 速度向目标速度靠拢的一阶低通系数（时间常数 0.2s）
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

      // WALK: 引导点 = 沿距离场往前 5 格；到目标 1.4m 内算到达
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

      // 分离力: 0.9m 内的邻居互相推开，力随距离线性增大
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
      // 撞墙: 能走就走；不能就试着只走 x 或只走 y（沿墙滑）；都不行就减速
      if (nav.isWalkable(nx, ny)) { x[i] = nx; y[i] = ny }
      else if (nav.isWalkable(nx, y[i])) { x[i] = nx; vy[i] *= 0.3 }
      else if (nav.isWalkable(x[i], ny)) { y[i] = ny; vx[i] *= 0.3 }
      else { vx[i] *= 0.2; vy[i] *= 0.2 }
      this.phase[i] += dt * 9 * this.speed[i]
    }
    if (write) this.#writeInstances()
  }

  /** 真正进楼: 记账（visitors / insideCount）、定停留时长（店 / 办公 / 场馆各不同）、选热力落点 */
  #goInside(i, d) {
    if (d.cat === 'home' && this.demand) return this.#free(i, this.home[i] === this.dest[i]) // 回到住处 = 离开仿真（住户记为在家）
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

  /** 补人时从哪个出入口进来: 先消耗车站的到站队列（列车刚到），否则按出入口权重抽 */
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

  /** 哈希网格的格号 */
  #hash(px, py) {
    const c = Math.max(0, Math.min(this.hashCols - 1, Math.floor((px - this.nav.minX) / this.hashCell)))
    const r = Math.max(0, Math.min(this.hashRows - 1, Math.floor((py - this.nav.minY) / this.hashCell)))
    return r * this.hashCols + c
  }

  /**
   * 写实例矩阵。看不见的人（FREE / INSIDE / 缩放为 0）写零矩阵；其余按速度方向转身，走路时上下起伏一点。
   * 直接写 Float32Array 而不是 setMatrixAt，省掉几千次对象操作
   */
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
    let residents = null
    if (this.demand && (this.byCat.home || []).length) {
      residents = { home: 0, away: 0, out: 0 }
      for (const di of this.byCat.home) { residents.home += this.dests[di].atHome; residents.away += this.dests[di].away }
      for (let i = 0; i < this.high; i++) if (this.state[i] !== FREE && this.home[i] >= 0) residents.out++
    }
    return { active: this.active, inside: this.insideCount, walking: this.active - this.insideCount, perBuilding, groups, residents, events: this.demand?.upcoming() || [] }
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
