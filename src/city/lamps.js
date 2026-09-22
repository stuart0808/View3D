// 路灯。分两步: planLamps() 只根据场景数据算出每盏灯的位置、朝向和型号（纯函数，可测试）；
// buildLamps() 把它们画成三个实例化网格（灯杆、灯头、地面光斑）。夜里由引擎按日照强度调亮灯头并显示光斑。
//
// 四种型号，对应不同的地方:
//   avenue   双臂高杆灯 (12m)，立在主干路的中央隔离带上，两侧各一个灯头
//   street   单臂路灯 (9m)，立在普通道路的人行道边，左右两侧交错
//   deck     高架桥面上的护栏灯 (7m)，沿桥面两侧
//   garden   庭院灯 (3.6m，球形灯头)，公园、广场里和住宅楼四周，密度低、灯矮
import * as THREE from 'three'
import { laneLayout, hasMedian, ELEVATED_H } from './roads.js'
import { offsetPolygon, interiorPoints, distToPolygonEdge, pointInPolygon, makeRandom } from './geometry.js'
import { CURB_H } from './ground.js'

/** 每种型号的尺寸和布置间距（米） */
export const LAMP_SPEC = {
  avenue: { height: 12, arm: 2.6, heads: 2, spacing: 36, pole: 0.22, headSize: [1.3, 0.28, 0.5], glow: 11 },
  street: { height: 9, arm: 2.0, heads: 1, spacing: 30, pole: 0.16, headSize: [1.1, 0.24, 0.42], glow: 8 },
  deck: { height: 7, arm: 1.2, heads: 1, spacing: 30, pole: 0.14, headSize: [0.9, 0.22, 0.4], glow: 6 },
  garden: { height: 3.6, arm: 0, heads: 1, spacing: 22, pole: 0.1, headSize: [0.5, 0.5, 0.5], glow: 4 },
}

/** 沿折线每隔 spacing 米取一个点，返回 [{x, y, tx, ty}]（tx,ty 是该处的切向） */
function alongPolyline(pts, spacing, phase = spacing / 2) {
  const out = []
  let carry = phase
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1]
    const L = Math.hypot(bx - ax, by - ay)
    if (L < 1e-6) continue
    const tx = (bx - ax) / L, ty = (by - ay) / L
    let s = carry
    for (; s < L; s += spacing) out.push({ x: ax + tx * s, y: ay + ty * s, tx, ty })
    carry = s - L // 余量带到下一段，间距在折线拐点处也保持均匀
  }
  return out
}

/**
 * 算出所有灯的位置。
 * @param scene   scene.json
 * @param nav     导航网格，可为 null；有的话人行道上的灯会避开不可行走的格子（比如刚好落在树池、建筑角上）
 * @param rand    随机源（庭院灯的散布用），默认固定种子
 * @returns [{ kind, x, y, z, dir }]  z 是灯座标高，dir 是灯臂朝向（弧度，指向道路一侧）
 */
export function planLamps(scene, nav = null, rand = makeRandom(5)) {
  const out = []
  const push = (kind, x, y, z, dir) => out.push({ kind, x, y, z, dir })

  // ---- 道路灯: 按中心线布置 ----
  for (const lane of scene.lanes || []) {
    const w = lane.width
    if (lane.oneway) continue // 环岛的环道不单独布灯，路口的灯够照了
    if (lane.level) {
      // 高架: 桥面两侧各一排护栏灯，灯臂朝桥面中心
      const half = w / 2 - 0.6
      for (const p of alongPolyline(lane.points, LAMP_SPEC.deck.spacing)) {
        for (const sgn of [1, -1]) push('deck', p.x - p.ty * half * sgn, p.y + p.tx * half * sgn, ELEVATED_H, yawToward(p.ty * sgn, -p.tx * sgn))
      }
      continue
    }
    if (lane.median) continue // 桥下的路: 桥面挡着，灯归高架管；隔离带上立灯也照不到什么
    const { n } = laneLayout(w)
    if (hasMedian(w)) {
      // 主干路: 双臂灯立在中央隔离带上。间距按型号来，灯臂垂直于路
      for (const p of alongPolyline(lane.points, LAMP_SPEC.avenue.spacing)) push('avenue', p.x, p.y, 0.45, yawToward(-p.ty, p.tx))
      continue
    }
    // 普通道路: 单臂灯在路沿外 0.7m 的人行道上，左右交错，灯臂伸向路面
    const off = w / 2 + 0.7
    const spacing = n >= 2 ? LAMP_SPEC.street.spacing : LAMP_SPEC.street.spacing * 1.3 // 支路更稀
    alongPolyline(lane.points, spacing).forEach((p, i) => {
      const sgn = i % 2 ? 1 : -1 // 右侧 = (-ty, tx)
      const x = p.x - p.ty * off * sgn, y = p.y + p.tx * off * sgn
      if (nav && nav.contains(x, y) && !nav.isWalkable(x, y)) return // 核心区里: 落在建筑 / 绿化里的不要
      // 灯臂朝向路: 从灯的位置指向中心线的方向
      push('street', x, y, CURB_H, yawToward(p.ty * sgn, -p.tx * sgn))
    })
  }

  // ---- 庭院灯: 公园、广场里散布 ----
  for (const a of scene.areas || []) {
    if (a.kind !== 'park' && a.kind !== 'plaza') continue
    const holes = a.holes || []
    const placed = []
    // 面积 / 间距² 就是大致的盏数；候选点多取几倍再按最小间距筛
    const want = Math.ceil(Math.abs(polyArea(a.polygon)) / LAMP_SPEC.garden.spacing ** 2)
    for (const p of interiorPoints(a.polygon, holes, want * 4, rand)) {
      if (placed.length >= want) break
      if (distToPolygonEdge(p[0], p[1], a.polygon) < 2) continue
      if (placed.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < LAMP_SPEC.garden.spacing * 0.8)) continue
      // 公园里的水面上不能立灯
      if ((scene.areas || []).some((w) => w.kind === 'water' && pointInPolygon(p[0], p[1], w.polygon))) continue
      placed.push(p)
      push('garden', p[0], p[1], a.kind === 'park' ? 0.24 : 0.21, rand() * Math.PI * 2)
    }
  }

  // ---- 庭院灯: 住宅楼四周（小区内的路灯）----
  for (const b of scene.buildings || []) {
    if (b.kind !== 'residential') continue
    const ring = offsetPolygon(b.polygon, 3.5) // 离墙 3.5m 的一圈
    if (!ring) continue
    for (const p of alongPolyline([...ring, ring[0]], LAMP_SPEC.garden.spacing * 1.1)) {
      if (nav && nav.contains(p.x, p.y) && !nav.isWalkable(p.x, p.y)) continue // 别立在马路上或别的楼里
      // 核心区外没有导航网格，只避开别的建筑
      if (!nav?.contains(p.x, p.y) && (scene.buildings || []).some((o) => o !== b && pointInPolygon(p.x, p.y, o.polygon))) continue
      push('garden', p.x, p.y, CURB_H, 0)
    }
  }
  return out
}

/**
 * 灯臂要指向 (dx, dy) 这个二维方向时，绕 Y 轴该转多少。
 * three 里绕 Y 转 θ 后局部 +X 落在世界 (cosθ, 0, -sinθ)，而二维的 y 对应世界 z，所以 θ = atan2(-dy, dx)
 */
export function yawToward(dx, dy) { return Math.atan2(-dy, dx) }

/** 多边形面积（鞋带公式），这里只要绝对值 */
function polyArea(poly) {
  let a = 0
  for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1] }
  return a / 2
}

/**
 * 把灯画出来。返回 { group, setNight(k) }: k = 0 白天（灯头暗、无光斑），1 深夜（灯头全亮、光斑最强）。
 * 每盏灯 = 灯杆(圆柱) + 灯臂(细盒) × heads + 灯头(盒或球) × heads + 地面光斑(圆盘)。
 * 全部实例化: 4 种型号 × 4 个网格 = 最多 16 个 draw call，几千盏灯也不怕。
 */
export function buildLamps(lamps) {
  const group = new THREE.Group()
  group.name = 'lamps'
  const poleMat = new THREE.MeshStandardMaterial({ color: '#5b626c', roughness: 0.7 })
  const headMat = new THREE.MeshStandardMaterial({ color: '#d8dce2', roughness: 0.5, emissive: new THREE.Color('#ffd9a0'), emissiveIntensity: 0 })
  // 光斑: 叠加混合的半透明圆盘，白天 opacity = 0 看不见
  const glowMat = new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  const byKind = {}
  for (const l of lamps) (byKind[l.kind] ||= []).push(l)

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1)
  const heads = [] // 所有灯头网格，夜里一起调 emissive
  for (const [kind, list] of Object.entries(byKind)) {
    const sp = LAMP_SPEC[kind]
    // 灯杆: 圆柱，底在 0
    const poleGeo = new THREE.CylinderGeometry(sp.pole * 0.7, sp.pole, sp.height, 6)
    poleGeo.translate(0, sp.height / 2, 0)
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, list.length)
    // 灯臂 + 灯头: 局部 +X 是灯臂伸出的方向
    const armGeo = new THREE.BoxGeometry(sp.arm || 0.01, 0.12, 0.12)
    armGeo.translate((sp.arm || 0) / 2, sp.height - 0.15, 0)
    const headGeo = kind === 'garden' ? new THREE.SphereGeometry(sp.headSize[0], 10, 8) : new THREE.BoxGeometry(...sp.headSize)
    headGeo.translate(sp.arm ? sp.arm - sp.headSize[0] / 2 + 0.2 : 0, sp.height + (kind === 'garden' ? 0.3 : -0.25), 0)
    const arms = new THREE.InstancedMesh(armGeo, poleMat, list.length * sp.heads)
    const headsMesh = new THREE.InstancedMesh(headGeo, headMat, list.length * sp.heads)
    // 光斑: 半径 = glow，落在灯座标高上方一点点
    const glowGeo = new THREE.CircleGeometry(sp.glow, 20)
    glowGeo.rotateX(-Math.PI / 2)
    const glows = new THREE.InstancedMesh(glowGeo, glowMat, list.length)

    list.forEach((l, i) => {
      pos.set(l.x, l.z, l.y)
      m.compose(pos, q.identity(), scl)
      poles.setMatrixAt(i, m)
      pos.y += 0.02
      m.compose(pos, q, scl)
      glows.setMatrixAt(i, m)
      pos.y -= 0.02
      // 双臂灯: 第二个灯头朝反方向
      for (let k = 0; k < sp.heads; k++) {
        q.setFromAxisAngle(up, l.dir + k * Math.PI)
        m.compose(pos, q, scl)
        arms.setMatrixAt(i * sp.heads + k, m)
        headsMesh.setMatrixAt(i * sp.heads + k, m)
      }
    })
    for (const mesh of [poles, arms, headsMesh, glows]) { mesh.frustumCulled = false; group.add(mesh) }
    poles.castShadow = true
    glows.renderOrder = 3
    heads.push(headsMesh)
  }

  return {
    group,
    count: lamps.length,
    /** k ∈ [0,1]: 0 白天，1 深夜。0.25 以下不亮（黄昏才开灯） */
    setNight(k) {
      const on = THREE.MathUtils.clamp((k - 0.25) / 0.5, 0, 1)
      headMat.emissiveIntensity = on * 2.2
      glowMat.opacity = on * 0.22
    },
    dispose() {
      group.traverse((o) => o.geometry?.dispose())
      poleMat.dispose(); headMat.dispose(); glowMat.dispose()
    },
  }
}
