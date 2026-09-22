// 车流（示意性，不是交通仿真）:
//   · 每条路按宽度分成单向 1~4 条车道，靠右行驶；进路段时按下一个路口要左转/直行/右转选内/中/外侧车道
//   · 跟车保持间距，看红绿灯，礼让行人
//   · 通行规则参照《道路交通安全法》第47条、《实施条例》第38/51/52条:
//       导向车道: 左转走最内侧、右转走最外侧、直行走中间；红灯可右转（先停、确认不妨碍行人和被放行车辆），不可左转/直行；
//       转弯让直行和行人；进环岛让环内车；行经人行横道遇行人停车让行
//   · 环岛: 环内逆时针单行，不设灯；高架: 独立一层，不与地面路网相交，靠自动生成的上/下匝道和桥下的主干路连通
//     （高架两端通到图外，所以匝道给地面路网带来了净流入和净流出）
//   · 超车: 路段中间（离路口够远）前车明显比自己慢、左侧车道有空档，就变到左侧车道超过去，拉开距离后驶回原车道；
//     不越过中心线借对向车道，要进匝道/停车场的车不超车
//   · 停车场和带地下车库的楼: 车会从最外侧车道拐进去停下/消失，也会定时有车开出来汇入车流
//
// 数据结构:
//   way   一条路的一个行驶方向: { from, to, edge, n(车道数), laneW, lanes[], twin(对向), level, roundabout }
//   lane  一条车道: { pts, cum, len, way, k(第几条，0 最内侧), off(距中心线), cars[](按 s 排序), crosswalks[], gates[], stopS(停车线) }
//   car   { mode: lane|turn|ramp|path|waiting|parked, lane, s(弧长), v, x, y, dx, dy, nextPlan, parkAt, lat(变道横移), ... }
//   node  路口: { pos, radius, degree, out[](出路), inn[](进路), busy, turning[](此刻在路口里的车) }
// 每个子步（≤0.25s）: 补车 → 设施进出 → 逐车按 mode 更新 → 写实例矩阵。跟车用「安全刹车距离」模型: want = min(vmax, √(2·3·gap))
import * as THREE from 'three'
import { carGeometry, carMaterial, CAR_COLORS, layoutParking } from './props.js'
import { SURFACE } from './navgrid.js'
import { signedArea } from './geometry.js'
import { CURB_H } from './ground.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { laneLayout, ELEVATED_H } from './roads.js'

// 长度单位一律为米、时间为仿真秒、速度 m/s；平面坐标沿用场景的图像坐标系（y 向下，所以「右手边」= (-dy, dx)）
const MIN_ROAD_WIDTH = 5.5 // 比这窄的路不走车（5.5m 以下按 laneLayout 连一条 3m 车道都排不下双向）
const CAR_LEN = 4.3 // 车长（米），跟车间距和停车线都按它算；car.x/y 是车身中心，车头 = 中心 + CAR_LEN/2
// 速度 (m/s): 直路 7.5 ≈ 27km/h（示意用，比真实慢，画面里才看得清）、转弯 4、停车场内 2.8、匝道 5.5；加速度、刹车 (m/s²)
// BRAKE=6 比 ACCEL=2.5 大很多: 让行 / 红灯要能在几米内停住，起步则要慢慢来，否则画面里像弹射
const V_MAX = 7.5, V_TURN = 4, V_LOT = 2.8, V_RAMP = 5.5, ACCEL = 2.5, BRAKE = 6
const RAMP_W = 4.4 // 匝道桥面宽（米），略宽于一条车道，画护栏时也按它定位
const LANE_CHANGE_V = 1.5 // 变道时的横移速度 (m/s)；一条 3.5m 车道大约横移 2.3s，和真实变道相当
const MERGE_LEN = 22 // 匝道到桥面标高后，并入/驶出主线的平段长度
const RAMP_LENS = [75, 60, 48] // 匝道水平长度（米），路段放得下就用长的；真实匝道更长，示例街区小，48m 时坡度约 13%

export class Traffic {
  /**
   * @param scene     场景数据（roadGraph / crosswalks / areas / buildings / angle）
   * @param nav       导航网格，只用 surfaceAt(x, y) 判断某点是建筑 / 水 / 绿地 / 人行道
   * @param rand      确定性随机源 () => [0,1)，同一种子出同一车流，测试可复现
   * @param density   目标车密度: 每米车道多少辆（1/110 ≈ 每 110m 车道一辆）
   * @param capacity  实例上限（含停着的车）
   * @param signals   红绿灯；null 时所有路口按「一次放一辆」
   */
  constructor(scene, nav, rand, { density = 1 / 110, capacity = 1500, signals = null } = {}) {
    this.nav = nav
    this.rand = rand
    this.signals = signals
    this.crowd = null // 由引擎在人群建好后注入
    this.capacity = capacity
    this.cars = [] // 所有车（含停在车位里的），下标 = 实例槽位
    this.parkingLines = [] // 停车位标线，交给地面模块画
    this.decor = new THREE.Group() // 匝道桥体、出入口压路沿、车库门洞等静态装饰
    this.decor.name = 'trafficDecor'
    // 建路网的顺序有依赖: 匝道要占用地面车道（way.reserved），设施选出入口时要避开被占用的车道
    this.#buildWays(scene)
    this.#buildRamps()
    this.#buildFacilities(scene)

    // 所有车共用一个 InstancedMesh，每帧只改矩阵；不做视锥剔除是因为包围球按第 0 个实例算、会整批消失
    this.mesh = new THREE.InstancedMesh(carGeometry(), carMaterial(), capacity)
    this.mesh.name = 'traffic'
    this.mesh.count = 0
    this.mesh.castShadow = true
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage) // 每帧都写，提示 GPU 用动态缓冲
    this.mesh.setColorAt(0, new THREE.Color('#fff')) // 先把 instanceColor 缓冲区建出来

    // 目标在途车数 = 车道总长 × 密度，封顶 400；setDemand 再按日曲线缩放
    const total = this.ways.reduce((s, w) => s + w.lanes[0].len * w.n, 0)
    this.baseTarget = Math.min(400, Math.round(total * density))
    this.target = this.baseTarget
    this.#seed()
  }

  // -------------------------------------------------------------------------
  // 路网
  // -------------------------------------------------------------------------
  /**
   * roadGraph 的每条边 → 两个方向的 way，每个 way 按路宽分出车道；再把斑马线挂到各车道上、算停车线位置
   * @param scene  需要 scene.roadGraph（{ nodes, edges }）和 scene.crosswalks；没有路网时建成空的，update 直接返回
   */
  #buildWays(scene) {
    const g = scene.roadGraph || { nodes: {}, edges: [] }
    this.nodes = {}
    for (const [id, n] of Object.entries(g.nodes)) this.nodes[id] = { ...n, busy: null, out: [], inn: [], turning: [] } // turning: 此刻正在这个路口里的车
    this.ways = []
    this.laneSeq = 0 // 车道全局编号，转弯轨迹缓存用 "a>b" 做键
    this.turnPaths = new Map() // 路口内轨迹缓存: 车道对 → 贝塞尔路径（见 #turnPath）
    g.edges.forEach((e, edgeIndex) => {
      if (e.width < MIN_ROAD_WIDTH || e.points.length < 2) return // 太窄的路、退化的边不建车道
      // 车道数 / 单车道宽 / 各车道相对中心线的偏移都由 roads.js 统一算，保证和画出来的标线一致
      const { n, laneW, offsets } = laneLayout(e.width, !!e.oneway, e.median || 0)
      const pair = []
      // 单行路只建 oneway 指定的那个方向（1 = a→b，-1 = b→a）；双向路两个方向各建一个 way
      for (const dir of e.oneway ? [e.oneway] : [1, -1]) {
        const pts = dir === 1 ? e.points : [...e.points].reverse()
        const from = dir === 1 ? e.a : e.b, to = dir === 1 ? e.b : e.a
        const way = { from, to, edge: e, edgeIndex, n, laneW, lanes: [], twin: null, level: e.level || 0, roundabout: !!e.roundabout }
        for (let k = 0; k < n; k++) {
          // ext: 两端路口沿本路方向的进深 [起点端, 终点端]，反向行驶时要对调
          const ext = e.ext ? (dir === 1 ? e.ext : [e.ext[1], e.ext[0]]) : null
          const lane = this.#makeLane(pts, offsets[k], this.nodes[from], this.nodes[to], way.roundabout, ext)
          if (!lane) break // 截短后太短，这条路整个方向都放弃
          Object.assign(lane, { id: this.laneSeq++, way, k, off: offsets[k], cars: [], crosswalks: [], gates: [], onRamp: null, offRamp: null })
          lane.sample = (s) => samplePolyline(lane.pts, lane.cum, s, {}) // 弧长 s → { x, y, dx, dy }
          way.lanes.push(lane)
        }
        if (way.lanes.length !== n) continue // 有车道建不出来就不要这个方向，否则导向车道的 k 会对不上
        this.ways.push(way)
        this.nodes[from].out.push(way)
        this.nodes[to].inn.push(way)
        pair.push(way)
      }
      // 双向路的两个 way 互为 twin: 选下一条路时不掉头（排除 twin）
      if (pair.length === 2) { pair[0].twin = pair[1]; pair[1].twin = pair[0] }
    })
    this.lanes = this.ways.flatMap((w) => w.lanes)
    for (const lane of this.lanes) {
      // 把斑马线挂到经过它的每条车道上（高架上没有斑马线）: 斑马线中心投影到车道，距离在路宽 0.6 倍内就算这条路上的
      for (const c of lane.way.level ? [] : scene.crosswalks || []) {
        const hit = projectOnPolyline(lane.pts, lane.cum, c.center[0], c.center[1])
        if (hit.dist < lane.way.edge.width * 0.6) lane.crosswalks.push({ s: hit.s, cw: c })
      }
      lane.crosswalks.sort((a, b) => a.s - b.s) // 按弧长排序，[0] 是刚进这条路时的第一条（出口斑马线）
      // 停车线: 进路口前最后一条斑马线的外侧；没有斑马线就停在车道尽头
      // 只认离路口 25m 内的斑马线（更远的是路段中间的过街斑马线，不是路口那条）；1.4m 是停车线到斑马线的净距
      const last = lane.crosswalks[lane.crosswalks.length - 1]
      lane.stopS = last && lane.len - last.s < 25 ? Math.max(1, last.s - last.cw.depth / 2 - 1.4) : lane.len - 1
    }
    // 入口路: 起点是图边界上的悬挂节点（度 ≤ 1），补车从这里进来
    this.entries = this.ways.filter((w) => this.nodes[w.from].degree <= 1)
  }

  /**
   * 中心线向右偏移 off 得到车道线（右 = (-dy, dx)，图像坐标 y 向下），两端在路口处截短
   * @param center    这个行驶方向的中心线折线
   * @param off       车道中心到道路中心线的距离（米，右为正）
   * @param nodeFrom  起点路口；度 ≥3 的才截短，度 ≤2 的只是折线拐点 / 图边界
   * @param nodeTo    终点路口
   * @param ring      是否环岛内的环道
   * @param ext       [起点端, 终点端] 路口进深（米），可能为 null
   * @returns {{ pts, cum, len } | null}  截短后太短返回 null
   */
  #makeLane(center, off, nodeFrom, nodeTo, ring = false, ext = null) {
    const n = center.length
    const out = []
    // 每个顶点处的法向用前后两点的连线算（端点退化成相邻一段），拐角处偏移不会撕开
    for (let i = 0; i < n; i++) {
      const a = center[Math.max(0, i - 1)], b = center[Math.min(n - 1, i + 1)]
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1
      out.push([center[i][0] - (dy / l) * off, center[i][1] + (dx / l) * off])
    }
    let cum = cumulative(out)
    // 环道的弧段本来就短（两个进口之间常常只有二三十米），少截一点、放宽最短长度，否则内圈车道会被丢掉
    const k = ring ? 0.5 : 1.05
    // 优先用脚本给的「路口沿本路方向的进深」；老场景文件没有就退回路口半径
    // 车的坐标是车身中心，车头还要往前探半个车长，所以在路口进深之外再退半个车身多一点，停下时车头才不会伸进横向车道
    const trimA = nodeFrom.degree >= 3 ? (ext && !ring ? ext[0] + CAR_LEN / 2 + 1.0 : nodeFrom.radius * k) : 0
    const trimB = nodeTo.degree >= 3 ? (ext && !ring ? ext[1] + CAR_LEN / 2 + 1.0 : nodeTo.radius * k) : 0
    const len = cum[cum.length - 1]
    if (len - trimA - trimB < (ring ? 3 : 8)) return null // 截完剩不到 8m（环道 3m）放不下一辆车加间距，不建
    const pts = slicePolyline(out, cum, trimA, len - trimB)
    cum = cumulative(pts) // 截短后重算累计弧长，lane.s 从截短后的起点起算
    return { pts, cum, len: cum[cum.length - 1] }
  }

  /**
   * 高架匝道。对高架的每个行驶方向:
   *   在它正下方、同向的地面路里找「紧贴桥面外侧的那条车道」，整条留作匝道车道（别的车不走，否则会从匝道里穿过去）；
   *   靠前的一段放上桥匝道，靠后的一段放下桥匝道。匝道低的那一半避开斑马线。
   */
  #buildRamps() {
    this.ramps = [] // 匝道: { type: on|off, eLane(高架车道), sLane(地面匝道车道), ss0, es0, es1, rlen, pts, cum, len, cars[] }
    this.islands = [] // 匝道岛（坡体和被占用车道的无车段），交给地面画成隔离带
    for (const ew of this.ways.filter((w) => w.level)) {
      const eLane = ew.lanes[ew.n - 1] // 高架最外侧车道: 匝道只和它接
      const deckHalf = ew.edge.width / 2 // 桥面半宽（米）
      const found = { on: null, off: null } // 这个行驶方向各找至多一条上桥、一条下桥匝道
      for (const sw of this.ways) {
        if (sw.level || sw.roundabout || sw.n < 2) continue // 候选地面路: 不在高架上、不是环道、至少 2 车道（留一条给匝道后还有得走）
        const k = sw.lanes.findIndex((l) => l.off - RAMP_W / 2 > deckHalf - 0.6) // 匝道全宽都要在桥面外侧，否则爬升段会和主桥穿模
        if (k < 0 || (sw.reserved !== undefined && sw.reserved !== k)) continue // 这条路已经被别的匝道占了另一条车道就跳过
        const sl = sw.lanes[k]
        // 长度从长到短试: 长匝道坡缓、好看；路段短就退而求其次
        for (const type of ['on', 'off']) for (const RAMP_LEN of RAMP_LENS) {
          if (sl.len < RAMP_LEN + 24) continue // 匝道前后各要留 10m/14m 的直路
          // 上桥匝道尽量靠路段前部，下桥匝道尽量靠后部
          const starts = []
          for (let s0 = 10; s0 + RAMP_LEN <= sl.len - 14; s0 += 4) starts.push(s0) // 每 4m 试一个起点
          if (type === 'off') starts.reverse()
          for (const s0 of starts) {
            // 匝道两端投影到高架车道上: 距离要在桥侧 9m 内，且弧长差不小于匝道长的 0.8（同向且大致平行）
            const a = sl.sample(s0), b = sl.sample(s0 + RAMP_LEN)
            const ha = projectOnPolyline(eLane.pts, eLane.cum, a.x, a.y), hb = projectOnPolyline(eLane.pts, eLane.cum, b.x, b.y)
            if (ha.dist > deckHalf + 9 || hb.dist > deckHalf + 9 || hb.s - ha.s < RAMP_LEN * 0.8) continue // 要在桥的正侧下方、且同向
            if (type === 'on' ? hb.s + MERGE_LEN > eLane.len - 8 : ha.s - MERGE_LEN < 8) continue // 桥上还要留出并线平段
            if (ha.s < 10 || hb.s > eLane.len - 10) continue // 高架车道两端各留 10m
            // 匝道低的那一半（上桥是前 55%，下桥是后 55%）不能压着斑马线，否则行人会从坡体里穿过
            const low = type === 'on' ? [s0 - 6, s0 + RAMP_LEN * 0.55] : [s0 + RAMP_LEN * 0.45, s0 + RAMP_LEN + 6]
            if (sl.crosswalks.some((c) => c.s > low[0] && c.s < low[1])) continue
            // 多条地面路都能放时: 上桥选桥上位置最靠前的，下桥选最靠后的，两者相距最远、桥上有足够路程
            const better = !found[type] || (type === 'on' ? ha.s < found[type].es0 : ha.s > found[type].es0)
            if (better) found[type] = { type, eLane, sLane: sl, ss0: s0, es0: ha.s, es1: hb.s, rlen: RAMP_LEN }
            break // 这条车道上第一个可行起点就是最优的（起点已按优先顺序排过）
          }
          if (found[type]?.sLane === sl) break // 这条路上已经用较长的长度放下了，不再试更短的
        }
      }
      // 同一方向上: 先上桥、后下桥，两者不能重叠（各自的并线平段之间至少再留 10m）
      if (found.on && found.off && found.off.es0 - MERGE_LEN < found.on.es1 + MERGE_LEN + 10) found.off = null
      for (const r of [found.on, found.off]) {
        if (!r) continue
        r.sLane.way.reserved = r.sLane.k // 整条地面车道留给匝道，#plan 里其他车不再选它
        // 走法和真匝道一样: 坡段全程贴在桥面外侧、正好在地面匝道车道的上方（不和主桥重叠）；
        // 到了桥面标高，再用一段平的并线段横移进/出主线最外侧车道。pts: [x, y, 高度, 是否并线段]
        const smooth = (t) => t * t * (3 - 2 * t) // smoothstep: 坡的两端切线水平，起坡 / 到顶不会有折角
        const slope = [], merge = []
        // 坡段: 沿地面匝道车道取 15 个点，高度从 0 平滑升到桥面高（下桥则反过来）
        for (let i = 0; i <= 14; i++) {
          const t = i / 14, B = r.sLane.sample(r.ss0 + r.rlen * t)
          slope.push([B.x, B.y, ELEVATED_H * smooth(r.type === 'on' ? t : 1 - t), 0])
        }
        const top = r.type === 'on' ? slope[slope.length - 1] : slope[0] // 坡顶
        const eTop = r.eLane.sample(r.type === 'on' ? r.es1 : r.es0)
        const dX = top[0] - eTop.x, dY = top[1] - eTop.y // 坡顶相对主线车道的横向偏移
        // 并线段: 沿高架车道走 MERGE_LEN，横向偏移从 (dX, dY) 平滑收到 0（上桥）或从 0 放到 (dX, dY)（下桥）
        for (let i = 0; i <= 8; i++) {
          const u = i / 8
          const es = r.type === 'on' ? r.es1 + MERGE_LEN * u : r.es0 - MERGE_LEN * (1 - u)
          const A = r.eLane.sample(es), k = r.type === 'on' ? 1 - smooth(u) : smooth(u)
          merge.push([A.x + dX * k, A.y + dY * k, ELEVATED_H, 1])
        }
        // 拼成一条折线，按行驶顺序: 上桥 = 坡段→并线段，下桥 = 并线段→坡段；接缝处的重复点去掉
        r.pts = r.type === 'on' ? [...slope, ...merge.slice(1)] : [...merge, ...slope.slice(1)]
        r.eFrom = r.es0 - MERGE_LEN // 下桥: 车在主线上的这个位置开始驶出
        r.eTo = r.es1 + MERGE_LEN   // 上桥: 车在主线上的这个位置完成汇入
        r.gap = merge.map((q) => [q[0], q[1]]) // 主桥护栏在这一段要留缺口
        // 匝道岛: 坡体下面 + 这条匝道车道上没车走的那一段，交给地面并进隔离带
        // 上桥: 起坡 9m 之后到车道尽头都没车；下桥: 车道起点到落地前 9m 都没车（9m 内坡还很低，车能从旁边看见）
        const L = r.sLane
        const [i0, i1] = r.type === 'on' ? [r.ss0 + 9, L.len] : [0, r.ss0 + r.rlen - 9]
        const isl = []
        for (let sI = i0; sI < i1; sI += 4) { const q = L.sample(sI); isl.push([q.x, q.y]) }
        const qe = L.sample(i1)
        isl.push([qe.x, qe.y])
        this.islands.push({ pts: isl, width: L.way.laneW + 0.2 }) // 比车道略宽 0.2m，盖住标线
        r.cum = cumulative(r.pts) // 匝道弧长按平面距离算（坡度不大，车速按平面走差别看不出）
        r.len = r.cum[r.cum.length - 1]
        r.cars = [] // 匝道上的车，先上的在前
        // 挂到车道上: 地面匝道车道知道自己的上桥匝道，高架车道知道自己的下桥匝道（#enterLane / #plan 用）
        if (r.type === 'on') r.sLane.onRamp = r
        else r.eLane.offRamp = r
        this.ramps.push(r)
      }
    }
    this.#buildRampMeshes()
  }

  /** 匝道的桥体（一段段斜放的盒子）、两侧护栏、桥墩，各合并成一个 Mesh 挂到 decor 下 */
  #buildRampMeshes() {
    if (!this.ramps.length) return
    const boxes = [], rails = [], piers = []
    // 复用的临时向量 / 矩阵；three.js 里 Y 向上，平面 (x, y) → 三维 (x, ·, y)
    const dir = new THREE.Vector3(), right = new THREE.Vector3(), upv = new THREE.Vector3(), worldUp = new THREE.Vector3(0, 1, 0), m = new THREE.Matrix4()
    for (const r of this.ramps) {
      let sincePier = 0 // 距上一根桥墩的沿坡长度（米）
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i], b = r.pts[i + 1]
        const hm = (a[2] + b[2]) / 2 - 0.03 // 比主桥面低一点点，和桥面重叠的部分被桥面盖住，不会闪烁
        if (hm < 0.12) continue // 已经贴地的那一小段不用画
        dir.set(b[0] - a[0], b[2] - a[2], b[1] - a[1]) // 这一段的三维走向（含爬升）
        const L = dir.length()
        // 显式构造基: X 沿坡面前进方向，Z 水平向右，Y 垂直坡面。用「两向量间最短旋转」会带上滚转，桥面就拧了
        dir.normalize()
        right.crossVectors(dir, worldUp).normalize()
        upv.crossVectors(right, dir)
        m.makeBasis(dir, upv, right).setPosition((a[0] + b[0]) / 2, hm - 0.28, (a[1] + b[1]) / 2) // 盒子厚 0.5，中心下沉 0.28 让顶面在 hm
        boxes.push(new THREE.BoxGeometry(L + 0.15, 0.5, RAMP_W).applyMatrix4(m)) // 长度多 0.15m，相邻段之间不露缝
        // 哪一侧朝着主桥: 看主线车道在匝道的左边还是右边（局部 +Z = 行进方向的右侧）
        const e = r.eLane.sample(projectOnPolyline(r.eLane.pts, r.eLane.cum, a[0], a[1]).s)
        const bridgeSide = (e.x - a[0]) * right.x + (e.y - a[1]) * right.z > 0 ? 1 : -1
        for (const sgn of [-1, 1]) {
          // 朝桥的一侧: 并线段不设护栏（车要横移过去）；坡段接近桥面标高时主桥自己的护栏已经在那儿了
          if (sgn === bridgeSide && (b[3] || a[3] || hm > ELEVATED_H - 0.9)) continue
          const g = new THREE.BoxGeometry(L + 0.15, 0.9, 0.22) // 护栏高 0.9m、厚 0.22m
          g.translate(0, 0.7, sgn * (RAMP_W / 2 - 0.1)) // 立在桥面边缘内 0.1m，底部略埋进桥体
          rails.push(g.applyMatrix4(m))
        }
        sincePier += L
        // 桥墩: 离地 2.2m 以上才立（更矮的坡体直接坐在地上），快到桥面高时主桥自己有墩；约每 14m 一根
        if (hm > 2.2 && hm < ELEVATED_H - 0.6 && sincePier > 14) {
          sincePier = 0
          const pg = new THREE.BoxGeometry(1.0, hm - 0.5, 1.6) // 墩顶到桥体底面（桥体厚 0.5）
          pg.rotateY(Math.atan2(-(b[1] - a[1]), b[0] - a[0])) // 长边顺着匝道方向
          pg.translate((a[0] + b[0]) / 2, (hm - 0.5) / 2, (a[1] + b[1]) / 2)
          piers.push(pg)
        }
      }
    }
    // 同一类几何合并成一个 Mesh（一个 draw call）；去掉 uv 是因为各盒子的属性布局要一致才能合并
    const add = (geos, color) => {
      if (!geos.length) return
      const mesh = new THREE.Mesh(mergeGeometries(geos.map((g) => { g.deleteAttribute('uv'); return g.toNonIndexed() })), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }))
      mesh.castShadow = mesh.receiveShadow = true
      this.decor.add(mesh)
    }
    add(boxes, '#666a72') // 桥体: 深灰
    add(rails, '#eef0f2') // 护栏: 近白
    add(piers, '#c4c8ce') // 桥墩: 浅灰
  }

  /**
   * 给红绿灯用: 每个有灯路口的每个进口道，灯杆位置 + 停车线
   * @returns {Array<{ node, edge, dx, dy, post: [x, y], stopLine: { center, length } }>}
   *   post 在最外侧车道停车线的右侧路沿外（灯杆立在人行道上）；stopLine 横跨这个方向的全部车道
   */
  signalSites() {
    const sites = []
    for (const way of this.ways) {
      if (!this.signals?.has(way.to)) continue // 只有装了灯的路口才有
      const outer = way.lanes[way.n - 1], inner = way.lanes[0]
      const po = outer.sample(outer.stopS), pi = inner.sample(inner.stopS)
      const side = way.laneW / 2 + 1.6 // 外侧车道中心 → 路沿再往外 1.6m
      sites.push({
        node: way.to, edge: way.edgeIndex, dx: po.dx, dy: po.dy,
        post: [po.x - po.dy * side, po.y + po.dx * side], // 右手边 = (-dy, dx)
        stopLine: { center: [(po.x + pi.x) / 2 + po.dx * 0.5, (po.y + pi.y) / 2 + po.dy * 0.5], length: way.laneW * way.n - 0.5 }, // 往前 0.5m 让线画在车头前
      })
    }
    return sites
  }

  // -------------------------------------------------------------------------
  // 停车场 / 地下车库
  // -------------------------------------------------------------------------
  /**
   * 停车场和地下车库。每个设施找一条离它最近、且设施在其右手边的外侧车道开出入口（右进右出）；
   * 停车场按 layoutParking 排车位并预置六成的车；面积 ≥1200㎡ 且临路的楼配地下车库（只记占用数，不画车位）
   */
  #buildFacilities(scene) {
    this.facilities = [] // { type: lot|garage, gate: { lane, s, point, dx, dy } | null, timer, waiting, ... }
    const outerLanes = this.lanes.filter((l) => l.k === l.way.n - 1) // 出入口只开在最外侧车道
    const driveways = [] // [设施边界上的入口点, gate]，给 #buildDecor 画压路沿

    /** 找离 (cx, cy) 最近、且设施在其右手边的外侧车道，返回 { lane, s, point, d, dx, dy } 或 null */
    const findGate = (cx, cy, maxDist) => {
      let best = null
      for (const lane of outerLanes) {
        // 排除: 太短的路（进出要各留 14m/20m）、高架、环道、被匝道占用的车道
        if (lane.len < 40 || lane.way.level || lane.way.roundabout || lane.way.reserved === lane.k) continue
        const hit = projectOnPolyline(lane.pts, lane.cum, cx, cy)
        const s = Math.min(lane.len - 20, Math.max(14, hit.s)) // 出入口离路口两端各留一段，别在路口里拐
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
      // 每米采样一次导航面；skipStart 跳过起点附近（起点本身就在设施边界 / 楼边上）
      for (let t = skipStart; t < L; t += 1) {
        const sf = this.nav.surfaceAt(a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L)
        if (sf === SURFACE.BUILDING || sf === SURFACE.WATER || sf === SURFACE.GREEN) return false
      }
      return true
    }

    // 露天停车场
    for (const area of (scene.areas || []).filter((a) => a.kind === 'parking')) {
      const c = centroid(area.polygon)
      const gate = findGate(c[0], c[1], 120) // 120m 内没有合适的路就当封闭停车场（只摆车，不进出）
      const entry = gate ? nearestOnPolygon(area.polygon, gate.point) : null // 场地边界上离路最近的点 = 入口
      const usable = !!gate && clearOf(entry, gate.point, 0.5)
      // 车位排布交给 props.js；有入口时车位的 route 会从入口通道出发
      const lay = layoutParking(area, scene.angle || 0, usable ? entry : null)
      this.parkingLines.push(...lay.lines)
      const fac = { type: 'lot', gate: usable ? gate : null, stalls: lay.stalls, timer: 3 + this.rand() * 8, waiting: null } // timer: 距下次出车的秒数
      for (const st of fac.stalls) {
        st.car = null // 停在这个车位的车
        st.reserved = false // 已被路上某辆车选中、正在开来
        st.pathOut = usable ? dedupe([...st.route, entry, gate.point]) : null // 车位 → 场内通道 → 入口 → 路上的出入口点
        if (this.rand() < 0.6) { // 开场六成车位有车
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
      if (area < 1200) continue // 1200㎡ 以下的楼不配车库（大约 25 个车位以下不值得）
      const c = centroid(b.polygon)
      const gate = findGate(c[0], c[1], 110)
      if (!gate) continue
      const entry = nearestOnPolygon(b.polygon, gate.point) // 楼边上离路最近的点 = 门洞
      const L = Math.hypot(gate.point[0] - entry[0], gate.point[1] - entry[1])
      if (L > 30 || L < 3 || !clearOf(entry, gate.point, 1.5)) continue // 门洞到路要 3~30m，太近画不下门洞、太远像穿过别的地块
      const nrm = [(gate.point[0] - entry[0]) / L, (gate.point[1] - entry[1]) / L] // 门洞朝外的单位法向
      const inside = [entry[0] - nrm[0] * 5, entry[1] - nrm[1] * 5] // 门内 5m: 车从这里淡入 / 淡出
      const capacity = Math.round(area / 45) // 每 45㎡ 楼底面积一个车位
      const fac = {
        type: 'garage', building: b.id, gate, capacity, occupied: Math.round(capacity * (0.45 + this.rand() * 0.3)), reserved: 0, // 开场占用 45%~75%
        pathOut: [inside, entry, gate.point], entry, normal: nrm, timer: 4 + this.rand() * 10, waiting: null,
      }
      gate.lane.gates.push({ s: gate.s, fac })
      driveways.push([entry, gate])
      this.facilities.push(fac)
    }
    for (const lane of this.lanes) lane.gates.sort((a, b) => a.s - b.s) // #enterLane 按弧长顺序挑最先遇到的出入口
    this.garages = this.facilities.filter((f) => f.type === 'garage')
    this.#buildDecor(driveways)
  }

  /** 出入口的压路沿车道（盖在人行道上的一条沥青）+ 车库门洞 */
  #buildDecor(driveways) {
    // 城区里有上百个出入口，逐个建 Mesh 会多出上百个 draw call，合并成两个
    const strips = [], doors = []
    for (const [entry, gate] of driveways) {
      const side = gate.lane.way.laneW / 2 // 车道中心 → 右侧路沿
      const end = [gate.point[0] - gate.dy * side, gate.point[1] + gate.dx * side] // 压路沿从设施入口铺到路沿为止，不盖到车道上
      const dx = end[0] - entry[0], dy = end[1] - entry[1], L = Math.hypot(dx, dy)
      if (L < 0.5) continue // 入口紧贴路沿，没有人行道要盖
      const g = new THREE.BoxGeometry(L, 0.02, 5.6).toNonIndexed() // 宽 5.6m: 一进一出两个车身
      g.rotateY(Math.atan2(-dy, dx)) // 三维 Z = 平面 y，所以绕 Y 轴的角度取 -dy
      g.translate((entry[0] + end[0]) / 2, CURB_H + 0.012, (entry[1] + end[1]) / 2) // 略高于路沿面，避免和人行道 z-fighting
      strips.push(g)
    }
    for (const f of this.garages) {
      const g = new THREE.BoxGeometry(0.5, 3.0, 5.6).toNonIndexed() // 门洞: 深色薄板，3m 高 5.6m 宽
      g.rotateY(Math.atan2(-f.normal[1], f.normal[0]))
      g.translate(f.entry[0] + f.normal[0] * 0.12, CURB_H + 1.5, f.entry[1] + f.normal[1] * 0.12) // 沿法向探出楼面 0.12m 才不被墙盖住
      doors.push(g)
    }
    const add = (geos, color) => {
      if (!geos.length) return
      const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color, roughness: 0.95 }))
      mesh.receiveShadow = true
      this.decor.add(mesh)
    }
    add(strips, '#6a6f77') // 沥青色
    add(doors, '#1e2228') // 门洞: 近黑，看起来是通向地下的洞
  }

  /**
   * 给楼的信息面板 / 人群模块用: 某栋楼的地下车库概况
   * @param buildingId  楼的 id
   * @returns {{ capacity, occupied, entry, normal } | null}  这栋楼没有车库时返回 null
   */
    garageInfo(buildingId) {
    const f = this.garages.find((g) => g.building === buildingId)
    return f ? { capacity: f.capacity, occupied: f.occupied, entry: f.entry, normal: f.normal } : null
  }

  // -------------------------------------------------------------------------
  // 车
  // -------------------------------------------------------------------------
  /**
   * 新车: 两成慢车（vmax 0.5~0.65 倍）才会出现超车
   * 字段: mode 状态机 / lane, s 车道与弧长 / v 速度 / level 是否高架 / move 下个路口的转向 L|S|R / rtor 红灯右转已获准
   *       x, y, dx, dy 位置和朝向 / scale 车库门洞淡入淡出 / wait, push 让行计时与「等太久强行通过」倒计时
   *       lat 变道横向偏差 / ghost 变道时留在原车道的占位 / homeK, passing 超车前的车道号和被超的车
   * @returns 新车对象（已加入 this.cars）
   */
  #newCar() {
    const car = {
      id: (this.carSeq = (this.carSeq || 0) + 1), mode: 'lane', lane: null, s: 0, v: 0, level: 0, move: 'S', rtor: false, x: 0, y: 0, dx: 1, dy: 0, scale: 1, wait: 0, push: 0, nextWay: null, nextPlan: null, parkAt: null,
      color: CAR_COLORS[(this.rand() * CAR_COLORS.length) | 0], vmax: V_MAX * (this.rand() < 0.2 ? 0.5 + this.rand() * 0.15 : 0.85 + this.rand() * 0.3), // 两成是慢车
      lat: 0, ghost: null, homeK: -1, passing: null,
    }
    this.cars.push(car)
    this.colorsDirty = true // 新增实例槽位，颜色缓冲要重写
    this._rc = -1 // 在途车数缓存失效
    return car
  }

  /**
   * 车出图 / 进车库: 从列表删掉，颜色缓冲要重写
   * @param car  要删的车；调用方负责先把它从车道 / 匝道 / 路口列表里摘掉
   */
  #remove(car) {
    const i = this.cars.indexOf(car)
    if (i >= 0) this.cars.splice(i, 1)
    this.colorsDirty = true
  }

  /**
   * 从 way 开到 nextWay 算左转/直行/右转（y 向下的坐标里叉积为正 = 右转）
   * @returns {'L'|'S'|'R'}  没有下一条路（出图）当直行
   */
  #moveOf(way, nextWay) {
    if (!nextWay) return 'S'
    const a = way.lanes[0], b = nextWay.lanes[0]
    // 用两条路最内侧车道的末端 / 起始方向算夹角的正弦；±0.4 ≈ 24° 以内算直行
    const d0 = dirAt(a.pts, a.pts.length - 1), d2 = dirAt(b.pts, 1)
    const cross = d0[0] * d2[1] - d0[1] * d2[0]
    return cross > 0.4 ? 'R' : cross < -0.4 ? 'L' : 'S'
  }

  /**
   * 进入某条路时就定好: 到头后去哪条路、因此该走哪条导向车道。
   *   ≥3 车道: 最内侧左转专用、最外侧右转专用、中间直行；2 车道: 内侧左转+直行、外侧右转+直行；1 车道: 混行
   */
  #plan(way) {
    // 下一条路: 从终点路口的出路里随机挑一条，不掉头（排除 twin）；路口是图边界（没有出路）就出图
    const opts = this.nodes[way.to].out.filter((w) => w !== way.twin)
    const nextWay = opts.length ? opts[(this.rand() * opts.length) | 0] : null
    const move = this.#moveOf(way, nextWay)
    const n = way.n
    let k = (this.rand() * n) | 0 // 默认随机车道（单车道 / 出图的车用它）
    if (nextWay && n > 1 && !way.roundabout) {
      // 导向车道（实施条例第51条）: 左转最内侧、右转最外侧；≥3 车道时直行只走中间几条，2 车道时直行随机内 / 外
      if (move === 'L') k = 0
      else if (move === 'R') k = n - 1
      else if (n >= 3) k = 1 + ((this.rand() * (n - 2)) | 0)
    } else if (way.roundabout && n > 1) k = move === 'R' ? n - 1 : 0 // 环内: 下个口出环走外圈，继续绕走内圈
    // 这条路上有匝道车道: 要上桥的车走它，其余的车让开
    if (way.reserved !== undefined) {
      const ramp = way.lanes[way.reserved].onRamp
      if (ramp && this.rand() < 0.3) return { lane: way.lanes[way.reserved], nextWay, move, ramp } // 三成的车上高架
      if (k === way.reserved) k = k > 0 ? k - 1 : k + 1 // 随机到了匝道车道就挪到相邻车道
    }
    return { lane: way.lanes[k], nextWay, move }
  }

  /**
   * 车进入一条车道（从路口出来、从匝道下来、从设施出来、开场铺车）。
   * 顺带决定: 要不要在这条路上拐进某个停车场 / 车库（三成概率，路上车多时七成）、要不要走匝道下桥
   */
  #enterLane(car, lane, nextWay, s = 0, ramp = null) {
    // 要走的匝道: 调用方指定的上桥匝道；或者这条高架车道有下桥匝道、驶出点还在前方 5m 外时 45% 概率下桥
    car.takeRamp = ramp || (lane.offRamp && lane.offRamp.eFrom > s + 5 && this.rand() < 0.45 ? lane.offRamp : null)
    car.h = undefined // 高度只在匝道上有意义，#write 按 level 定桥面高
    car.mode = 'lane'
    car.move = this.#moveOf(lane.way, nextWay)
    car.rtor = false // 红灯右转的许可每进一条路重置
    car.level = lane.way.level
    car.lane = lane
    car.s = s
    car.nextWay = nextWay
    car.nextPlan = nextWay ? this.#plan(nextWay) : null // 提前一段路定好再下一步，转弯时才知道进哪条车道
    car.turn = null
    car.parkAt = null
    // 这条车道旁有停车场/车库且有空位 → 一定概率拐进去
    for (const g of lane.gates) {
      if (g.s < s + 15 || this.rand() > (this.roadCount > this.target ? 0.7 : 0.25)) continue // 路上车多时更愿意停进去
      const f = g.fac
      if (f.type === 'lot') {
        // 停车场: 挑一个空且没被预订的车位并预订，避免两辆车奔同一个位
        const free = f.stalls.filter((st) => !st.car && !st.reserved)
        if (!free.length) continue
        const st = free[(this.rand() * free.length) | 0]
        st.reserved = true
        car.parkAt = { gate: g, fac: f, stall: st }
      } else {
        // 车库: 只记数，占用 + 在途预订不能超过容量
        if (f.occupied + f.reserved >= f.capacity) continue
        f.reserved++
        car.parkAt = { gate: g, fac: f }
      }
      break // 一条路上最多选一个设施
    }
    // 插进车道的 cars 列表，保持按 s 升序（跟车只看 idx+1）
    const idx = lane.cars.findIndex((c) => c.s > s)
    if (idx < 0) lane.cars.push(car)
    else lane.cars.splice(idx, 0, car)
    samplePolyline(lane.pts, lane.cum, s, car) // 立刻写好 x, y, dx, dy，本步 #write 就能画
  }

  /** 开场铺车: 随机车道随机位置，彼此至少隔 12m */
  #seed() {
    let guard = this.target * 20, n = 0 // guard: 路网太小铺不下 target 辆时不要死循环
    while (n < this.target && guard-- > 0 && this.ways.length) {
      const way = this.ways[(this.rand() * this.ways.length) | 0]
      const plan = this.#plan(way) // 铺车也走导向车道逻辑，开场就是「对的」车道
      const s = this.rand() * plan.lane.len
      if (plan.lane.cars.some((c) => Math.abs(c.s - s) < 12)) continue // 12m ≈ 车长 + 一个正常跟车距
      const car = this.#newCar()
      car.v = V_MAX * 0.6 // 开场就在动，不是齐刷刷起步
      // 铺在匝道起点之后的车来不及上匝道，就当普通车走
      this.#enterLane(car, plan.lane, plan.nextWay, s, plan.ramp && plan.ramp.ss0 > s + 5 ? plan.ramp : null)
      n++
    }
  }

  /**
   * 车流强度 0~1（来自仿真时钟的日曲线）。目标车数降下来后，多出来的车会更愿意拐进停车场/车库或开出图外
   * @param f  强度系数；下限 0.12，深夜也留一成多的车，画面不至于空
   */
  setDemand(f) { this.target = Math.round(this.baseTarget * Math.max(0.12, f)) }

  /** 在途车数（车道上 / 路口里 / 匝道上），每个子步只数一次；停着的、场内 path 上的、等出口的都不算 */
  get roadCount() {
    if (this._rc >= 0) return this._rc // -1 表示缓存失效
    let n = 0
    for (const c of this.cars) if (c.mode === 'lane' || c.mode === 'turn' || c.mode === 'ramp') n++
    return (this._rc = n)
  }

  /**
   * dt = 仿真秒；write=false 时不写实例矩阵（一帧多个子步，只有最后一步要写）
   * 引擎保证 dt ≤ 0.25s: 跟车模型是显式积分，步长太大时刹车距离会算不准、车会追尾
   * @param dt     这个子步的仿真秒数
   * @param write  是否把结果写进 InstancedMesh
   */
  update(dt, write = true) {
    if (!this.ways.length) return
    this._rc = -1 // 路上车数每个子步只数一次
    // 出图的车从入口补回来: 每个子步最多补一辆，随机挑一条入口路
    if (this.entries.length && this.roadCount < this.target) {
      const plan = this.#plan(this.entries[(this.rand() * this.entries.length) | 0])
      // 每条入口路按长度限流（约 45m 一辆/车道），否则补进来的车会全堆在高架这类直通路上
      const onWay = plan.lane.way.lanes.reduce((n, l) => n + l.cars.length, 0)
      if (onWay < (plan.lane.len / 45) * plan.lane.way.n && !plan.lane.cars.some((c) => c.s < 14)) { // 入口 14m 内有车就等下一步
        const car = this.#newCar()
        car.v = V_MAX * 0.6
        this.#enterLane(car, plan.lane, plan.nextWay, 0, plan.ramp)
      }
    }
    this.#updateFacilities(dt)
    // 逐车按状态机推进；拷贝一份是因为更新中会增删 this.cars（出图、进车库）
    // parked / waiting 两种状态没有逐步更新: 停着的车不动，等出口的车由 #updateFacilities 放行
    for (const car of [...this.cars]) {
      if (car.mode === 'lane') this.#updateLane(car, dt)
      else if (car.mode === 'turn') this.#updateTurn(car, dt)
      else if (car.mode === 'path') this.#updatePath(car, dt)
      else if (car.mode === 'ramp') this.#updateRamp(car, dt)
    }
    if (write) this.#write()
  }

  /**
   * 车道上行驶。把所有「前方障碍」折算成一个 gap（到障碍的距离），再按刹车曲线定目标速度:
   *   前车 / 斑马线上的行人 / 路中的行人 / 匝道口 / 路口（红灯、轨迹冲突、目标车道入口有车、环岛让行）
   * car.why 记下是谁限制了它（调试和统计用）。到车道尽头 → 转弯或出图；到匝道口 / 出入口 → 离开车道
   */
  #updateLane(car, dt) {
    const lane = car.lane
    // 前方最近的障碍: 前车 / 有行人的斑马线 / 红灯 / 进不去的路口
    // gap 的含义统一是「车头到障碍还能走多少米」，各种障碍只取最小的那个
    let gap = Infinity
    car.why = ''
    const limit = (g, why) => { if (g < gap) { gap = g; car.why = why } }
    const idx = lane.cars.indexOf(car)
    if (idx + 1 < lane.cars.length) limit(lane.cars[idx + 1].s - car.s - CAR_LEN - 2.5, 'ahead') // 跟车: 车距 = 一个车身 + 2.5m 静止间隙

    // 礼让行人；但人流不断时会永远等下去，所以等够 5 秒就缓慢通过（push 计时期间不再让）
    let yielding = false
    if (car.push > 0) car.push -= dt
    else if (this.crowd) {
      // 行经人行横道遇行人停车让行（道交法第47条）: 斑马线范围内有人就停在线外 1.2m
      for (const { s, cw } of lane.crosswalks) {
        const d = s - cw.depth / 2 - 1.2 - (car.s + CAR_LEN / 2) // 车头到斑马线近侧边缘（留 1.2m）的距离
        if (d < -1 || d > 22) continue // 已经压上去的（d < -1）不再停，太远的（> 22m）先不管
        if (this.crowd.countNear(cw.center[0], cw.center[1], cw.span / 2, true) > 0) { limit(d, 'crosswalk'); yielding = true }
      }
    }
    // 路中间有行人（不限于斑马线）也要让: 看车头前方 5m、9m 两个点
    if (this.crowd && !lane.way.level && car.push <= 0) {
      for (const ahead of [5, 9]) {
        if (this.crowd.countNear(car.x + car.dx * ahead, car.y + car.dy * ahead, 1.6, true) > 0) { limit(ahead - CAR_LEN / 2 - 1.5, 'pedAhead'); yielding = true; break } // 1.6m 半径 ≈ 半个车宽多一点
      }
    }
    // 只有因为让人而停着不动才累计等待；一动或者不再让人就清零
    car.wait = yielding && car.v < 0.3 ? car.wait + dt : 0
    if (car.wait > 5) { car.push = 5; car.wait = 0 } // 等满 5s → 接下来 5s 内以 2.2m/s 缓慢通过

    const toEnd = lane.len - car.s // 到车道尽头（路口边缘）的距离
    let vmax = car.vmax
    this.#considerOvertake(car, lane.cars[idx + 1], toEnd)
    if (car.lane !== lane) return // 刚变了道，下一帧按新车道算
    // 要走匝道: 上桥看地面匝道起点 ss0，下桥看主线上的驶出点 eFrom；20m 内先降到匝道限速，到点就换到 ramp 模式
    if (car.takeRamp) {
      const r = car.takeRamp
      const d = (r.type === 'on' ? r.ss0 : r.eFrom) - car.s
      if (d < 20) vmax = Math.min(vmax, V_RAMP)
      if (d <= 0) {
        lane.cars.splice(lane.cars.indexOf(car), 1) // 离开车道列表，后车不再跟它
        car.mode = 'ramp'
        car.ramp = { r, s: 0 }
        r.cars.push(car)
        return
      }
    }
    // 要拐进停车场 / 车库: 14m 内减到接近场内速度，到出入口点就离开车道
    if (car.parkAt) {
      const d = car.parkAt.gate.s - car.s
      if (d < 14) vmax = Math.min(vmax, V_LOT + 0.8)
      if (d <= 0.3) return this.#leaveRoad(car)
    }
    // 前方有路口（不是出图）: 红绿灯、路口冲突、目标车道入口、环岛让行
    if (car.nextPlan) {
      const node = this.nodes[lane.way.to]
      const signalized = this.signals?.has(lane.way.to)
      const entryFull = car.nextPlan.lane.cars.some((c) => c.s < CAR_LEN + 4) // 目标车道入口 8m 内有车，进去也没地方停
      const toLine = lane.stopS - (car.s + CAR_LEN / 2) // 车头到停车线的距离，负数 = 已过线
      // 从本车道进路口的前车还没走出一个车身: 它已经不在车道的列表里了，要单独看，否则会跟着开到同一个点上
      // 能停在停车线后就停在线后；车头已经过线的（绿灯尾巴上进来的）就停在车道尽头，总之不带着冲突进路口
      if (toEnd < 30 && this.#boxConflict(car, lane)) limit(toLine > 0 ? toLine : toEnd - 0.3, 'boxConflict') // 30m 外还不用查，省一轮采样点比较
      for (const o of node.turning) {
        if (o.turn.from !== lane) continue
        limit(toEnd + o.turn.u * o.turn.len - CAR_LEN - 2.2, 'boxFull') // 和它保持一个车身 + 2.2m，和车道内跟车一样
      }
      let blocked = entryFull ? 'entryFull' : ''
      if (node.roundabout) {
        // 进环岛让环内车先行（实施条例第51条）；环内车不用让
        if (!lane.way.roundabout && this.#ringBusy(lane.way.to)) blocked = 'ringBusy'
      } else if (!signalized && node.busy && node.busy !== car) blocked = 'nodeBusy' // 没灯的普通路口一次只放一辆
      // 转弯让行人: 绿灯时先进路口、在出口斑马线前等（见 #updateTurn），不占着停车线堵后车；只有红灯右转才要求出口斑马线先清空
      const exitCw = car.nextPlan.lane.crosswalks[0]
      const exitPeds = car.move !== 'S' && exitCw && exitCw.s < 25 && this.crowd && this.crowd.countNear(exitCw.cw.center[0], exitCw.cw.center[1], exitCw.cw.span / 2, true) > 0
      if (toLine > -0.5) { // 车头已过停车线就不再管灯
        if (signalized && !car.rtor) {
          const st = this.signals.state(lane.way.to, lane.way.edgeIndex) // 'R' | 'Y' | 'G'
          if (st === 'R' && car.move === 'R') {
            // 红灯右转: 先在停车线停稳，出口斑马线没人、目标车道入口没车才走（实施条例第38条）
            if (car.v < 0.4 && toLine < 2 && !exitPeds && !entryFull) car.rtor = true // 停稳（< 0.4m/s）且离线 2m 内才算「停过了」
            else limit(toLine, 'redRight')
          } else if (st === 'R' || (st === 'Y' && toLine > car.v * 1.2)) limit(toLine, 'red') // 黄灯: 1.2s 内到不了线的就停，否则通过
        }
        if (blocked) limit(Math.max(0, toLine), blocked) // 各种进不去的情况都停在停车线
      } else if (entryFull) limit(toEnd - 1, 'entryFull') // 已过线但目标车道满: 停在车道尽头别进路口
      if (toEnd < 12) vmax = Math.min(vmax, V_TURN + 1.5) // 进路口前 12m 预先减速，转弯时不用急刹
    }
    if (car.push > 0) vmax = Math.min(vmax, 2.2) // 「等太久强行通过」期间只能慢慢挪
    // 安全刹车距离模型: 以 3 m/s² 的舒适减速度刚好能在 gap 处停住的速度 = √(2·3·gap)；gap 无限时按限速走
    const want = gap === Infinity ? vmax : Math.min(vmax, Math.sqrt(Math.max(0, 2 * 3 * gap)))
    car.v += THREE.MathUtils.clamp(want - car.v, -BRAKE * dt, ACCEL * dt) // 速度变化受加速度 / 刹车上限约束
    if (gap < 0.2) car.v = 0 // 贴上障碍就彻底停住，不让数值误差往前蹭
    car.s += car.v * dt

    if (car.s >= lane.len) {
      // 到车道尽头: 摘出列表、清掉变道 / 超车残留状态；没有下一条路就是出图，否则进路口
      lane.cars.splice(lane.cars.indexOf(car), 1)
      this.#dropGhost(car)
      car.lat = 0
      car.passing = null
      if (!car.nextPlan) return this.#remove(car)
      this.#startTurn(car)
    } else {
      samplePolyline(lane.pts, lane.cum, car.s, car)
      if (car.lat !== 0) { // 变道中: 横向偏差逐渐归零，车身基本离开原车道后撤掉占位
        const step = LANE_CHANGE_V * dt
        car.lat = Math.abs(car.lat) <= step ? 0 : car.lat - Math.sign(car.lat) * step
        if (car.ghost) {
          // 占位跟着本车走（弧长换算到原车道），原车道的后车跟着占位减速
          car.ghost.s = this.#mapS(lane, car.ghost.lane, car.s)
          car.ghost.v = car.v
          if (Math.abs(car.lat) < 1.2) this.#dropGhost(car) // 横向还差 1.2m 时车身已基本在新车道里
        }
      }
    }
  }

  /** 同一条路上，把弧长换算到另一条车道（各车道长度略有差别） */
  #mapS(from, to, sv) { return (sv / from.len) * to.len }

  /**
   * 车道上弧长 sv 前后是否有空档
   * @param back   往后看多少米（要让出来的车能安全跟上）
   * @param front  往前看多少米
   */
  #laneFree(lane, sv, back, front) { return !lane.cars.some((c) => c.s > sv - back && c.s < sv + front) }

  /** 变到同一条路的第 k 条车道。逻辑上立刻换过去，画面上用 lat 慢慢横移；原车道留一个「占位」直到车身基本离开 */
  #changeLane(car, k) {
    const from = car.lane, to = from.way.lanes[k]
    const sv = this.#mapS(from, to, car.s)
    const i = from.cars.indexOf(car)
    // 占位对象只有 s / v，原车道的后车把它当普通前车跟；isGhost 让超车逻辑不去超它
    car.ghost = { s: car.s, v: car.v, isGhost: true, owner: car, lane: from }
    from.cars[i] = car.ghost
    const j = to.cars.findIndex((c) => c.s > sv)
    if (j < 0) to.cars.push(car)
    else to.cars.splice(j, 0, car)
    car.lat += to.off > from.off ? -(to.off - from.off) : from.off - to.off // 换完车道后，相对新车道中心线的横向偏差（右为正）
    car.lane = to
    car.s = sv
  }

  /** 撤掉变道占位（车身已离开原车道、或车已经开出车道） */
  #dropGhost(car) {
    if (!car.ghost) return
    const l = car.ghost.lane, i = l.cars.indexOf(car.ghost)
    if (i >= 0) l.cars.splice(i, 1)
    car.ghost = null
  }

  /**
   * 超车决策。只在路段中间做；guide lane 是按下个路口的转向选的，所以超完要回原车道
   * @param car     本车（mode = lane）
   * @param leader  本车道的前车，可能是 undefined 或变道占位
   * @param toEnd   到车道尽头的距离（米）
   */
  #considerOvertake(car, leader, toEnd) {
    const lane = car.lane, way = lane.way
    // 不超车的情形: 单车道 / 环道 / 正在横移中 / 要进匝道或停车场（必须待在特定车道）/ 正在强行通过
    if (way.n < 2 || way.roundabout || car.lat !== 0 || car.takeRamp || car.parkAt || car.push > 0) return
    if (car.passing) {
      // 已经超过去并拉开 12m 以上、右侧有空档 → 驶回原车道；快到路口了还没回去就放宽空档要求
      const home = way.lanes[car.homeK]
      const sv = this.#mapS(lane, home, car.s)
      // 被超的车已经离开原车道（转弯 / 停车 / 出图）也算超完
      const cleared = !car.passing.lane || car.passing.lane !== home || !home.cars.includes(car.passing) || this.#mapS(lane, home, car.s) - car.passing.s > CAR_LEN + 12
      const urgent = toEnd < 60 // 60m 内必须回到导向车道，否则到路口会走错车道
      if ((cleared || urgent) && this.#laneFree(home, sv, urgent ? 8 : 12, urgent ? 8 : 14)) {
        this.#changeLane(car, car.homeK)
        car.passing = null
        car.homeK = -1
      }
      return
    }
    // 起超条件: 有真实前车、离路口 ≥ 90m（超完还要回来）、自己已经进这条路 ≥ 20m
    if (!leader || leader.isGhost || toEnd < 90 || car.s < 20) return
    const gap = leader.s - car.s - CAR_LEN
    if (gap > 22 || leader.v > car.vmax - 1.8 || leader.v < 0.5) return // 前车不慢、或是停着等灯/等人 → 不超
    const k = lane.k - 1 // 左侧 = 更靠内的车道
    if (k < 0 || way.reserved === k) return // 已在最内侧（不借对向车道）、或左边是匝道车道
    const left = way.lanes[k]
    const sv = this.#mapS(lane, left, car.s)
    if (!this.#laneFree(left, sv, 12, 26)) return // 左侧后方 12m、前方 26m 都要空（前方要能容下被超车 + 安全距离）
    car.homeK = lane.k
    car.passing = leader
    this.#changeLane(car, k)
  }

  /**
   * 从车道 a 的尽头到车道 b 的起点的路口内轨迹（二次贝塞尔）。按车道对缓存，附带采样点供冲突检测用
   * @returns {{ p0, p1, p2, len, samples }}  len 是折线近似长度（≥1，避免除零），samples 是 13 个等参数点
   */
  #turnPath(a, b) {
    const key = a.id + '>' + b.id
    let path = this.turnPaths.get(key)
    if (path) return path
    const p0 = a.pts[a.pts.length - 1], p2 = b.pts[0] // 起点 = 进口车道末端，终点 = 出口车道起点
    const d0 = dirAt(a.pts, a.pts.length - 1), d2 = dirAt(b.pts, 1)
    // 控制点取两条切线的交点；近乎平行（直行）时退化成中点
    let p1 = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2]
    const cross = d0[0] * d2[1] - d0[1] * d2[0]
    if (Math.abs(cross) > 0.2) {
      const t = ((p2[0] - p0[0]) * d2[1] - (p2[1] - p0[1]) * d2[0]) / cross // 沿 d0 走多远和 d2 那条线相交
      if (t > 0 && t < Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) * 1.5) { // 交点在前方、且不离谱地远（夹角很小时会飞出去）
        const c = [p0[0] + d0[0] * t, p0[1] + d0[1] * t]
        if ((c[0] - p2[0]) * d2[0] + (c[1] - p2[1]) * d2[1] < 0) p1 = c // 交点要在出口车道起点的后方，否则曲线会冲过头再绕回来
      }
    }
    // 等参数采样 13 个点: 累加折线长当轨迹长度，采样点给 #boxConflict 做相交测试
    const N = 12, samples = []
    let len = 0, prev = p0
    for (let k = 0; k <= N; k++) {
      const q = bezier(p0, p1, p2, k / N)
      len += Math.hypot(q[0] - prev[0], q[1] - prev[1])
      prev = q
      samples.push(q)
    }
    path = { p0, p1, p2, len: Math.max(len, 1), samples }
    this.turnPaths.set(key, path)
    return path
  }

  /**
   * 进路口前的冲突检查: 我的轨迹和路口里其他车「还没走完的那段」轨迹有没有相交（< 2.6m）。
   * 有就在停车线后等 —— 左转的车因此会等对向直行的车先过（转弯让直行），交叉方向的车也不会在路口中间叠在一起。
   * 同一条车道出来的前车不算（那是跟车关系，另有间距控制）。
   */
  #boxConflict(car, lane) {
    const mine = this.#turnPath(lane, car.nextPlan.lane).samples
    for (const o of this.nodes[lane.way.to].turning) {
      if (o === car || o.turn.from === lane) continue // 同车道出来的前车是跟车关系，不算冲突
      const theirs = o.turn.path.samples
      const k0 = Math.max(0, Math.floor(o.turn.u * (theirs.length - 1)) - 1) // 对方已经走过的采样点不用比（往前多留一个）
      for (let i = k0; i < theirs.length; i++) {
        for (const q of mine) {
          const dx = q[0] - theirs[i][0], dy = q[1] - theirs[i][1]
          if (dx * dx + dy * dy < 6.8) return true // 6.8 = 2.6²，两条轨迹上任意两个采样点近于 2.6m（≈ 一个车宽多）就算相交
        }
      }
    }
    return false
  }

  /** 进路口: 取缓存的转弯轨迹，登记到路口的 turning 列表 */
  #startTurn(car) {
    const a = car.lane, b = car.nextPlan.lane
    const path = this.#turnPath(a, b)
    car.mode = 'turn'
    // u: 沿曲线的参数 0→1；fromRing: 从环道出来的（环岛让行时环内车优先）；from: 进口车道（#boxConflict 排除同车道）
    car.turn = { ...path, path, u: 0, node: a.way.to, fromRing: a.way.roundabout, from: a }
    this.nodes[a.way.to].busy = car // 无灯路口「一次放一辆」的占用标记
    this.nodes[a.way.to].turning.push(car)
  }

  /**
   * 路口内行驶（沿二次贝塞尔曲线）。让行顺序: 出口斑马线上的行人 → 目标车道入口的车 → 并入同一出口的车（按剩余距离排队）
   * → 前方 7m 内次序靠前的其他转弯车。被车挡住永远不硬挤；只有等行人超过 6 秒才缓慢通过
   */
  #updateTurn(car, dt) {
    const t = car.turn
    let want = car.move === 'S' ? Math.min(car.vmax, 6.5) : V_TURN // 直行过路口不用降到转弯速度
    // 出口斑马线上有行人 → 停在斑马线前（转弯让行人）
    const exitCw = car.nextPlan.lane.crosswalks[0]
    if (exitCw && exitCw.s < 25 && this.crowd && car.push <= 0) { // 只认出口 25m 内的斑马线（路口那条）
      const d = (1 - t.u) * t.len + exitCw.s - exitCw.cw.depth / 2 - 1.0 - CAR_LEN / 2 // 剩余曲线长 + 出口车道上到斑马线的距离 - 净距
      if (d > -1 && d < 12 && this.crowd.countNear(exitCw.cw.center[0], exitCw.cw.center[1], exitCw.cw.span / 2, true) > 0) want = Math.min(want, Math.sqrt(Math.max(0, 6 * d))) // 同样的 √(2·3·d) 刹车曲线
    }
    // —— 路口里要让的车（车有车长，不能叠上去）。被车挡住和被行人挡住要分开记:
    //    只有「等行人等太久」才允许缓慢挤过去，被车挡住永远不能硬挤，否则就会开到前车身上 ——
    let carBlock = false
    // 1) 目标车道入口处的车（多半正停在出口斑马线前等行人）: 按正常跟车间距停在它后面
    const lead = car.nextPlan.lane.cars[0]
    if (lead) {
      const gapT = (1 - t.u) * t.len + lead.s - CAR_LEN - 2.2 // 剩余曲线长 + 它在出口车道上的位置 - 车身 - 间隙
      want = Math.min(want, Math.sqrt(Math.max(0, 6 * gapT)))
      if (gapT < 1) carBlock = true
      if (gapT < 0.3) want = 0
    }
    // 2) 转弯轨迹会擦过相邻车道的入口: 目标道路各车道入口附近、就在车头前方的车也要让
    for (const l of car.nextPlan.lane.way.lanes) {
      for (const o of l.cars) {
        if (o.s > 14) break // cars 按 s 升序，14m 以外的不会擦到
        if (o.isGhost || o === lead) continue
        const ox = o.x - car.x, oy = o.y - car.y
        if (ox * ox + oy * oy < 42 && ox * car.dx + oy * car.dy > 0.8) { want = 0; carBlock = true } // 6.5m 内且在车头前方（沿行进方向投影 > 0.8m）
      }
    }
    // 3) 路口里的其他车。先后次序统一按「离出口还剩多远」排（剩得少的先走），只有一个全序，不会互相等死:
    //    · 要并入同一条出口车道的: 不管从哪个方向来，都按次序排队，保持一个车身的间距（否则会同时挤进车道入口叠在一起）
    //    · 轨迹交叉的: 对方就在车头前方 7m 内且次序靠前 → 停下等它过去
    const myRem = (1 - t.u) * t.len
    for (const o of this.nodes[t.node].turning) {
      if (o === car) continue
      const oRem = (1 - o.turn.u) * o.turn.len
      if (!(oRem < myRem || (oRem === myRem && o.id < car.id))) continue // 只让次序靠前的；剩余相同用 id 打破平局
      if (o.nextPlan.lane === car.nextPlan.lane) {
        const g = myRem - oRem - CAR_LEN - 2.2 // 并入同一出口: 两车剩余距离之差就是「跟车距离」
        want = Math.min(want, Math.sqrt(Math.max(0, 6 * g)))
        if (g < 1) carBlock = true
        if (g < 0.3) want = 0
      }
      const ox = o.x - car.x, oy = o.y - car.y
      if (ox * ox + oy * oy < 49 && ox * car.dx + oy * car.dy > 0.8) { want = 0; carBlock = true } // 49 = 7²
    }
    // 被行人（而非车）挡住超过 6s → 4s 内以 ≥2m/s 缓慢通过；被车挡住时 push 只倒计时，不生效
    car.wait = want < 0.3 && !carBlock ? car.wait + dt : 0
    if (car.wait > 6) { car.push = 4; car.wait = 0 }
    if (car.push > 0) { car.push -= dt; if (!carBlock) want = Math.max(want, 2) }
    car.v += THREE.MathUtils.clamp(want - car.v, -BRAKE * dt, ACCEL * dt)
    t.u += (car.v * dt) / t.len // 参数按弧长比例推进（近似匀速参数化）
    if (t.u >= 1) {
      // 走完曲线: 释放路口占用、从 turning 里摘掉，从出口车道起点接着走
      const node = this.nodes[t.node]
      if (node.busy === car) node.busy = null
      node.turning.splice(node.turning.indexOf(car), 1)
      const plan = car.nextPlan
      return this.#enterLane(car, plan.lane, plan.nextWay, 0, plan.ramp)
    }
    // 位置取曲线上的点，朝向用往前 0.05 参数的差分近似切线
    const p = bezier(t.p0, t.p1, t.p2, t.u), q = bezier(t.p0, t.p1, t.p2, Math.min(1, t.u + 0.05))
    const d = norm(q[0] - p[0], q[1] - p[1])
    car.x = p[0]; car.y = p[1]; car.dx = d[0]; car.dy = d[1]
  }

  /**
   * 环岛某个进口: 环内有车正要经过这里（或正在经过）→ 外面的车要等
   * @param nodeId  环岛进口节点
   * @returns {boolean}  进入该节点的环道上 16m 内有车、或有从环道出来正在过节点的车
   */
  #ringBusy(nodeId) {
    for (const w of this.nodes[nodeId].inn) {
      if (!w.roundabout) continue // 只看环道来向，别的进口道不算
      for (const l of w.lanes) if (l.cars.some((c) => l.len - c.s < 16)) return true // 16m ≈ 2s 车程
    }
    return this.nodes[nodeId].turning.some((c) => c.turn.fromRing)
  }

  /** 匝道上行驶: 沿匝道折线（带高度）前进，跟前车；到尽头等目标车道有空档再汇入，下桥后优先直行 */
  #updateRamp(car, dt) {
    const { r } = car.ramp
    const target = r.type === 'on' ? r.eLane : r.sLane // 汇入的车道: 上桥进高架外侧车道，下桥回到地面匝道车道
    const sT = r.type === 'on' ? r.eTo : r.ss0 + r.rlen // 在目标车道上的汇入弧长: 上桥是并线段末端，下桥是坡底
    let gap = Infinity
    const idx = r.cars.indexOf(car)
    if (idx > 0) gap = r.cars[idx - 1].ramp.s - car.ramp.s - CAR_LEN - 2.5 // 先上匝道的排在前面
    // 匝道尽头汇入: 目标车道前后要有空档，否则停在匝道口等
    const clear = !target.cars.some((c) => c.s > sT - 13 && c.s < sT + 8) // 后方 13m（让主线车来得及减速）、前方 8m
    if (!clear) gap = Math.min(gap, r.len - car.ramp.s - 0.5) // 停在匝道末端前 0.5m
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
      this.#enterLane(car, target, r.type === 'off' && straight ? straight : plan.nextWay, sT) // 上桥的保留 #plan 随机选的下一条路
      car.takeRamp = null // #enterLane 可能又给它挑了下桥匝道，刚上桥不能马上下
      return
    }
    // 沿匝道折线插值位置、高度、朝向和坡度（坡度给 #write 做俯仰）；等空档时 s 卡在 len 处
    const sp = Math.min(car.ramp.s, r.len)
    let i = 1
    while (i < r.cum.length - 1 && r.cum[i] < sp) i++
    const a = r.pts[i - 1], b = r.pts[i], l = r.cum[i] - r.cum[i - 1] || 1, t = (sp - r.cum[i - 1]) / l
    car.x = a[0] + (b[0] - a[0]) * t
    car.y = a[1] + (b[1] - a[1]) * t
    car.h = a[2] + (b[2] - a[2]) * t
    const d = norm(b[0] - a[0], b[1] - a[1])
    car.dx = d[0]; car.dy = d[1]
    car.slope = (b[2] - a[2]) / l // 高差 / 平面长 = 坡度（tan），小角度下直接当作 sin 用
  }

  /**
   * 进入「沿固定折线走」模式（停车场内、车库坡道）
   * @param pts    要走的折线
   * @param extra  { arriving(true=进场 / false=出场), fac, stall?, reverseUntil?(前多少米倒着走) }
   */
  #startPath(car, pts, extra) {
    const cum = cumulative(pts)
    car.mode = 'path'
    car.path = { pts, cum, len: cum[cum.length - 1], s: 0, reverseUntil: 0, ...extra }
  }

  /** 从车道拐进停车场/车库: 出场路线倒过来走（出入口点 → 入口 → 通道 → 车位），第一个点换成车的当前位置 */
  #leaveRoad(car) {
    const { fac, stall } = car.parkAt
    car.lane.cars.splice(car.lane.cars.indexOf(car), 1)
    const out = fac.type === 'lot' ? stall.pathOut : fac.pathOut
    this.#startPath(car, [[car.x, car.y], ...[...out].reverse().slice(1)], { arriving: true, fac, stall })
  }

  /** 设施出车: 每个出入口隔 40~140s 放一辆（停车场随机挑一辆倒车出位，车库凭空生成一辆）；出口有车在等就先等主路空档 */
  #updateFacilities(dt) {
    for (const f of this.facilities) {
      if (!f.gate) continue // 封闭停车场: 只摆车，不进出
      // 等在出口的车: 目标车道上前后有空档才汇入
      if (f.waiting) {
        const { lane, s } = f.gate
        if (!lane.cars.some((c) => c.s > s - 14 && c.s < s + 8)) { // 后方 14m、前方 8m 空档，和匝道汇入差不多
          const car = f.waiting
          f.waiting = null
          car.v = 2 // 带着场内速度汇入，不从 0 起步堵路
          this.#enterLane(car, lane, this.#plan(lane.way).nextWay, s) // 车道固定用出入口所在的外侧车道
        }
        continue // 出口被占着，这一轮不再放新车
      }
      f.timer -= dt
      if (f.timer > 0) continue
      f.timer = 40 + this.rand() * 100 // 每个出入口大约一两分钟出一辆车（仿真时间）
      if (this.roadCount >= this.target) continue // 路上车已经够多就先不放车出来
      if (f.type === 'lot') {
        // 停车场: 只能挑真正停着的车（reserved 的位子还没车，parked 以外的是正在进出的）
        const parked = f.stalls.filter((st) => st.car && st.car.mode === 'parked')
        if (!parked.length) continue
        const st = parked[(this.rand() * parked.length) | 0]
        const car = st.car
        st.car = null // 车位立刻空出来，路上的车可以预订
        // 先倒车退出车位（第一段），再正着开
        this.#startPath(car, st.pathOut, { arriving: false, fac: f, reverseUntil: Math.hypot(st.pathOut[1][0] - st.pathOut[0][0], st.pathOut[1][1] - st.pathOut[0][1]) })
      } else {
        // 车库: 占用数减一、凭空造一辆从门内淡入
        if (f.occupied <= 0) continue
        f.occupied--
        const car = this.#newCar()
        car.scale = 0 // 门内看不见，#updatePath 走出门洞时放大到 1
        this.#startPath(car, f.pathOut, { arriving: false, fac: f })
        samplePolyline(car.path.pts, car.path.cum, 0, car) // 先摆到路线起点，本步就有正确的位置和朝向
      }
    }
  }

  /** 沿折线走: 压过人行道时让行人；倒车段车头保持朝里；车库门洞处缩放淡入淡出；到头后停进车位或消失进车库 */
  #updatePath(car, dt) {
    const p = car.path
    const reversing = p.reverseUntil > p.s // 出车位的第一段是倒车
    // 压过人行道时让行人: 看车头（倒车时看车尾）前方 3.2m 处 2m 半径内有没有人
    let want = V_LOT
    const sgn = reversing ? -1 : 1
    const ax = car.x + car.dx * 3.2 * sgn, ay = car.y + car.dy * 3.2 * sgn
    if (this.crowd && this.nav.surfaceAt(ax, ay) === SURFACE.PAVE && this.crowd.countNear(ax, ay, 2.0) > 0) want = 0
    if (!p.arriving && p.fac.waiting && p.fac.waiting !== car && p.len - p.s < 8) want = 0 // 出口已经有车在等
    car.v += THREE.MathUtils.clamp(want - car.v, -BRAKE * dt, ACCEL * dt)
    p.s += car.v * dt

    // 位置直接取折线上的点；朝向不能跟着折线突变，按 5/s 的速率向目标方向平滑（倒车时目标方向反过来，车头保持朝里）
    const was = [car.dx, car.dy]
    samplePolyline(p.pts, p.cum, Math.min(p.s, p.len), car)
    const tx = reversing ? -car.dx : car.dx, ty = reversing ? -car.dy : car.dy
    const k = Math.min(1, dt * 5)
    const d = norm(was[0] + (tx - was[0]) * k, was[1] + (ty - was[1]) * k)
    car.dx = d[0]; car.dy = d[1]
    if (p.fac.type === 'garage') car.scale = THREE.MathUtils.clamp((p.arriving ? p.len - p.s : p.s) / 4, 0, 1) // 进出门洞时缩放: 路线两端各 4m 内从 0 到 1

    if (p.s < p.len) return
    // 走到头了
    car.path = null
    car.v = 0
    if (!p.arriving) { car.mode = 'waiting'; p.fac.waiting = car; return } // 出场: 在出口等主路空档（#updateFacilities 放行）
    if (p.fac.type === 'lot') {
      // 进停车场: 停进预订的车位，位置和朝向对齐车位
      const st = p.stall
      st.reserved = false
      st.car = car
      Object.assign(car, { mode: 'parked', x: st.pos[0], y: st.pos[1], dx: st.dir[0], dy: st.dir[1], stall: st })
    } else {
      // 进车库: 预订转成占用，车从场景里消失
      p.fac.occupied++
      p.fac.reserved--
      this.#remove(car)
    }
  }

  /** 写实例矩阵: 朝向来自 (dx, dy)，匝道上带俯仰和高度，变道中加横向偏移；颜色只在增删车后重写 */
  #write() {
    const arr = this.mesh.instanceMatrix.array
    const n = Math.min(this.cars.length, this.capacity) // 超出上限的车不画（不会发生，capacity 远大于 target + 停着的车）
    for (let i = 0; i < n; i++) {
      const c = this.cars[i], o = i * 16, s = c.scale
      // 车头朝 +X；二维方向 (dx,dy) → 三维 (dx,0,dy)。压在人行道上时抬到路沿标高
      // 直接手写列主序 4x4 矩阵（三列基向量 + 平移），比构造 Matrix4 快，每帧上千辆车
      arr[o] = c.dx * s; arr[o + 1] = c.mode === 'ramp' ? (c.slope || 0) * s : 0; arr[o + 2] = c.dy * s; arr[o + 3] = 0 // X 列: 车头方向，匝道上带 Y 分量 = 俯仰
      arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0 // Y 列: 竖直
      arr[o + 8] = -c.dy * s; arr[o + 9] = 0; arr[o + 10] = c.dx * s; arr[o + 11] = 0 // Z 列: 车身右侧
      const lx = c.lat ? -c.dy * c.lat : 0, lz = c.lat ? c.dx * c.lat : 0 // 右 = (-dy, dx)
      arr[o + 12] = c.x + lx
      // 高度: 匝道上用插值高度；高架上用桥面高；场内 / 等出口的车压在人行道上时抬到路沿；其余贴地。+0.02 防止和路面 z-fighting
      arr[o + 13] = c.mode === 'ramp' ? (c.h || 0) + 0.02 : c.level ? ELEVATED_H + 0.02 : (c.mode === 'path' || c.mode === 'waiting') && this.nav.surfaceAt(c.x, c.y) === SURFACE.PAVE ? CURB_H + 0.02 : 0.02
      arr[o + 14] = c.y + lz; arr[o + 15] = 1
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

  /** 释放 GPU 资源: 车的几何 / 材质，以及匝道、出入口等装饰 Mesh */
  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.decor.traverse((o) => { o.geometry?.dispose(); o.material?.dispose() })
  }
}

// ---------------------------------------------------------------------------
// 折线 / 几何小工具
// ---------------------------------------------------------------------------
/** 单位化 */
function norm(x, y) {
  const l = Math.hypot(x, y) || 1
  return [x / l, y / l]
}

/** 折线第 i 个顶点处的方向（用相邻两点）；i=0 取第一段，i=末尾取最后一段 */
function dirAt(pts, i) {
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, Math.max(1, i))]
  return norm(b[0] - a[0], b[1] - a[1])
}

/** 二次贝塞尔: (1-t)²a + 2(1-t)t·b + t²c */
function bezier(a, b, c, t) {
  const v = 1 - t
  return [v * v * a[0] + 2 * v * t * b[0] + t * t * c[0], v * v * a[1] + 2 * v * t * b[1] + t * t * c[1]]
}

/** 折线累计弧长: cum[i] = 从起点到第 i 个顶点的长度，cum[0] = 0 */
function cumulative(pts) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  return cum
}

/**
 * 折线弧长 s 处的点和切向，写进 out（复用对象，避免分配）
 * s 超出 [0, len] 时钳到端点；线性扫描找所在段（车道顶点不多，比二分还快）
 * @returns out（同一个对象，带 x, y, dx, dy）
 */
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

/** 截取弧长 [s0, s1] 的子折线: 两端是插值出的点，中间保留原顶点（离端点 1cm 内的顶点丢掉，避免重复点） */
function slicePolyline(pts, cum, s0, s1) {
  const tmp = {}
  const out = []
  samplePolyline(pts, cum, s0, tmp); out.push([tmp.x, tmp.y])
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 + 0.01 && cum[i] < s1 - 0.01) out.push(pts[i])
  samplePolyline(pts, cum, s1, tmp); out.push([tmp.x, tmp.y])
  return out
}

/** 点到折线的最近点: 返回 { dist, s(弧长) }。逐段做线段投影（t 钳在 [0,1]），取最近的那段 */
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

/** 多边形顶点的平均（形心的近似）；找出入口只要一个「大概在里面」的点，不需要真正的面积形心 */
function centroid(poly) {
  let x = 0, y = 0
  for (const p of poly) { x += p[0]; y += p[1] }
  return [x / poly.length, y / poly.length]
}

/** 多边形边界上离 p 最近的点（逐边做线段投影，多边形按闭合处理） */
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

/** 去掉折线里挨得太近（< 0.4m）的重复点；车位路线拼接入口点时常出现重合点，会让 samplePolyline 的方向退化 */
function dedupe(pts) {
  return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.4)
}
