// 红绿灯: 每个路口（度 ≥ 3）把进口道按方向分成两个轴，轮流放行。
//   车: 自己所在轴绿灯才能进路口；黄灯时已经贴近停车线的直接过。
//   人: 横跨某条路的斑马线，在「这条路的车是红灯」且剩余时间够走完时放行。
// 路段中途的斑马线没有灯，仍然是车让人。
import * as THREE from 'three'

const GREEN = 22, YELLOW = 3, ALL_RED = 2 // 秒（仿真时间）
const CYCLE = (GREEN + YELLOW + ALL_RED) * 2
const WALK_WINDOW = GREEN - 9 // 绿灯开始后的这段时间内允许行人起步，留 9 秒清空
const LAMP = { G: new THREE.Color('#35d07f'), Y: new THREE.Color('#ffc53d'), R: new THREE.Color('#ff4d4f') }

export class Signals {
  constructor(scene, rand) {
    const g = scene.roadGraph || { nodes: {}, edges: [] }
    this.nodes = {} // id -> { t, axisOf: {edgeIndex: 0|1} }
    for (const [id, n] of Object.entries(g.nodes)) {
      if (n.degree < 3 || n.roundabout || n.level) continue
      const arms = []
      g.edges.forEach((e, idx) => {
        if (e.a === e.b) return
        if (e.a === id) arms.push({ idx, ang: armAngle(e.points, false) })
        else if (e.b === id) arms.push({ idx, ang: armAngle(e.points, true) })
      })
      if (arms.length < 3) continue
      const axisOf = {}
      for (const arm of arms) {
        // 与第一条进口道的夹角（按 180° 折叠）< 45° 算同一个轴
        let d = Math.abs(arm.ang - arms[0].ang) % Math.PI
        if (d > Math.PI / 2) d = Math.PI - d
        axisOf[arm.idx] = d < Math.PI / 4 ? 0 : 1
      }
      this.nodes[id] = { t: rand() * CYCLE, axisOf }
    }
    // 斑马线 → (路口, 轴)
    this.crosswalks = (scene.crosswalks || []).map((c) => {
      const n = c.node != null ? this.nodes[c.node] : null
      return n && n.axisOf[c.edge] !== undefined ? { node: n, axis: n.axisOf[c.edge] } : null
    })
    this.lamps = []
    this.group = new THREE.Group()
    this.group.name = 'signals'
  }

  has(nodeId) { return !!this.nodes[nodeId] }

  /** 某路口某条路的车灯: 'G' | 'Y' | 'R' */
  state(nodeId, edgeIndex) {
    const n = this.nodes[nodeId]
    if (!n) return 'G'
    return phaseOf(n.t, n.axisOf[edgeIndex] ?? 0)
  }

  /** 第 i 条斑马线现在能不能起步过街（没灯的斑马线永远可以） */
  canWalk(i) {
    const c = this.crosswalks[i]
    if (!c) return true
    // 行人过的是 axis 这条路 → 要等另一个轴的车绿灯，且还在起步窗口内
    const other = 1 - c.axis
    const local = (c.node.t + (other === 1 ? CYCLE / 2 : 0)) % CYCLE
    return local < WALK_WINDOW
  }

  update(dt) {
    for (const n of Object.values(this.nodes)) n.t = (n.t + dt) % CYCLE
    if (!this.lampMesh) return
    const c = this.lampMesh.instanceColor
    this.lamps.forEach((l, i) => {
      const s = this.state(l.node, l.edge)
      if (s !== l.last) { this.lampMesh.setColorAt(i, LAMP[s]); l.last = s; c.needsUpdate = true }
    })
  }

  /** sites 来自 Traffic.signalSites(): 每个进口道一根灯杆 + 一条停车线 */
  attachSites(sites, curbH) {
    if (!sites.length) return
    const n = sites.length
    const poleGeo = new THREE.CylinderGeometry(0.11, 0.14, 5.2, 6)
    poleGeo.translate(0, 2.6, 0)
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: '#5b626c', roughness: 0.7 }), n)
    const headGeo = new THREE.BoxGeometry(0.5, 1.5, 0.5)
    headGeo.translate(0, 5.1, 0)
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: '#2b3038', roughness: 0.6 }), n)
    // 灯做得比真实的大，等轴测远景里才看得见；不受光照，颜色始终鲜亮
    this.lampMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.42, 10, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), n)
    const lineGeo = new THREE.PlaneGeometry(1, 1)
    lineGeo.rotateX(-Math.PI / 2)
    const stopLines = new THREE.InstancedMesh(lineGeo, new THREE.MeshStandardMaterial({ color: '#f2f3f5', roughness: 0.9 }), n)
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0)
    sites.forEach((s, i) => {
      m.makeTranslation(s.post[0], curbH, s.post[1])
      poles.setMatrixAt(i, m)
      heads.setMatrixAt(i, m)
      m.makeTranslation(s.post[0] - s.dx * 0.32, curbH + 5.1, s.post[1] - s.dy * 0.32) // 灯朝着来车方向探出一点
      this.lampMesh.setMatrixAt(i, m)
      this.lampMesh.setColorAt(i, LAMP.R)
      this.lamps.push({ node: s.node, edge: s.edge, last: null })
      // 停车线横跨本方向所有车道（局部 X 沿行车方向，线长放在 Z 上）
      q.setFromAxisAngle(up, Math.atan2(-s.dy, s.dx))
      m.compose(new THREE.Vector3(s.stopLine.center[0], 0.026, s.stopLine.center[1]), q, new THREE.Vector3(0.45, 1, s.stopLine.length))
      stopLines.setMatrixAt(i, m)
    })
    stopLines.receiveShadow = true
    poles.castShadow = heads.castShadow = true
    for (const mesh of [poles, heads, this.lampMesh, stopLines]) { mesh.frustumCulled = false; this.group.add(mesh) }
  }

  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose() })
  }
}

function phaseOf(t, axis) {
  const local = (t + (axis === 1 ? CYCLE / 2 : 0)) % CYCLE
  return local < GREEN ? 'G' : local < GREEN + YELLOW ? 'Y' : 'R'
}

/** 这条路从路口向外伸出去的方向角（取离路口约 12m 处的点，避开路口附近骨架的小弯） */
function armAngle(points, reversed) {
  const pts = reversed ? [...points].reverse() : points
  let acc = 0, i = 1
  for (; i < pts.length - 1; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (acc > 12) break
  }
  i = Math.min(i, pts.length - 1)
  return Math.atan2(pts[i][1] - pts[0][1], pts[i][0] - pts[0][0])
}
