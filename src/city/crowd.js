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
//
// 对外接口: population（目标人数）、dwellScale、setAttraction、update(dt)、reseed、arrive(站名, n)、countNear、stats。
// 「离开仿真」的人只是槽位归零（FREE），槽位复用；high 是用过的最大槽位 + 1，遍历只到 high。
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
    // scene: 地图数据（buildings / doors / portals / areas）；nav: 导航网格（距离场、可走性）；rand: 可复现的随机数源 [0,1)
    this.nav = nav
    this.rand = rand
    this.demand = demand // 需求模型（人群分组 + 场馆活动）。为 null 时退回「随机逛几家店」的老逻辑
    this.base = 600 // 高峰人数；有需求模型时，实际应有人数由它按时刻算
    this.groupActive = GROUPS.map(() => 0) // 各人群此刻在场人数
    this.groupTargets = GROUPS.map(() => 0) // 各人群应有人数（需求模型算的）
    this._demandTimer = 0 // 距下次刷新应有人数的秒数（每 30 仿真秒一次）
    this.colorsDirty = false // 有新人生成 → 实例颜色要重传
    this.signals = signals
    this.capacity = capacity
    this.peopleScale = peopleScale
    this.population = 600 // 目标在场人数（引擎按时段 / 人群曲线设置）
    this.dwellScale = 1 // 店内停留时长的倍数
    this.shopRatio = 0.8 // 进店逛的人占比，其余是纯路过
    this.high = 0 // 已用到的最大槽位
    this.active = 0 // 在场人数（街上 + 楼内）
    this.insideCount = 0 // 楼内人数
    this.ready = false // 距离场都算完了没
    this.spawnDebt = 0 // 补人的「欠账」（小数累计）

    // ---- 每个人的状态，按槽位 i 索引 ----
    // 不变量: active = 街上（WALK/ENTER/EXIT/IDLE）+ 楼内（INSIDE）；state 为 FREE 的槽位随时可被 #spawn 复用
    const n = capacity
    this.state = new Uint8Array(n) // FREE / WALK / ENTER / INSIDE / EXIT / IDLE
    this.x = new Float32Array(n); this.y = new Float32Array(n) // 位置（米，地图坐标）
    this.vx = new Float32Array(n); this.vy = new Float32Array(n) // 速度（m/s），一阶低通后的结果
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
    this.heatSamples = new Float32Array(n * 3) // 每步收集的热力样本 [x, y, 权重]，heat.js 读
    this.heatCount = 0

    this.#buildDestinations(scene)
    this.#buildMesh()

    // 邻域查询用的哈希网格: 1.6m 一格，每格一条链表（head/next），分离力只看 3x3 格
    // 格子略大于分离半径 0.9m，保证 3x3 格一定覆盖到所有可能相互推开的邻居；每帧重建（只放 WALK 状态的人）
    this.hashCell = 1.6
    this.hashCols = Math.ceil((nav.cols * nav.cell) / this.hashCell) + 1
    this.hashRows = Math.ceil((nav.rows * nav.cell) / this.hashCell) + 1
    this.hashHead = new Int32Array(this.hashCols * this.hashRows)
    this.hashNext = new Int32Array(n)
    this._la = [0, 0, 0] // lookAhead 的复用输出 [x, y, 剩余距离]
  }

  /**
   * 把楼、出入口、歇脚点整理成目的地列表，并建每栋楼的统计记录（吸引力、面积、内点、在内人数）
   * @param scene 地图数据: buildings（必有）、doors / portals / areas（可缺省）
   */
  #buildDestinations(scene) {
    const nav = this.nav
    const byId = new Map(scene.buildings.map((b) => [b.id, b]))
    const doorCount = new Map()
    for (const d of scene.doors || []) doorCount.set(d.building, (doorCount.get(d.building) || 0) + 1)

    // 每栋楼一条统计记录: attraction 决定抽样权重；area（㎡）用来估权重和住户数；interior 是楼内热力落点的候选
    this.buildings = new Map()
    for (const b of scene.buildings) {
      this.buildings.set(b.id, {
        attraction: b.attraction ?? 1, // 吸引力，后端可用 setAttraction 覆盖
        area: Math.abs(signedArea(b.polygon)), // 占地面积（㎡）
        interior: interiorPoints(b.polygon, b.holes || [], 40, this.rand), // 楼内 40 个随机内点，#goInside 从中挑热力落点
        visitors: 0, // 此刻在楼内的人数
      })
    }

    // 目的地按「楼」建，而不是按「门」: 一栋楼的所有门共用一张多源距离场，人自然会走向离自己最近的那扇门。
    // 城区里几百扇门，每扇门一张场的话内存和预热时间都撑不住。
    this.dests = []
    const byBuilding = new Map()
    for (const d of scene.doors || []) {
      if (!byId.has(d.building)) continue // 门指向的楼不存在（地图数据不一致），跳过
      // 门本身在楼的轮廓上（不可走），沿法线往外 1.6m 找最近的可走格作为「门口」；8 格内都找不到的门弃用
      const cell = nav.nearestWalkable(d.pos[0] + d.normal[0] * 1.6, d.pos[1] + d.normal[1] * 1.6, 8)
      if (cell < 0) continue
      if (!byBuilding.has(d.building)) byBuilding.set(d.building, [])
      // x/y 是门的位置（进出门动画的终点）；cell/c 是门口可走格及其中心（距离场的源、出门后的落脚点）
      byBuilding.get(d.building).push({ x: d.pos[0], y: d.pos[1], cell, c: nav.center(cell) })
    }
    for (const [id, doors] of byBuilding) {
      // 楼的种类 → 活动类别（需求模型的 mix 按类别给权重）；未知种类一律当商店
      const CAT = { shop: 'shop', block: 'office', residential: 'home', venue: 'venue' }
      // enRoute: 正在赶来的人数（只对场馆有意义）；cells: 所有门口格 = 多源距离场的源；field 由 #warmup 分帧算；weight 由 #refreshWeights 算
      this.dests.push({ type: 'door', building: id, kind: byId.get(id).kind, cat: CAT[byId.get(id).kind] || 'shop', enRoute: 0, doors, cells: doors.map((q) => q.cell), x: doors[0].x, y: doors[0].y, c: doors[0].c, field: null, weight: 0 })
    }
    // 出入口: 可以离地图可走区稍远（最多找 25 格），station 关联车站名（列车到站时 arrive() 往 queue 里加人）
    for (const p of scene.portals || []) {
      const cell = nav.nearestWalkable(p.pos[0], p.pos[1], 25)
      if (cell < 0) continue
      this.dests.push({ type: 'portal', x: p.pos[0], y: p.pos[1], cell, c: nav.center(cell), field: null, weight: p.weight ?? 1, station: p.station || null, queue: 0 })
    }
    // 公园、广场里撒一些「歇脚点」，人会走过去站一会儿再走
    for (const a of scene.areas || []) {
      if (a.kind !== 'park' && a.kind !== 'plaza') continue
      const area = Math.abs(signedArea(a.polygon))
      const n = Math.max(2, Math.min(10, Math.round(area / 450))) // 每 450㎡ 一个歇脚点，最少 2 个、最多 10 个
      // 多撒 4 倍候选再过滤掉落在不可走处（水面、花坛）的，最后截取 n 个
      const pts = interiorPoints(a.polygon, a.holes || [], n * 4, this.rand).filter(([x, y]) => nav.isWalkable(x, y)).slice(0, n)
      for (const [x, y] of pts) {
        const cell = nav.index(x, y)
        // 整片区域的权重 = 面积（千㎡）× 系数（公园比广场更吸引人），平摊到每个歇脚点上，免得点多的区域被抽得过多
        this.dests.push({ type: 'spot', cat: a.kind, x, y, cell, c: nav.center(cell), field: null, weight: ((area / 1000) * (a.kind === 'park' ? 0.8 : 0.5)) / pts.length })
      }
    }
    // 「逛」的目的地 = 店门 + 歇脚点
    this.doors = this.dests.map((d, i) => (d.type !== 'portal' ? i : -1)).filter((i) => i >= 0)
    this.portals = this.dests.map((d, i) => (d.type === 'portal' ? i : -1)).filter((i) => i >= 0)
    // 按活动类别索引（shop / office / home / venue / park / plaza），#chooseNext 先抽类别再在类内抽地点
    this.byCat = {}
    this.dests.forEach((d, i) => { if (d.cat) (this.byCat[d.cat] ||= []).push(i) })
    // 住宅楼: 住户数由面积 × 层数估算（没有需求模型时为 0，即没有住户出行）
    // atHome / away 是「在家」「出了核心区」的人数，depAcc / retAcc 是出门 / 回家的小数累计（见 update）
    for (const di of this.byCat.home || []) {
      const d = this.dests[di], b = byId.get(d.building)
      d.residents = this.demand ? this.demand.residentsOf(this.buildings.get(d.building).area, b.floors || 9) : 0 // 没标层数的按 9 层算
      Object.assign(d, { atHome: d.residents, away: 0, depAcc: 0, retAcc: 0 })
    }
    // 所有目的地的距离场都还没算，交给 #warmup 分帧算（从后往前 pop）
    this.pendingFields = this.dests.map((_, i) => i)
    this.#refreshWeights()
  }

  /** 楼的抽样权重 = 吸引力 × 面积（千㎡）。#pick 时还会乘距离衰减。出入口和歇脚点的权重在建目的地时已定，这里不动 */
  #refreshWeights() {
    for (const d of this.dests) {
      if (d.type !== 'door') continue // 只有楼的权重依赖吸引力
      const b = this.buildings.get(d.building)
      d.weight = b.attraction * (b.area / 1000)
    }
  }

  /**
   * { 建筑id: 吸引力 }，接后端算出来的各店客流/消费权重
   * @param map 只更新给出的楼，其余保持原值；未知的 id 忽略
   */
  setAttraction(map) {
    for (const [id, v] of Object.entries(map)) {
      const b = this.buildings.get(id)
      if (b) b.attraction = v
    }
    this.#refreshWeights() // 权重立刻生效，下一次 #pick 就按新吸引力抽
  }

  /** 所有人一个 InstancedMesh；实例矩阵每步重写，颜色只在生成时写 */
  #buildMesh() {
    const geo = personGeometry()
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, vertexColors: true })
    this.mesh = new THREE.InstancedMesh(geo, mat, this.capacity)
    this.mesh.name = 'crowd'
    this.mesh.count = 0 // 每次 #writeInstances 设为 high
    this.mesh.castShadow = true
    this.mesh.frustumCulled = false // 实例散布全图，包围盒不准，关掉剔除免得整批消失
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage) // 矩阵每帧重传
    // 先给每个槽位随机配一个默认色（无需求模型时的配色）；有需求模型时 #spawn 会按人群覆盖
    const c = (this._col = new THREE.Color())
    for (let i = 0; i < this.capacity; i++) this.mesh.setColorAt(i, c.set(PALETTE[(this.rand() * PALETTE.length) | 0]))
  }

  /**
   * 分帧预热: 每帧花 budgetMs 算几张距离场，全部算完才 ready。城区 127 张约 5 秒。
   * 算完后立刻按目标人数把人「撒在半路上」，开场就是热闹的，不用等人从出入口慢慢走进来。
   * @param budgetMs 本帧最多花多少毫秒算距离场（12ms 留出渲染余量，帧率不至于掉太多）
   * @returns 是否已全部算完（true 之后 update 才真正推进仿真）
   */
  #warmup(budgetMs = 12) {
    const t0 = performance.now()
    while (this.pendingFields.length && performance.now() - t0 < budgetMs) {
      const i = this.pendingFields.pop()
      this.dests[i].field = this.nav.buildField(this.dests[i].cells || this.dests[i].cell) // 楼是多源（所有门口格），出入口 / 歇脚点单源
    }
    if (this.pendingFields.length) return false // 还没算完，下一帧继续
    // 预热: 直接把人撒在半路上，开场就是热闹的
    // reachable = 从第一个出入口可达、且不是「勉强可走」（penalty ≥ 1 的斑马线 / 路面）的格子，铺场和 reseed 都从这里抽落点
    const ref = this.portals.length ? this.dests[this.portals[0]].field : null
    this.reachable = []
    if (ref) for (let k = 0; k < ref.length; k++) if (ref[k] !== UNREACHABLE && this.nav.penalty[k] < 1) this.reachable.push(k)
    this.#refreshDemand(true) // 按此刻时段算应有人数，并把住户分成在家 / 在外
    const n = Math.min(this.population, this.capacity)
    for (let i = 0; i < n && this.reachable.length; i++) {
      const k = this.reachable[(this.rand() * this.reachable.length) | 0]
      const [x, y] = this.nav.center(k)
      this.#spawn(x, y, true) // midway=true: 显示缩放直接为 1，且一部分人直接放进楼里
    }
    this.ready = true
    return true
  }

  /**
   * 从 list 里按 权重 × 距离衰减（e^(-d/140m)）抽一个从 (x,y) 可达的目的地；exclude 排除刚离开的那个。
   * 出入口不做距离衰减（离开时去哪个口是均匀的）。返回 dests 下标，没有可达的返回 -1
   * @param list    候选目的地下标数组（doors / portals / byCat[...]）
   * @param x,y     出发点（米）；距离沿目的地自己的距离场查，是步行距离而不是直线距离
   * @param exclude 排除的目的地下标（刚离开的店，不要原地进出）
   */
  #pick(list, x, y, exclude = -1) {
    let total = 0
    const w = this._w || (this._w = new Float32Array(this.dests.length)) // 权重暂存数组，按 dests 下标索引，复用免分配
    for (const i of list) {
      const d = this.dests[i]
      w[i] = 0
      if (i === exclude || !d.field) continue // 距离场还没算完的目的地（预热中）不可选
      const dist = this.nav.distanceAt(d.field, x, y)
      if (dist === Infinity) continue // 从这里走不到
      // 140m 是衰减尺度: 隔两三个街区的店吸引力就只剩 1/e；+1e-6 保证可达的至少有微小概率
      w[i] = d.weight * (d.type !== 'portal' ? Math.exp(-dist / 140) : 1) + 1e-6
      total += w[i]
    }
    if (total <= 0) return -1
    // 轮盘赌抽样
    let r = this.rand() * total
    for (const i of list) {
      r -= w[i]
      if (r <= 0 && w[i] > 0) return i // w[i] > 0 防止落到被排除 / 不可达的项上
    }
    return -1 // 浮点误差兜底
  }

  /**
   * 让第 i 个人离开仿真: 槽位归零（FREE），各计数减一。high 不回退，槽位留给下一次 #spawn 复用
   * @param i           槽位
   * @param arrivedHome 住户走回了自己家；否则住户是从出入口离开了核心区（记为「在外」，傍晚会回来）
   */
  #free(i, arrivedHome = false) {
    this.state[i] = FREE
    this.active--
    this.groupActive[this.group[i]]--
    // 住户: 把这个人记回住宅楼的 atHome / away 账上，住户守恒: residents = atHome + away + 正在核心区活动的
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
   * @param i       槽位
   * @param x,y     出发点（米）
   * @param exclude 排除的目的地（刚离开的那个）
   * @param noLeave 不允许选「离开」（住户刚出家门，不该立刻又回家）
   * @returns dests 下标；-1 = 哪儿都去不了（调用方会 #free）；-2 = 没有需求模型，调用方退回老逻辑
   */
  #chooseNext(i, x, y, exclude = -1, noLeave = false) {
    if (!this.demand) return -2
    // 类别权重表: 刚散场的人 80% 离开、20% 逛店；其他人按人群 × 时段的偏好。拷贝一份，下面要改
    const mix = { ...(this.afterEvent[i] ? { leave: 8, shop: 2 } : this.demand.mix(this.group[i])) }
    this.afterEvent[i] = 0 // 「刚散场」只影响这一次选择
    delete mix.venue // 场馆权重不用偏好表里的，下面按活动进度重算
    if (noLeave) delete mix.leave
    // 场馆: 逐个看是否在进场时段、还缺多少观众；open 标记供下面筛可选场馆
    for (const di of this.byCat.venue || []) {
      const d = this.dests[di], ph = this.demand.phaseOf(d.building)
      d.open = false
      if (!ph || ph.phase !== 'ingress') continue // 没活动、或不在进场时段
      // 「此刻应该已经到场的人数」随进场进度增长（开场前 75 分钟开始，越临近越多），还差多少就有多大吸引力
      // 减去已在场内的（visitors）和正在赶来的（enRoute），避免同时派太多人过去、到场时超员
      const need = ph.ev.attendance * Math.min(1, ph.progress * 1.15 + 0.05) - this.buildings.get(d.building).visitors - d.enRoute
      if (need <= 0) continue
      d.open = true
      mix.venue = (mix.venue || 0) + 60 * (need / ph.ev.attendance) // 60 = 缺口满时场馆的权重（远高于逛店，人会明显往场馆涌）
    }
    // 第一层抽样: 选活动类别。地图上没有这类地点的类别权重清零；「离开」总是可行（出入口或家）
    let total = 0
    for (const [cat, wgt] of Object.entries(mix)) { if (cat !== 'leave' && !(this.byCat[cat] || []).length) mix[cat] = 0; else total += wgt }
    let r = this.rand() * total, chosen = 'leave' // 权重全为 0 时默认离开
    for (const [cat, wgt] of Object.entries(mix)) { r -= wgt; if (wgt > 0 && r <= 0) { chosen = cat; break } }
    if (chosen === 'leave') return this.home[i] >= 0 ? this.home[i] : this.#pick(this.portals, x, y) // 住户的「离开」就是回家
    // 第二层抽样: 在这一类里按吸引力 × 距离衰减抽具体地点；场馆只在 open 的里面抽
    const list = chosen === 'venue' ? this.byCat.venue.filter((di) => this.dests[di].open) : this.byCat[chosen]
    const got = this.#pick(list, x, y, exclude)
    if (got >= 0 && this.dests[got].cat === 'venue') this.dests[got].enRoute++ // 记「在路上」，到场（#arrive）或铺场进楼时减回
    return got >= 0 ? got : this.#pick(this.portals, x, y) // 这一类都走不到就直接离开
  }

  /**
   * 在 (x,y) 生成一个人并给他定第一站。
   * @param x,y    落点（米），通常是出入口格中心、家门口格中心或铺场时的随机可达格
   * @param midway 铺场模式（开场 / 跳时间）: 人是「已经在半路上」的，不做出现动画，且一部分直接放进楼里
   * @param res    { home, fromHome }: 生成的是一位住户 —— 从家门口出来，或者从外面回来直奔家；null = 普通访客
   * @returns 槽位下标；-1 = 满了或者没有可达的目的地（此时不占槽位、不计数）
   */
  #spawn(x, y, midway = false, res = null) {
    // 线性找第一个空槽（FREE）。几千人规模下够快，且倾向复用低位槽，high 不会无谓增长
    let i = 0
    while (i < this.capacity && this.state[i] !== FREE) i++
    if (i >= this.capacity) return -1
    let dest
    if (this.demand) {
      // 进场的是哪类人: 缺口最大的那一类；各类都不缺（多出来的是活动观众）就按观众构成抽
      let g = 0, best = -Infinity
      this.groupTargets.forEach((t, k) => { const gap = t - this.groupActive[k]; if (gap > best) { best = gap; g = k } })
      if (best <= 0) { const r = this.rand(); g = r < 0.35 ? 0 : r < 0.8 ? 2 : r < 0.95 ? 3 : 1 } // 观众构成: 35% 组0、45% 组2、15% 组3、5% 组1
      this.home[i] = res ? res.home : -1
      if (res) g = this.demand.residentGroup(this.rand) // 住户的人群按住户构成抽，不看缺口
      this.group[i] = g
      this.afterEvent[i] = 0
      // 第一站的三种来源，按优先级: 回家的住户 → 出门通勤的住户 → 正常按偏好选
      if (res && !res.fromHome) dest = res.home // 从外面回来: 直接回家
      else if (res && this.rand() < this.demand.commuteOutProb(g)) dest = this.#pick(this.portals, x, y) // 通勤 / 外出办事: 去车站或出入口
      else dest = this.#chooseNext(i, x, y, res ? res.home : -1, !!res) // 住户出门时排除自己家、且不许立刻「离开」
      if (midway && dest >= 0 && this.dests[dest].type === 'portal') dest = this.#chooseNext(i, x, y) // 铺场时少放一些「正要走」的人
      // 按人群配色，标记颜色缓冲需要重传
      const pal = GROUPS[g].colors
      this.mesh.setColorAt(i, this._col.set(pal[(this.rand() * pal.length) | 0]))
      this.colorsDirty = true
    } else {
      // 老逻辑: shopRatio 的人逛 1~3 家店再离开，其余直接穿过去出入口
      const shopper = this.rand() < this.shopRatio && this.doors.length > 0
      this.stops[i] = shopper ? 1 + ((this.rand() * 3) | 0) : 0
      if (midway && shopper && this.rand() < 0.5) this.stops[i] = Math.max(0, this.stops[i] - 1) // 铺场的人算「已经逛过一家」
      dest = this.stops[i] > 0 ? this.#pick(this.doors, x, y) : this.#pick(this.portals, x, y)
    }
    if (dest < 0) { this.home[i] = -1; return -1 } // 哪儿都去不了: 不占槽位；home 要清掉，否则脏值会影响下次复用
    // 初始化运动状态
    this.state[i] = WALK
    this.x[i] = x + (this.rand() - 0.5) * 0.6 // 落点抖 ±0.3m，同一格出来的人不重叠
    this.y[i] = y + (this.rand() - 0.5) * 0.6
    this.vx[i] = this.vy[i] = 0
    this.speed[i] = 1.15 + this.rand() * 0.45 // 1.15~1.6 m/s
    this.lane[i] = (this.rand() * 2 - 1) * 1.7 // 横向偏移 ±1.7m，约半条人行道宽
    this.dest[i] = dest
    this.phase[i] = this.rand() * 6.28 // 2π，起伏相位随机错开
    this.scale[i] = midway ? 1 : 0 // 新进场的人从 0 渐变到 1（WALK 分支里每秒 +3）
    this.high = Math.max(this.high, i + 1)
    this.active++
    this.groupActive[this.group[i]]++
    // 铺场（开场 / 跳时间）: 此刻大部分上班族在楼里、观众在场馆里，不该全撒在街上
    // 概率: 办公 85%、场馆 90%、商店 45%；住宅不放（进家 = 离开仿真）
    const d = this.dests[dest]
    if (midway && this.demand && d.type === 'door' && d.cat !== 'home' && this.rand() < (d.cat === 'office' ? 0.85 : d.cat === 'venue' ? 0.9 : 0.45)) {
      if (d.cat === 'venue') d.enRoute = Math.max(0, d.enRoute - 1) // 已经在场内，不再算「在路上」
      this.door[i] = (this.rand() * d.doors.length) | 0 // 随便记一扇门，出来时从这扇门出
      this.#goInside(i, d)
      this.timer[i] *= 0.15 + this.rand() * 0.85 // 停留时长打 15%~100% 的折: 有的人早已在里面待了很久，马上要出来
    }
    return i
  }

  /**
   * 走到目的地: 出入口 → 离场；歇脚点 → IDLE；楼 → 挑最近的一扇门进去（ENTER 动画 0.45s）
   * @param i 槽位，此时人已在目的地 1.4m 内
   */
  #arrive(i) {
    const d = this.dests[this.dest[i]]
    if (d.type === 'portal') return this.#free(i) // 走出核心区（住户此时记为「在外」）
    if (d.cat === 'venue') d.enRoute = Math.max(0, d.enRoute - 1) // 到场了，不再算「在路上」
    if (d.type === 'spot') {
      this.state[i] = IDLE
      this.vx[i] = this.vy[i] = 0 // 站住，#writeInstances 里速度为 0 就不再起伏
      this.timer[i] = (8 + this.rand() * 25) * 60 * this.dwellScale // 在公园/广场歇 8~33 分钟
      return
    }
    // 楼: 距离场是多源的，人被引到离自己最近的门口；这里再按直线距离确认是哪一扇，进出门动画都用它
    let best = 0, bd = Infinity
    d.doors.forEach((q, k) => { const dd = (q.x - this.x[i]) ** 2 + (q.y - this.y[i]) ** 2; if (dd < bd) { bd = dd; best = k } })
    this.door[i] = best
    this.state[i] = ENTER
    this.timer[i] = 0.45 // 进门动画时长（秒），与 update 里的缩放公式对应
  }

  /**
   * 离开当前停留点（店或歇脚点），去下一站。停留倒计时到 0 时由 update 调用
   * @param i 槽位，状态为 INSIDE 或 IDLE
   */
  #leaveShop(i) {
    const d = this.dests[this.dest[i]]
    const wasInside = d.type === 'door' // 在楼里（INSIDE）还是在歇脚点（IDLE）
    if (wasInside) {
      // 楼内记账回退
      const b = this.buildings.get(d.building)
      b.visitors = Math.max(0, b.visitors - 1)
      this.insideCount--
    }
    this.stops[i] = Math.max(0, this.stops[i] - 1) // 老逻辑: 又逛完一家
    // 下一站从「门口格」或「歇脚点」出发算距离；排除当前这家，免得原地进出
    const from = wasInside ? d.doors[this.door[i]].c : d.c
    let next = this.#chooseNext(i, from[0], from[1], this.dest[i])
    if (next === -2) next = this.stops[i] > 0 ? this.#pick(this.doors, from[0], from[1], this.dest[i]) : this.#pick(this.portals, from[0], from[1]) // 没有需求模型: 还有店要逛就再挑一家，否则去出入口
    if (next < 0) return this.#free(i) // 哪儿都去不了就直接消失
    this.dest[i] = next
    if (!wasInside) { this.state[i] = WALK; return } // 歇脚点: 起身就走，没有出门动画
    // 楼: 从进来的那扇门出去，0.45s 内从门的位置滑到门口格中心（ex/ey），缩放 0→1
    this.state[i] = EXIT
    this.timer[i] = 0.45
    const dq = d.doors[this.door[i]]
    this.x[i] = dq.x; this.y[i] = dq.y // 人在楼里时位置没有意义，出门前先放回门的位置
    this.ex[i] = dq.c[0]; this.ey[i] = dq.c[1]
  }

  /**
   * 有需求模型时: 各人群的应有人数 + 活动观众 = 总应有人数。update 每 20 仿真秒调一次，人数曲线是分段常数
   * @param force 开场 / 跳时间: 同时重置住户的在家 / 在外分布（平时这个分布靠出门 / 回家事件连续演化，不能重置）
   */
  #refreshDemand(force = false) {
    this._demandTimer = 20 // 仿真秒
    if (!this.demand) return // 没有需求模型: population 由外部直接设置
    if (force) { // 开场 / 跳时间: 按此刻的时段把住户分成「在家」和「在外」
      const f = this.demand.homeFraction() // 此刻在家的住户比例（夜里接近 1，工作日白天低）
      for (const di of this.byCat.home || []) {
        const d = this.dests[di]
        d.atHome = Math.round(d.residents * f)
        d.away = d.residents - d.atHome
        d.depAcc = d.retAcc = 0 // 小数累计也清零，免得跳时间后立刻批量出门
      }
    }
    // base 是高峰人数，targets 按人群曲线把它拆成各人群此刻应有的人数；观众另算，不占人群配额
    this.groupTargets = this.demand.targets(this.base)
    this.population = this.groupTargets.reduce((a, b) => a + b, 0) + this.demand.eventExtra()
  }

  /** 手动跳时间之后: 清空所有人，按当前目标人数重新撒一遍（与 #warmup 算完后的铺场相同） */
  reseed() {
    // 所有计数归零: 槽位、在场 / 楼内人数、各人群人数、场馆在途、各楼在内人数
    this.state.fill(FREE)
    this.high = this.active = this.insideCount = 0
    this.groupActive.fill(0)
    for (const d of this.dests) if (d.enRoute) d.enRoute = 0
    for (const b of this.buildings.values()) b.visitors = 0
    this.#refreshDemand(true) // 按新时刻重算应有人数、住户在家 / 在外
    if (!this.ready) return // 还在预热: 距离场算完后 #warmup 自己会铺场
    // 铺场: 在可达格里随机撒 population 个人
    const n = Math.min(this.population, this.capacity)
    for (let i = 0; i < n && this.reachable.length; i++) {
      const [px, py] = this.nav.center(this.reachable[(this.rand() * this.reachable.length) | 0])
      this.#spawn(px, py, true)
    }
    this.#writeInstances() // 立刻写实例，不等下一次 update，避免闪一帧旧画面
  }

  /**
   * 推进 dt 仿真秒。write=false 时只推进状态不写实例矩阵（一帧里有多个子步时，只有最后一步需要写）。
   * 顺序: 预热 → 刷新应有人数 → 住户出门 / 回家 → 从出入口补人到目标数 → 重建哈希网格 → 逐人更新 → 写实例
   * @param dt    仿真秒（已乘过 SimClock.rate；调用方保证子步足够小，dt*6 / dt*5 这类系数才不会过冲）
   * @param write 是否写实例矩阵
   */
  update(dt, write = true) {
    if (!this.ready && !this.#warmup()) return // 预热没完成: 这一帧只算距离场，不推进
    const { nav, state, x, y, vx, vy } = this
    const la = this._la

    // 应有人数每 20 仿真秒刷新一次（见 #refreshDemand），不用每帧问需求模型
    this._demandTimer -= dt
    if (this._demandTimer <= 0) this.#refreshDemand()

    // 住户出行: 在家的人按时段的离家率出门，在外的人按回家率从车站 / 出入口回来
    // 速率单位是「每人每小时」，乘 dt/3600 得到本步的概率；按楼累计小数（depAcc / retAcc），满 1 才真正生成一个人
    if (this.demand && this.byCat.home && this.portals.length) {
      const dep = (this.demand.homeDepartRate() * dt) / 3600, ret = (this.demand.homeReturnRate() * dt) / 3600
      for (const di of this.byCat.home) {
        const d = this.dests[di]
        d.depAcc += d.atHome * dep
        d.retAcc += d.away * ret
        // 出门: 从这栋楼随机一扇门的门口出现；生成失败（满员 / 无路）不扣 atHome，留到下次再试
        while (d.depAcc >= 1 && d.atHome > 0) {
          d.depAcc -= 1
          const q = d.doors[(this.rand() * d.doors.length) | 0]
          if (this.#spawn(q.c[0], q.c[1], false, { home: di, fromHome: true }) >= 0) d.atHome--
        }
        // 回家: 从出入口（优先刚到站的车站口）出现，目的地直接是家
        while (d.retAcc >= 1 && d.away > 0) {
          d.retAcc -= 1
          const pt = this.dests[this.#pickPortal()]
          if (this.#spawn(pt.c[0], pt.c[1], false, { home: di, fromHome: false }) >= 0) d.away--
        }
      }
    }

    // 维持目标人数: 缺多少就按比例补（每秒最多 40 人），用「欠账」累计小数部分
    // 补人速率 = 缺口的一半 + 2 人/秒: 缺得多补得快，接近目标时放缓，不会一步到位地「刷」出来
    const want = Math.min(this.population, this.capacity)
    if (this.active < want && this.portals.length) {
      this.spawnDebt += Math.min(40, (want - this.active) * 0.5 + 2) * dt
      while (this.spawnDebt >= 1) {
        this.spawnDebt -= 1
        const p = this.dests[this.#pickPortal()]
        this.#spawn(p.c[0], p.c[1])
      }
    }
    // 人数超出目标时不主动删人，靠自然离场（进出入口 / 回家）慢慢降下来

    // 哈希网格: 每帧从头重建，只登记正在走路的人（楼内 / 歇脚 / 进出门的人不参与分离力，也不算「过马路」）
    // 每格一条单链表: head[格] 是链头，next[i] 是同格的下一个人；头插法，无需清 next
    this.hashHead.fill(-1)
    for (let i = 0; i < this.high; i++) {
      if (state[i] !== WALK) continue
      const h = this.#hash(x[i], y[i])
      this.hashNext[i] = this.hashHead[h]
      this.hashHead[h] = i
    }

    const steer = 1 - Math.exp(-dt * 5) // 速度向目标速度靠拢的一阶低通系数（时间常数 0.2s）
    this.heatCount = 0 // 热力样本每帧重新收集
    for (let i = 0; i < this.high; i++) {
      const s = state[i]
      if (s === FREE) continue
      const d = this.dests[this.dest[i]]

      // 楼内: 倒计时，同时把落点交给热力图
      if (s === INSIDE) {
        this.timer[i] -= dt
        const k = this.heatCount++ * 3
        this.heatSamples[k] = this.hx[i]; this.heatSamples[k + 1] = this.hy[i]; this.heatSamples[k + 2] = 1 // 权重 1: 每个在店内的人贡献一份热
        if (this.timer[i] <= 0) this.#leaveShop(i)
        continue
      }
      // 歇脚: 只倒计时
      if (s === IDLE) {
        this.timer[i] -= dt
        if (this.timer[i] <= 0) this.#leaveShop(i)
        continue
      }
      // 进门 / 出门动画: 0.45s 内滑向门（或门外落脚点），同时缩放 1→0 / 0→1
      if (s === ENTER || s === EXIT) {
        this.timer[i] -= dt
        const dq = d.doors ? d.doors[this.door[i]] : d
        const tx = s === ENTER ? dq.x : this.ex[i], ty = s === ENTER ? dq.y : this.ey[i] // 进门滑向门的位置，出门滑向门口落脚点
        x[i] += (tx - x[i]) * Math.min(1, dt * 6) // 指数逼近，时间常数约 0.17s，0.45s 内基本到位
        y[i] += (ty - y[i]) * Math.min(1, dt * 6)
        this.scale[i] = THREE.MathUtils.clamp(s === ENTER ? this.timer[i] / 0.45 : 1 - this.timer[i] / 0.45, 0, 1) // 进门 1→0，出门 0→1
        if (this.timer[i] <= 0) {
          if (s === ENTER) this.#goInside(i, d)
          else state[i] = WALK // 出门完成，dest 在 #leaveShop 里已经换成下一站
        }
        continue
      }

      // WALK: 引导点 = 沿距离场往前 5 格；到目标 1.4m 内算到达
      this.scale[i] = Math.min(1, this.scale[i] + dt * 3) // 新进场的人约 0.33s 长到全尺寸
      const look = nav.lookAhead(d.field, x[i], y[i], 5, la)
      if (!look) { this.#free(i); continue } // 站在不可达处（被挤进死角 / 场未算出）: 直接消失，不要卡着抖
      if (la[2] < 1.4) { this.#arrive(i); continue }
      // 目标方向: 从当前位置指向引导点
      let gx = la[0] - x[i], gy = la[1] - y[i]
      let gl = Math.hypot(gx, gy) || 1
      if (la[2] > 6) { // 离目标还远才偏移；最后 6m 收拢到引导线上，保证能到 1.4m 内触发到达
        // 每人一条固定的横向偏移，让人流铺满人行道而不是排成一条线
        const ox = la[0] - (gy / gl) * this.lane[i], oy = la[1] + (gx / gl) * this.lane[i] // 引导点沿垂直方向平移 lane 米
        if (nav.isWalkable(ox, oy)) { gx = ox - x[i]; gy = oy - y[i]; gl = Math.hypot(gx, gy) || 1 } // 偏移点落在墙里就不偏
      }
      let ax = (gx / gl) * this.speed[i], ay = (gy / gl) * this.speed[i] // 期望速度 = 单位方向 × 个人步速

      // 分离力: 0.9m 内的邻居互相推开，力随距离线性增大
      // 这里的格号不夹到边界（与 #hash 不同），越界的格直接跳过
      const hc = Math.floor((x[i] - nav.minX) / this.hashCell), hr = Math.floor((y[i] - nav.minY) / this.hashCell)
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const c = hc + di, r = hr + dj
          if (c < 0 || r < 0 || c >= this.hashCols || r >= this.hashRows) continue
          for (let j = this.hashHead[r * this.hashCols + c]; j >= 0; j = this.hashNext[j]) {
            if (j === i) continue
            const dx = x[i] - x[j], dy = y[i] - y[j]
            const dd = dx * dx + dy * dy
            if (dd > 0.81 || dd < 1e-6) continue // 0.81 = 0.9²；完全重叠的两人方向不定，跳过
            const dl = Math.sqrt(dd), f = ((0.9 - dl) / 0.9) * 2.2 // 贴身时推力 2.2 m/s（比步速大，能把人挤开），0.9m 处归零
            ax += (dx / dl) * f; ay += (dy / dl) * f
          }
        }
      }

      // 速度低通，再试着走一步
      vx[i] += (ax - vx[i]) * steer
      vy[i] += (ay - vy[i]) * steer
      const nx = x[i] + vx[i] * dt, ny = y[i] + vy[i] * dt // 试探位置
      // 红灯: 正要从路沿踏上斑马线的人停下等；已经在路面上的继续走完
      // 条件: 下一步落在斑马线格（cwIndex ≥ 0）、此刻脚下还不是路面、且该斑马线的人行灯不放行
      if (this.signals) {
        const kn = nav.index(nx, ny)
        if (kn >= 0 && nav.cwIndex[kn] >= 0 && nav.surfaceAt(x[i], y[i]) !== SURFACE.ROAD && !this.signals.canWalk(nav.cwIndex[kn])) {
          vx[i] *= 0.5; vy[i] *= 0.5 // 不清零而是减半: 位置不动，但转身方向保留，等灯的人不会突然朝向乱转
          continue
        }
      }
      // 撞墙: 能走就走；不能就试着只走 x 或只走 y（沿墙滑）；都不行就减速
      if (nav.isWalkable(nx, ny)) { x[i] = nx; y[i] = ny }
      else if (nav.isWalkable(nx, y[i])) { x[i] = nx; vy[i] *= 0.3 } // 撞到横墙: 保留 x 方向，衰减 y 分量
      else if (nav.isWalkable(x[i], ny)) { y[i] = ny; vx[i] *= 0.3 }
      else { vx[i] *= 0.2; vy[i] *= 0.2 } // 顶在角落里: 大幅减速，下一步分离力 / 引导会把人带出来
      this.phase[i] += dt * 9 * this.speed[i] // 走路起伏的相位，速度越快摆得越快
    }
    if (write) this.#writeInstances()
  }

  /**
   * 真正进楼: 记账（visitors / insideCount）、定停留时长（店 / 办公 / 场馆各不同）、选热力落点
   * @param i 槽位，door[i] 已经指向进的那扇门
   * @param d 目的地记录（type === 'door'）
   */
  #goInside(i, d) {
    if (d.cat === 'home' && this.demand) return this.#free(i, this.home[i] === this.dest[i]) // 回到住处 = 离开仿真（住户记为在家）
    this.state[i] = INSIDE
    this.scale[i] = 0 // 楼内不可见
    this.timer[i] = (5 + this.rand() * 20) * 60 * this.dwellScale // 逛一家店 5~25 分钟（仿真时间）
    if (this.demand && d.cat === 'office') this.timer[i] = this.demand.officeStay(this.rand) // 上班: 待到下班，由需求模型按时段给
    if (this.demand && d.cat === 'venue') {
      const ph = this.demand.phaseOf(d.building)
      // 观众待到散场，再花 0~20 分钟陆续走出来
      // ev.end / clock.t 是毫秒，÷1000 换成仿真秒；已经在散场阶段进来的（铺场）按普通停留时长处理
      if (ph && ph.phase !== 'egress') { this.timer[i] = (ph.ev.end - this.demand.clock.t) / 1000 + this.rand() * 1200; this.afterEvent[i] = 1 }
    }
    // 记账
    const b = this.buildings.get(d.building)
    b.visitors++
    this.insideCount++
    // 热力落点: 取几个候选内点里离这扇门最近的，热区就会聚在对应店面后面
    // 只抽 4 个候选而不是全部里最近的: 保留随机性，热区是一片而不是一个点
    const dq = d.doors[this.door[i]]
    let best = null, bestD = Infinity
    for (let t = 0; t < 4 && b.interior.length; t++) {
      const p = b.interior[(this.rand() * b.interior.length) | 0]
      const dd = (p[0] - dq.x) ** 2 + (p[1] - dq.y) ** 2
      if (dd < bestD) { bestD = dd; best = p }
    }
    this.hx[i] = best ? best[0] : dq.x // 楼太小没有内点时退到门的位置
    this.hy[i] = best ? best[1] : dq.y
  }

  /**
   * 列车到站: 这一站的出入口排上 n 个人，接下来进场的人优先从这里出来（成批涌出，而不是均匀地从各个口冒出来）
   * @param station 车站名（与 portal.station 对应）
   * @param n       下车人数，平摊到该站的所有出入口；队列只是「优先级」，不额外增加总人数
   */
  arrive(station, n) {
    const ps = this.portals.filter((i) => this.dests[i].station === station)
    for (const i of ps) this.dests[i].queue += n / ps.length // 没有匹配的出入口时 ps 为空，循环不执行
  }

  /**
   * 补人时从哪个出入口进来: 先消耗车站的到站队列（列车刚到），否则按出入口权重抽
   * @returns dests 下标（调用方保证 portals 非空）
   */
  #pickPortal() {
    // 队列里凑够 1 个人就从队列里出: 按各口排队人数加权抽，抽中的口队列减 1
    let qTotal = 0
    for (const i of this.portals) qTotal += Math.max(0, this.dests[i].queue)
    if (qTotal >= 1) {
      let r = this.rand() * qTotal
      for (const i of this.portals) {
        r -= Math.max(0, this.dests[i].queue)
        if (r <= 0) { this.dests[i].queue -= 1; return i }
      }
    }
    // 没有到站队列: 按出入口权重轮盘赌
    let total = 0
    for (const i of this.portals) total += this.dests[i].weight
    let r = this.rand() * total
    for (const i of this.portals) { r -= this.dests[i].weight; if (r <= 0) return i }
    return this.portals[0] // 权重全 0 或浮点误差兜底
  }

  /** 哈希网格的格号（夹到网格范围内，地图边缘外的人归入边缘格） */
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
      const o = i * 16 // 每个实例一个 4x4 列主序矩阵
      const st = this.state[i]
      // 不可见: 缩放置零（只需清对角线和平移，其余元素上一次可见时写的旋转项乘 0 后无影响）
      if (st === FREE || st === INSIDE || this.scale[i] <= 0.001) {
        arr[o] = arr[o + 5] = arr[o + 10] = 0
        arr[o + 12] = arr[o + 13] = arr[o + 14] = 0
        arr[o + 15] = 1
        continue
      }
      const s = S * this.scale[i]
      const v = Math.hypot(this.vx[i], this.vy[i])
      const yaw = v > 0.05 ? Math.atan2(this.vx[i], this.vy[i]) : 0 // 几乎静止时不转身，避免抖动；地图 y 对应世界 z
      const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s
      // 绕 Y 轴旋转 yaw 再缩放 s，列主序
      arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0
      arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0
      arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0
      arr[o + 12] = this.x[i]
      arr[o + 13] = CURB_H + Math.abs(Math.sin(this.phase[i])) * 0.06 * s * Math.min(1, v) // 站在路沿高度上；走路时上下颠 ≤6cm，静止不颠
      arr[o + 14] = this.y[i]
      arr[o + 15] = 1
    }
    this.mesh.count = this.high // 只画到用过的最大槽位
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.colorsDirty) { this.mesh.instanceColor.needsUpdate = true; this.colorsDirty = false }
  }

  /**
   * (x,y) 半径 r 内正在走路的人数；onRoadOnly 时只数脚下是车行道的（= 正在过马路的），车流据此让行
   * 用的是上一次 update 建的哈希网格，所以只统计 WALK 状态的人；r 单位米
   */
  countNear(px, py, r, onRoadOnly = false) {
    const { nav, hashCell, hashCols, hashRows } = this
    // 覆盖 [px-r, px+r] × [py-r, py+r] 的格子范围，夹到网格内
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

  /**
   * 给界面和室内视图的统计:
   * { active, inside, walking, perBuilding{楼id: 在内人数}, groups[{id,label,active,target}]|null, residents{home,away,out}|null, events[] }
   * residents: home 在家、away 出了核心区、out 正在核心区里活动
   */
  stats() {
    const perBuilding = {}
    for (const [id, b] of this.buildings) perBuilding[id] = b.visitors
    const groups = this.demand ? GROUPS.map((g, k) => ({ id: g.id, label: g.label, active: this.groupActive[k], target: this.groupTargets[k] })) : null
    // 住户三态: home / away 从各住宅楼的账上汇总，out 要数一遍在场且有家的人（home[i] ≥ 0）
    let residents = null
    if (this.demand && (this.byCat.home || []).length) {
      residents = { home: 0, away: 0, out: 0 }
      for (const di of this.byCat.home) { residents.home += this.dests[di].atHome; residents.away += this.dests[di].away }
      for (let i = 0; i < this.high; i++) if (this.state[i] !== FREE && this.home[i] >= 0) residents.out++
    }
    return { active: this.active, inside: this.insideCount, walking: this.active - this.insideCount, perBuilding, groups, residents, events: this.demand?.upcoming() || [] }
  }

  /** 释放实例网格 */
  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
