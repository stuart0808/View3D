// 红绿灯。
//
// 每个度 ≥ 3 的路口（环岛、高架上的节点除外）配一组灯。相位很简单: 把进口道按方向分成两个「轴」
// （大致东西向一个、南北向一个），两轴轮流放行 —— 绿 22s → 黄 3s → 全红 2s → 换另一轴，一个周期 54s。
// 没有左转专用相位，左转车靠「转弯让直行」的规则（traffic.js 里的轨迹冲突检查）找空档过。
//
//   车: 自己所在轴绿灯才能进路口；黄灯时已经贴近停车线的直接过；红灯右转另有规则（traffic.js）
//   人: 要横跨某条路的斑马线，在「这条路的车是红灯」且离该轴下次变绿还够走完时放行（canWalk）
//   路段中途的斑马线不归它管，仍然是车让人
//
// 时间来自仿真时钟（引擎每个子步调 update(dt)），所以倍速下灯也跟着快。每个路口的相位起点随机，
// 免得全城的灯同时变色。
//
// 场景编辑器可以逐个路口改（写在 roadGraph 节点上）:
//   control: 'none'          这个路口不设灯（车按「一次放一辆」通过）
//   signal: { green: [东西向绿灯秒数, 南北向绿灯秒数] }   两个方向不等长的绿灯，周期随之变化
// 哪个轴算「东西向」: 轴里第一条进口道的方向更接近水平（|cos| ≥ |sin|）就是东西向。
import * as THREE from 'three'

const GREEN = 22, YELLOW = 3, ALL_RED = 2 // 秒（仿真时间）
const CYCLE = (GREEN + YELLOW + ALL_RED) * 2 // 两个轴各走一遍
const WALK_WINDOW = GREEN - 9 // 绿灯开始后的这段时间内允许行人起步，留 9 秒清空斑马线
const LAMP = { G: new THREE.Color('#35d07f'), Y: new THREE.Color('#ffc53d'), R: new THREE.Color('#ff4d4f') } // 灯头三色

export { GREEN, YELLOW, ALL_RED, CYCLE, WALK_WINDOW }

export class Signals {
  /**
   * @param scene  scene.json（用 roadGraph 找路口和进口道，用 crosswalks 把斑马线挂到路口）
   * @param rand   随机源，只用来错开各路口的相位起点
   */
  constructor(scene, rand) {
    const g = scene.roadGraph || { nodes: {}, edges: [] }
    this.nodes = {} // 路口 id -> { t: 周期内的相位时间, axisOf: { 边下标: 0|1 } }
    for (const [id, n] of Object.entries(g.nodes)) {
      // 度 < 3 不是路口；环岛让行不设灯；高架上的节点是匝道汇入，不设灯
      if (n.degree < 3 || n.roundabout || n.level) continue
      // 找出这个路口的所有进口道（不含自环），记下每条从路口向外伸出的方向角
      const arms = []
      g.edges.forEach((e, idx) => {
        if (e.a === e.b) return // 自环（环道）不算进口道
        if (e.a === id) arms.push({ idx, ang: armAngle(e.points, false) })
        else if (e.b === id) arms.push({ idx, ang: armAngle(e.points, true) })
      })
      if (arms.length < 3) continue // 有自环的节点度数可能虚高，真实进口道不够三条就不设灯
      // 分轴: 和第一条进口道的夹角（按 180° 折叠，正对面的路算同一轴）< 45° 的归 0 轴，其余归 1 轴
      const axisOf = {}
      for (const arm of arms) {
        let d = Math.abs(arm.ang - arms[0].ang) % Math.PI // 折叠到 [0, π)
        if (d > Math.PI / 2) d = Math.PI - d // 再折到 [0, π/2]: 正对面的路夹角 0
        axisOf[arm.idx] = d < Math.PI / 4 ? 0 : 1
      }
      if (n.control === 'none') continue // 编辑器指定这个路口不设灯
      // 两个轴的绿灯时长: 编辑器按东西 / 南北给，这里换成按轴（0 轴是第一条进口道所在的轴）
      const ew0 = Math.abs(Math.cos(arms[0].ang)) >= Math.abs(Math.sin(arms[0].ang)) // 0 轴是不是东西向
      const gs = n.signal?.green // 编辑器给的 [东西, 南北] 绿灯秒数
      const timing = makeTiming(gs ? (ew0 ? gs : [gs[1], gs[0]]) : [GREEN, GREEN])
      this.nodes[id] = { t: rand() * timing.cycle, axisOf, timing } // 相位起点随机
    }
    // 每条斑马线 → 它横跨的那条路属于哪个路口的哪个轴；路段中途的斑马线（没有 node）为 null
    this.crosswalks = (scene.crosswalks || []).map((c) => {
      const n = c.node != null ? this.nodes[c.node] : null
      return n && n.axisOf[c.edge] !== undefined ? { node: n, axis: n.axisOf[c.edge] } : null
    })
    this.lamps = [] // 灯头实例 → (路口, 边)，update 时按相位换色
    this.group = new THREE.Group()
    this.group.name = 'signals'
  }

  /** 这个路口有没有灯（traffic.js 据此决定是「看灯」还是「一次放一辆」） */
  has(nodeId) { return !!this.nodes[nodeId] }

  /** 某路口某条进口道此刻的车灯: 'G' | 'Y' | 'R'。没灯的路口视为常绿 */
  state(nodeId, edgeIndex) {
    const n = this.nodes[nodeId]
    if (!n) return 'G'
    return phaseOf(n.t, n.axisOf[edgeIndex] ?? 0, n.timing)
  }

  /**
   * 第 i 条斑马线现在能不能起步过街（没灯的斑马线永远可以）。
   * 行人过的是 axis 这条路 → 要等「另一个轴」的车绿灯（此时本轴红灯，没车横穿），且还在起步窗口内。
   */
  canWalk(i) {
    const c = this.crosswalks[i]
    if (!c) return true
    const other = 1 - c.axis // 另一个轴
    const tm = c.node.timing // 这个路口的配时
    const local = localTime(c.node.t, other, tm) // 另一轴自己绿灯开始后过了多久
    return local < Math.max(4, tm.green[other] - 9) // 它的绿灯刚开始的那段时间（留 9 秒清空斑马线，至少给 4 秒）
  }

  /** 推进相位；灯头颜色只在状态变化时写，避免每帧刷 instanceColor */
  update(dt) {
    for (const n of Object.values(this.nodes)) n.t = (n.t + dt) % n.timing.cycle // 相位时间回绕（各路口周期可以不同）
    if (!this.lampMesh) return // 还没 attachSites（比如关掉了车流）
    const c = this.lampMesh.instanceColor
    this.lamps.forEach((l, i) => {
      const s = this.state(l.node, l.edge)
      if (s !== l.last) { this.lampMesh.setColorAt(i, LAMP[s]); l.last = s; c.needsUpdate = true }
    })
  }

  /**
   * 把灯画出来。sites 来自 Traffic.signalSites(): 每个进口道一个 { node, edge, post:[x,y], dx, dy, stopLine }。
   * 每个进口道 = 一根灯杆 + 灯箱 + 一个发光球（灯头故意做得比真实大，等轴测远景里才看得见）+ 一条停车线。
   * 四种东西各一个 InstancedMesh，全城 110 个路口也只有 4 个 draw call。
   */
  attachSites(sites, curbH) {
    if (!sites.length) return
    const n = sites.length
    const poleGeo = new THREE.CylinderGeometry(0.11, 0.14, 5.2, 6) // 5.2m 高的杆
    poleGeo.translate(0, 2.6, 0) // 底在 0
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: '#5b626c', roughness: 0.7 }), n)
    const headGeo = new THREE.BoxGeometry(0.5, 1.5, 0.5) // 深色灯箱
    headGeo.translate(0, 5.1, 0) // 挂在杆顶
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: '#2b3038', roughness: 0.6 }), n)
    // 灯头不受光照（MeshBasic），颜色始终鲜亮；toneMapped 关掉免得被压暗
    this.lampMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 10, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), n)
    const lineGeo = new THREE.PlaneGeometry(1, 1) // 停车线: 单位平面按实例缩放
    lineGeo.rotateX(-Math.PI / 2) // 放平
    const stopLines = new THREE.InstancedMesh(lineGeo, new THREE.MeshStandardMaterial({ color: '#f2f3f5', roughness: 0.9 }), n)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0)
    sites.forEach((s, i) => {
      m.makeTranslation(s.post[0], curbH, s.post[1])
      poles.setMatrixAt(i, m)
      heads.setMatrixAt(i, m)
      m.makeTranslation(s.post[0] - s.dx * 0.32, curbH + 5.1, s.post[1] - s.dy * 0.32) // 灯朝着来车方向探出一点
      this.lampMesh.setMatrixAt(i, m)
      this.lampMesh.setColorAt(i, LAMP.R) // 先写一次颜色，建出 instanceColor 缓冲
      this.lamps.push({ node: s.node, edge: s.edge, last: null }) // last: 上次写入的状态，变了才重写
      // 停车线横跨本方向所有车道（局部 X 沿行车方向，线长放在 Z 上）
      q.setFromAxisAngle(up, Math.atan2(-s.dy, s.dx))
      m.compose(new THREE.Vector3(s.stopLine.center[0], 0.026, s.stopLine.center[1]), q, new THREE.Vector3(0.45, 1, s.stopLine.length))
      stopLines.setMatrixAt(i, m)
    })
    stopLines.receiveShadow = true
    poles.castShadow = heads.castShadow = true // 灯头球不投影
    for (const mesh of [poles, heads, this.lampMesh, stopLines]) { mesh.frustumCulled = false; this.group.add(mesh) }
  }

  /** 释放灯具的几何体和材质 */
  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose() })
  }
}

/**
 * 一个路口的配时: 两个轴的绿灯时长 → 周期
 * 周期 = 0 轴（绿 + 黄 + 全红）+ 1 轴（绿 + 黄 + 全红）；1 轴在 0 轴的全红结束后开始
 * @param green [0 轴绿灯秒数, 1 轴绿灯秒数]，每个至少 5 秒
 */
export function makeTiming(green = [GREEN, GREEN]) {
  const g = green.map((v) => Math.max(5, +v || GREEN)) // 非法值回到默认
  return { green: g, start1: g[0] + YELLOW + ALL_RED, cycle: g[0] + g[1] + 2 * (YELLOW + ALL_RED) }
}

const DEFAULT_TIMING = makeTiming() // 两轴各 22 秒，周期 54 秒

/** 周期内时间 t → 某个轴自己的「绿灯开始后过了多久」 */
function localTime(t, axis, tm) {
  return axis === 1 ? (t - tm.start1 + tm.cycle) % tm.cycle : t % tm.cycle
}

/** 周期内时间 t 对某个轴而言是什么灯（tm 缺省为两轴各 22 秒的默认配时: 1 轴正好错开半个周期） */
export function phaseOf(t, axis, tm = DEFAULT_TIMING) {
  const local = localTime(t, axis, tm)
  const g = tm.green[axis] // 这个轴的绿灯时长
  return local < g ? 'G' : local < g + YELLOW ? 'Y' : 'R'
}

/**
 * 这条路从路口向外伸出去的方向角。取离路口约 12m 处的点来算，避开路口附近骨架的小弯
 * （脚本做过路口归正，但仍可能有一两个点的偏折）。reversed = 路口在这条路的末端
 */
export function armAngle(points, reversed) {
  const pts = reversed ? [...points].reverse() : points // 让 pts[0] 是路口那一端
  let acc = 0, i = 1 // 累计弧长、当前点
  for (; i < pts.length - 1; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (acc > 12) break
  }
  i = Math.min(i, pts.length - 1) // 路很短时就用末点
  return Math.atan2(pts[i][1] - pts[0][1], pts[i][0] - pts[0][0]) // 从路口指向路外
}
