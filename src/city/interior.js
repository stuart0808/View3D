// 室内视图: 把选中的楼「掀掉」，在原地按轮廓程序化生成一层室内。
//   mall   商场一层: 沿外墙一圈店铺（隔墙 + 彩色地面），内侧环形走廊，中庭放几个岛柜；
//          走廊里的人数 = 人群仿真里此刻「在这栋楼里」的人数，是活的。
//   garage 地下车库 B1: 车位、车道、柱网、坡道；停着的车数 = 车流仿真里这个车库此刻的占用数。
// 同样不追求还原真实室内，只保证和建筑轮廓、出入口、实时数据对得上。
//
// 显示方式: 引擎把这栋楼的 bid 写进 hiddenBuilding（buildings.js），楼体、热力层在着色器里被隐藏；
// 这里在原地 y=0 起建一层室内，镜头推近。退出时整组销毁，楼体恢复。
// 内部坐标: 二维 (x, y) → 世界 (x, 高度, y)，与别处一致。
//
// 对外接口: new Interior(building, kind, opts) → .group 挂到场景；每帧 update(dt, live)；退出 dispose()。
// 商场的实时人数来自 Crowd.stats().perBuilding，车库的占用来自 Traffic.garageInfo()。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { signedArea, edgeNormal, offsetPolygon, pointInPolygon, interiorPoints, distToPolygonEdge, makeShape, toGround } from './geometry.js'
import { layoutParking, carGeometry, carMaterial, CAR_COLORS } from './props.js'
import { personGeometry, PEOPLE_PALETTE } from './crowd.js'

const SHOP_FLOORS = ['#f3d9c4', '#d6e6f2', '#e3ecd2', '#f1e3b8', '#e6d8ee', '#d3ebe6', '#f4d4d4'] // 每家店铺地面随机一种淡色，一眼分得出店和店
const WALL_H = 1.5 // 室内墙只做 1.5m 高: 等轴测俯视时不挡视线，又看得出分隔

export class Interior {
  /**
   * @param building  scene.json 里的建筑（polygon / holes / id）
   * @param kind      'mall' | 'garage'
   * @param angle     街区主方向，车库的车位沿它排
   * @param garage    Traffic.garageInfo() 的结果 { entry, normal, capacity, occupied }，车库坡道要用出入口位置
   */
  constructor(building, kind, { rand, angle = 0, garage = null }) {
    this.b = building // 轮廓、内院、id
    this.kind = kind
    this.rand = rand // 确定性随机: 同一栋楼每次打开布局一样
    this.group = new THREE.Group() // 所有室内网格都挂在这里，dispose 时整组释放
    this.group.name = `interior:${building.id}:${kind}`
    // 点是否在楼的轮廓内（挖掉内院）
    this.inside = (x, y) => pointInPolygon(x, y, building.polygon) && !(building.holes || []).some((h) => pointInPolygon(x, y, h))
    if (kind === 'garage') this.#buildGarage(angle, garage)
    else this.#buildMall()
  }

  /** 一批几何体合并成一个 Mesh 加进组里；opts: rough 粗糙度、vertexColors 用顶点色、cast 投影 */
  #mesh(geos, color, opts = {}) {
    if (!geos.length) return null
    const merged = mergeGeometries(geos.map((g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g })) // 统一成无 uv、非索引才能合并
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.9, vertexColors: !!opts.vertexColors }))
    mesh.castShadow = opts.cast ?? true
    mesh.receiveShadow = true
    this.group.add(mesh)
    return mesh
  }

  /** 楼板 + 一圈矮外墙（内院同理） */
  #shell(floorColor, wallColor, y0) {
    const { polygon, holes = [] } = this.b
    this.#mesh([toGround(new THREE.ExtrudeGeometry(makeShape(polygon, holes), { depth: 0.25, bevelEnabled: false }), y0)], floorColor, { cast: false }) // 25cm 厚楼板
    const walls = []
    const inner = offsetPolygon(polygon, -0.4) // 外墙厚 40cm: 轮廓减去内缩 40cm 的环
    if (inner) walls.push(toGround(new THREE.ExtrudeGeometry(makeShape(polygon, [inner]), { depth: WALL_H, bevelEnabled: false }), y0 + 0.25))
    for (const h of holes) { // 内院四周也围一圈墙
      const outer = offsetPolygon(h, 0.4)
      if (outer) walls.push(toGround(new THREE.ExtrudeGeometry(makeShape(outer, [h]), { depth: WALL_H, bevelEnabled: false }), y0 + 0.25))
    }
    this.#mesh(walls, wallColor)
  }

  // -------------------------------------------------------------------------
  /**
   * 商场一层: 沿每条外墙边按 7m 一个开间排店铺，店铺进深 D 取楼内最宽处的一半（3.5~10m），
   * 内侧留 5.2m 宽的环形走廊（中线 = 轮廓内缩 D + 2.6），中庭撒几个岛柜。
   */
  #buildMall() {
    const { polygon } = this.b
    const Y = 0.25 // 楼板顶面标高
    this.#shell('#ecebe7', '#d5d8dc', 0)

    // 店铺进深: 取「楼内最宽处」的一部分，窄楼就浅一点
    const probe = interiorPoints(polygon, this.b.holes || [], 80, this.rand) // 楼内随机撒 80 个点，量深度、放岛柜、站人都用它
    const reach = Math.max(0, ...probe.map((p) => Math.min(distToPolygonEdge(p[0], p[1], polygon), ...(this.b.holes || []).map((h) => distToPolygonEdge(p[0], p[1], h)))))
    const D = THREE.MathUtils.clamp(reach * 0.5, 3.5, 10) // 店铺进深 3.5~10m
    this.shopDepth = D

    const area = signedArea(polygon) // 带符号面积，决定外法线方向
    const parts = [], counters = [], tints = [] // 隔墙 / 收银台 / 店铺地面
    this.shopSpots = [] // 每家店 [中心x, 中心y, 向内方向x, y, 开间宽]，室内的人要「站在店里」时用
    const n = polygon.length
    for (let i = 0; i < n; i++) {
      const p = polygon[i], q = polygon[(i + 1) % n]
      const L = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (L < 7) continue // 放不下一个开间的短边跳过
      const tx = (q[0] - p[0]) / L, ty = (q[1] - p[1]) / L
      const [ox, oy] = edgeNormal(polygon, i, area)
      const ix = -ox, iy = -oy // 向内
      const bays = Math.max(1, Math.round((L - 2) / 7)) // 这条边分几个开间（两端各留 1m）
      const bw = (L - 2) / bays
      const ang = Math.atan2(-iy, ix) // 盒子局部 X 朝楼内
      // k = 0..bays: 每个 k 放一道隔墙；k < bays 时还放这一格的店铺地面和收银台
      for (let k = 0; k <= bays; k++) {
        const s = 1 + bw * k // 沿边的位置（两端各留 1m）
        const wx = p[0] + tx * s + ix * (D / 2 + 0.4), wy = p[1] + ty * s + iy * (D / 2 + 0.4) // 隔墙中心: 贴着外墙内侧（0.4）向内 D/2
        if (!this.inside(wx + ix * D * 0.45, wy + iy * D * 0.45)) continue // 隔墙的内端要在楼里（凹角处会伸出去）
        const g = new THREE.BoxGeometry(D, WALL_H - 0.2, 0.18) // 隔墙: 长 = 进深，18cm 厚，比外墙矮 20cm
        g.rotateY(ang)
        g.translate(wx, Y + (WALL_H - 0.2) / 2, wy)
        parts.push(g)
        if (k === bays) continue
        const cx = p[0] + tx * (s + bw / 2) + ix * (D / 2 + 0.4), cy = p[1] + ty * (s + bw / 2) + iy * (D / 2 + 0.4)
        if (!this.inside(cx, cy) || !this.inside(cx + ix * D * 0.5, cy + iy * D * 0.5)) continue
        const f = new THREE.BoxGeometry(D - 0.3, 0.04, bw - 0.3) // 店铺地面: 比开间四周各缩 15cm，4cm 厚贴在楼板上
        f.rotateY(ang)
        f.translate(cx, Y + 0.02, cy)
        const col = new THREE.Color(SHOP_FLOORS[(this.rand() * SHOP_FLOORS.length) | 0]) // 每家店随机一种淡色，写成顶点色
        f.setAttribute('color', new THREE.BufferAttribute(new Float32Array(f.attributes.position.count * 3).map((_, j) => col.toArray()[j % 3]), 3))
        tints.push(f)
        // 店门口的收银台/展台
        const c = new THREE.BoxGeometry(0.7, 1.0, bw * 0.45) // 1m 高的柜台，宽度占开间的 45%
        c.rotateY(ang)
        c.translate(cx + ix * (D / 2 - 0.9), Y + 0.5, cy + iy * (D / 2 - 0.9)) // 放在店铺靠走廊的一端（离店口 0.9m）
        counters.push(c)
        this.shopSpots.push([cx, cy, ix, iy, bw])
      }
    }
    this.#mesh(parts, '#dcdfe3') // 隔墙浅灰
    this.#mesh(tints, '#ffffff', { vertexColors: true, cast: false }) // 店铺地面用顶点色，材质白
    this.#mesh(counters, '#b9c0c9') // 柜台

    // 走廊中线 = 轮廓内缩（店铺进深 + 走廊半宽）。窄楼缩不进去就退化成在楼里随机站着
    this.loop = offsetPolygon(polygon, -(D + 2.6))
    if (this.loop && Math.abs(signedArea(this.loop)) < 30) this.loop = null // 缩得只剩不到 30㎡ 也当没有
    if (this.loop) {
      const kiosks = []
      for (const p of probe) { // 岛柜: 最多 6 个，放在走廊环以内、离走廊 4.5m 以上、彼此 9m 以上
        if (kiosks.length >= 6) break
        if (!pointInPolygon(p[0], p[1], this.loop) || distToPolygonEdge(p[0], p[1], this.loop) < 4.5) continue
        if (kiosks.some((k) => Math.hypot(k.x - p[0], k.y - p[1]) < 9)) continue
        const g = new THREE.CylinderGeometry(1.5, 1.7, 1.0, 10).toNonIndexed() // 1m 高的圆台
        g.translate(p[0], Y + 0.5, p[1])
        kiosks.push({ x: p[0], y: p[1], g })
      }
      this.#mesh(kiosks.map((k) => k.g), '#c8d3c0')
      // 走廊折线的累计弧长，人沿它走时用来定位
      this.loopCum = [0]
      for (let i = 0; i < this.loop.length; i++) {
        const a = this.loop[i], b = this.loop[(i + 1) % this.loop.length]
        this.loopCum.push(this.loopCum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]))
      }
    }
    this.probe = probe

    // 人: 一个 InstancedMesh，数量每帧按「楼内人数」增减
    this.capacity = 400 // 室内最多画 400 人
    this.people = new THREE.InstancedMesh(personGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.8, vertexColors: true }), this.capacity)
    this.people.count = 0
    this.people.castShadow = true
    this.people.frustumCulled = false // 实例散在整栋楼里，不裁剪
    const c = new THREE.Color()
    for (let i = 0; i < this.capacity; i++) this.people.setColorAt(i, c.set(PEOPLE_PALETTE[(this.rand() * PEOPLE_PALETTE.length) | 0])) // 颜色一次写好
    this.group.add(this.people)
    this.agents = [] // 室内的人: { still, x, y, yaw } 或 { s, v, off, ph }（沿走廊走）
    this.floorY = Y
  }

  /** 生成一个室内的人: 四成站在某家店里，其余沿走廊来回走（随机方向、速度、横向偏移） */
  #spawnPerson() {
    const r = this.rand
    if (this.shopSpots.length && r() < 0.4) {
      // 店里逛的: 站在某个铺位里
      const [cx, cy, ix, iy, bw] = this.shopSpots[(r() * this.shopSpots.length) | 0]
      const d = (r() - 0.5) * (this.shopDepth - 2), w = (r() - 0.5) * (bw - 1.5) // 在店铺范围内随机偏移（离墙 1m、离隔墙 0.75m）
      return { still: true, x: cx + ix * d - iy * w, y: cy + iy * d + ix * w, yaw: r() * 6.28 }
    }
    if (this.loop) return { s: r() * this.loopCum[this.loopCum.length - 1], v: (0.8 + r() * 0.6) * (r() < 0.5 ? 1 : -1), off: (r() - 0.5) * 3.4, ph: r() * 6.28 } // 走廊上: 随机起点、0.8~1.4 m/s、随机方向、横向 ±1.7m
    const p = this.probe[(r() * this.probe.length) | 0] || this.b.polygon[0] // 没走廊: 随便站在楼内某个点
    return { still: true, x: p[0], y: p[1], yaw: r() * 6.28 }
  }

  // -------------------------------------------------------------------------
  /** 地下车库 B1: 深色楼板 + 车位 + 每隔三个车位一根柱 + 从出入口下来的坡道；车按占用率显示前 K 个车位 */
  #buildGarage(angle, garage) {
    const Y = 0.25
    this.#shell('#565b63', '#3f444b', 0) // 深灰楼板、更深的墙
    // 车位布局和 Traffic 用的是同一个函数，所以室内的车位数就是车库容量
    const lay = layoutParking({ polygon: this.b.polygon, holes: this.b.holes || [] }, angle, garage?.entry || null)
    this.stalls = lay.stalls
    // 打乱一次，之后按占用数取前 K 个车位显示，数量变化时不会整体闪动
    for (let i = this.stalls.length - 1; i > 0; i--) { const j = (this.rand() * (i + 1)) | 0; [this.stalls[i], this.stalls[j]] = [this.stalls[j], this.stalls[i]] }

    const lines = [], pillars = []
    lay.lines.forEach((l, i) => { // 车位线: 每个车位两条
      const g = new THREE.BoxGeometry(l.length, 0.02, l.width)
      g.rotateY(-l.angle)
      g.translate(l.pos[0], Y + 0.015, l.pos[1])
      lines.push(g)
      if (i % 6 === 0) { // 柱网: 每隔三个车位一根，立在车位线的端头
        const ex = Math.cos(l.angle) * l.length / 2, ey = Math.sin(l.angle) * l.length / 2 // 线的端点
        const pg = new THREE.BoxGeometry(0.55, 2.4, 0.55) // 55cm 方柱，2.4m 高
        pg.rotateY(-angle)
        pg.translate(l.pos[0] + ex, Y + 1.2, l.pos[1] + ey)
        pillars.push(pg)
      }
    })
    this.#mesh(lines, '#e8eaed', { cast: false }) // 白色车位线
    this.#mesh(pillars, '#c9ced5')

    if (garage?.entry) { // 坡道: 从出入口斜着下来的一块板 + 两侧黄色警示边
      const [nx, ny] = garage.normal // 出入口朝外的方向
      const len = 11 // 坡道长 11m
      const ramp = new THREE.BoxGeometry(len, 0.12, 5.4) // 5.4m 宽的板
      ramp.rotateZ(-0.14) // 约 8° 的坡
      ramp.rotateY(Math.atan2(-ny, nx)) // 转到出入口方向
      ramp.translate(garage.entry[0] - nx * (len / 2 - 0.5), Y + 0.8, garage.entry[1] - ny * (len / 2 - 0.5))
      this.#mesh([ramp], '#7a808a')
      const edges = [-1, 1].map((sgn) => { // 两侧 20cm 宽的黄色警示边，和坡道同样的倾角和朝向
        const e = new THREE.BoxGeometry(len, 0.3, 0.2)
        e.rotateZ(-0.14)
        e.translate(0, 0, sgn * 2.7)
        e.rotateY(Math.atan2(-ny, nx))
        e.translate(garage.entry[0] - nx * (len / 2 - 0.5), Y + 0.95, garage.entry[1] - ny * (len / 2 - 0.5))
        return e
      })
      this.#mesh(edges, '#f0c24b') // 警示黄
    }

    // 每个车位预先写好一辆车的矩阵和颜色，显示时只改 count
    this.cars = new THREE.InstancedMesh(carGeometry(), carMaterial(), Math.max(1, this.stalls.length))
    this.cars.count = 0
    this.cars.castShadow = true
    this.cars.frustumCulled = false
    const m = new THREE.Matrix4(), c = new THREE.Color()
    this.stalls.forEach((st, i) => {
      const [dx, dy] = st.dir // 车位朝向（单位向量）
      m.set(dx, 0, -dy, st.pos[0], 0, 1, 0, Y + 0.02, dy, 0, dx, st.pos[1], 0, 0, 0, 1) // 车头朝 dir: 绕 Y 的旋转矩阵 + 平移到车位中心
      this.cars.setMatrixAt(i, m)
      this.cars.setColorAt(i, c.set(CAR_COLORS[(this.rand() * CAR_COLORS.length) | 0]))
    })
    this.group.add(this.cars)
  }

  /**
   * 每帧调用，dt 是仿真秒。live 是实时数据: mall → 楼内人数（crowd 里 visitors）；garage → { occupied, capacity }。
   * 商场: 人数不够就补人、多了就砍掉末尾；走动的人沿走廊推进并写实例矩阵。车库: 只改显示的车数。
   */
  update(dt, live) {
    if (this.kind === 'garage') { // 车库: 显示的车数 = 占用率 × 车位数（车位已打乱，所以增减都是随机位置）
      if (live && this.stalls.length) this.cars.count = Math.min(this.stalls.length, Math.round((live.occupied / Math.max(1, live.capacity)) * this.stalls.length))
      return
    }
    const want = Math.min(this.capacity, Math.max(8, live | 0)) // 至少放几个人，不然空楼看着像没做完
    while (this.agents.length < want) this.agents.push(this.#spawnPerson()) // 不够就补
    if (this.agents.length > want) this.agents.length = want // 多了砍掉末尾
    const arr = this.people.instanceMatrix.array
    const S = 1.25 // 人的缩放（室内镜头近，人画大一点）
    this.agents.forEach((a, i) => {
      let x = a.x, y = a.y, yaw = a.yaw, bob = 0 // 站着的人直接用记录的位置
      if (!a.still) {
        const total = this.loopCum[this.loopCum.length - 1] // 走廊周长
        a.s = (((a.s + a.v * dt) % total) + total) % total // 沿环走，负速度也能回绕
        a.ph += dt * 9 // 走路起伏相位
        // 找到弧长 s 落在走廊折线的哪一段，再按横向偏移 off 站到走廊的一侧
        let k = 1
        while (k < this.loopCum.length - 1 && this.loopCum[k] < a.s) k++
        const p = this.loop[k - 1], q = this.loop[k % this.loop.length] // 这一段的两端
        const l = this.loopCum[k] - this.loopCum[k - 1] || 1, t = (a.s - this.loopCum[k - 1]) / l // 段内参数 0~1
        const tx = (q[0] - p[0]) / l, ty = (q[1] - p[1]) / l // 段的单位切向
        x = p[0] + (q[0] - p[0]) * t - ty * a.off // 沿段插值 + 法向偏移
        y = p[1] + (q[1] - p[1]) * t + tx * a.off
        yaw = Math.atan2(tx * Math.sign(a.v), ty * Math.sign(a.v)) // 面朝行进方向
        bob = Math.abs(Math.sin(a.ph)) * 0.06 // 上下 6cm 的起伏
      }
      // 直接写 4x4 矩阵: 绕 Y 转 yaw、缩放 S、平移到 (x, 楼板 + 走路起伏, y)
      const c = Math.cos(yaw) * S, sn = Math.sin(yaw) * S, o = i * 16
      arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0
      arr[o + 4] = 0; arr[o + 5] = S; arr[o + 6] = 0; arr[o + 7] = 0
      arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0
      arr[o + 12] = x; arr[o + 13] = this.floorY + bob; arr[o + 14] = y; arr[o + 15] = 1
    })
    this.people.count = this.agents.length
    this.people.instanceMatrix.needsUpdate = true // 矩阵每帧重传
  }

  /** 释放所有几何体和材质（group 由引擎从场景里摘掉） */
  dispose() {
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose() })
  }
}
