// 与框架无关的渲染引擎: 吃一份 scene.json，生成整个三维城区并驱动人群、车流、轨道交通。
//
// 职责（Vue 组件 CityScene.vue 只是它的薄壳）:
//   · 渲染器 / 正交相机 / 灯光 / 阴影，视角操作（鼠标、键盘、触屏、外部按钮）
//   · load(): 按依赖顺序把各模块建起来 —— 导航网格 → 红绿灯 → 车流（先建，地面标线要用它排的车位）→ 地面 →
//     背景 → 建筑 → 轨道交通 → 需求模型 → 人群 → 树 / 路灯 → 热力层
//   · _tick(): 每帧把现实时间换成仿真时间，切成小步推进所有仿真模块，再渲染
//   · 环境: 按仿真时钟调人数、车流强度、昼夜光照、路灯
//   · 点选建筑 → 室内视图；stats() 给界面
// 所有 Three.js 对象都不进 Vue 的响应式系统（会被 Proxy 拖垮）。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { NavGrid } from './navgrid.js'
import { buildGround, buildBackdrop } from './ground.js'
import { buildBuildings, hiddenBuilding } from './buildings.js'
import { Interior } from './interior.js'
import { SimClock, activity, daylight } from './clock.js'
import { Transit } from './transit.js'
import { Demand } from './demand.js'
import { Crowd } from './crowd.js'
import { HeatLayer } from './heat.js'
import { Traffic } from './traffic.js'
import { Signals } from './signals.js'
import { CURB_H } from './ground.js'
import { buildTrees } from './props.js'
import { planLamps, buildLamps } from './lamps.js'
import { makeRandom } from './geometry.js'

/** 配色。可通过 options.style 局部覆盖 */
export const DEFAULT_STYLE = {
  background: '#b9c2ce',
  backdrop: '#9aa6b6',
  slab: '#eef0f2',
  road: '#5f636b',
  marking: '#f2f3f5',
  centerLine: '#f0c24b',
  pavement: '#e3e4e5',
  wall: '#cfd3d8',
  trim: '#eceef1',
  roof: '#d9dce1',
  grass: '#b1c9a8',
  underDeck: '#c3c8c4',
  park: '#bcd0b1',
  plaza: '#ddd6cb',
  water: '#8fbcdc',
  parking: '#6d727a',
}

export class CityEngine {
  /**
   * @param container  挂 canvas 的 DOM 元素，尺寸变化会自动适配
   * @param options    seed 随机种子 / peopleScale 小人放大 / capacity 人数上限 / clock 时钟参数 /
   *                   traffic、signals、trees、lamps、demand 为 false 时关掉对应模块 / onSelect 点选回调 / style 配色
   */
  constructor(container, options = {}) {
    this.container = container
    this.options = { seed: 7, peopleScale: 1.5, capacity: 4000, ...options }
    this.style = { ...DEFAULT_STYLE, ...(options.style || {}) }
    this.heatVisible = true

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.setClearColor(this.style.background)
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'

    this.scene = new THREE.Scene()
    // 正交相机: 等轴测的关键。远近的东西一样大，没有透视变形；缩放靠 camera.zoom
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(78)
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(5)
    this.controls.screenSpacePanning = false
    this.controls.zoomToCursor = true
    // 鼠标: 左键旋转 / 右键(或 Ctrl+左键)平移 / 滚轮缩放；触屏: 单指旋转、双指平移+缩放
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
    this.keys = new Set()
    this.#bindKeys()

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xaab4c2, 1.15)
    this.scene.add(this.hemi)
    // 太阳: 平行光 + 4096 的软阴影贴图；阴影相机的范围在 #updateShadow 里跟着视野走
    this.sun = new THREE.DirectionalLight(0xfff6ea, 2.1)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096)
    this.sun.shadow.radius = 5
    this.sun.shadow.blurSamples = 16
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.35
    this.scene.add(this.sun, this.sun.target)

    this.clock = new SimClock(options.clock)
    this.clock.on((ev) => {
      if (ev !== 'minute') this._envTimer = 0 // 整点 / 跳时间: 立刻刷新一次环境
      if (ev === 'jump' && this.crowd) { this.#applyEnvironment(1); this.crowd.reseed() } // 跳时间后世界不连续，按新时刻重新布置人群
    })
    this._envTimer = 0
    this.world = null
    this.interior = null
    this.onSelect = options.onSelect || null
    this.#bindPicking()
    this.timer = new THREE.Clock()
    this.frame = 0
    this._tick = this._tick.bind(this)
    this._resize = this._resize.bind(this)
    this.resizeObserver = new ResizeObserver(this._resize)
    this.resizeObserver.observe(container)
    this._resize()
    this.raf = requestAnimationFrame(this._tick)
  }

  /** 从 URL 加载 scene.json 并 load */
  async loadUrl(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`加载场景失败: ${url} (${res.status})`)
    this.load(await res.json())
  }

  /** 由 scene.json 建整个世界。可重复调用（先 unload）。各模块的建立顺序见文件头 */
  load(sceneData) {
    this.unload()
    const rand = makeRandom(this.options.seed)
    this.sceneData = sceneData
    const world = new THREE.Group()
    this.nav = new NavGrid(sceneData, { cell: 1.0 })
    this.signals = this.options.signals !== false ? new Signals(sceneData, rand) : null
    // 车流要先建: 停车位线是它排的，地面标线要用
    if (this.options.traffic !== false) this.traffic = new Traffic(sceneData, this.nav, rand, { signals: this.signals })
    world.add(buildGround(sceneData, this.style, this.traffic?.parkingLines || [], (this.traffic?.ramps || []).map((r) => r.gap), this.traffic?.islands || []))
    this.backdrop = buildBackdrop(sceneData, this.style, rand)
    world.add(this.backdrop)
    const { group, heatGeometry } = buildBuildings(sceneData, this.nav, rand, this.style)
    world.add(group)
    this.buildingsGroup = group
    this.rand = rand

    if (sceneData.transit) {
      this.transit = new Transit(sceneData, this.nav, this.clock)
      world.add(this.transit.group)
      // 列车到站 → 这一站的出入口放出一批人。人数取当前「应有人数」的缺口的一部分，总量仍然由日曲线决定
      this.transit.onArrive = (station) => {
        const gap = this.crowd ? this.crowd.population - this.crowd.active : 0
        if (gap > 0) this.crowd.arrive(station, Math.min(80, Math.ceil(gap * 0.6)))
      }
    }
    const withStations = { ...sceneData, portals: [...(sceneData.portals || []), ...(this.transit?.portals() || [])] } // 车站出入口也是人流出入口
    // 需求模型: 人群分组作息 + 场馆活动排期（options.demand === false 可关掉，退回「随机逛店」）
    const venues = sceneData.buildings.filter((b) => b.kind === 'venue').map((b) => ({ id: b.id, name: b.venue?.name || b.id, type: b.venue?.type || 'default', capacity: b.venue?.capacity || 2000 }))
    this.demand = this.options.demand === false ? null : new Demand(this.clock, venues, this.options.demandOptions)
    this.crowd = new Crowd(withStations, this.nav, rand, { capacity: this.options.capacity, peopleScale: this.options.peopleScale, signals: this.signals, demand: this.demand })
    this._envTimer = 0
    this.crowd.dwellScale = this._dwellScale ?? 1
    world.add(this.crowd.mesh)

    if (this.options.trees !== false) world.add(buildTrees(sceneData, this.nav, rand))
    // 路灯: 布点是纯函数，渲染是几个实例化网格；夜里由 #applyEnvironment 点亮
    if (this.options.lamps !== false) { this.lamps = buildLamps(planLamps(sceneData, this.nav, rand)); world.add(this.lamps.group) }
    if (this.traffic) {
      this.traffic.crowd = this.crowd
      world.add(this.traffic.mesh, this.traffic.decor)
      if (this.signals) {
        this.signals.attachSites(this.traffic.signalSites(), CURB_H)
        world.add(this.signals.group)
      }
    }

    if (heatGeometry) {
      this.heat = new HeatLayer(sceneData, heatGeometry)
      this.heat.mesh.visible = this.heatVisible
      world.add(this.heat.mesh)
    }
    this.scene.add(world)
    this.world = world
    this.#frameScene(sceneData.bounds)
  }

  /** 拆掉整个世界: 递归释放几何体和材质，各仿真模块 dispose */
  unload() {
    if (!this.world) return
    this.hideInterior(false)
    this.scene.remove(this.world)
    this.world.traverse((o) => {
      o.geometry?.dispose()
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
      for (const m of mats) { m.map?.dispose(); m.dispose() }
    })
    this.heat?.dispose()
    this.crowd?.dispose()
    this.traffic?.dispose()
    this.lamps?.dispose()
    this.lamps = null
    this.transit?.dispose()
    this.transit = null
    this.world = this.heat = this.crowd = this.nav = this.traffic = this.signals = null
  }

  /** 初始取景: 相机对准街区主方向的 45° 斜视，俯角 38°，整个地块刚好装进视口 */
  #frameScene(b) {
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2
    const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2
    this.sceneRadius = radius
    // 相机方位对准街区主方向的 45°，画面里就是标准的等轴测菱形
    const el = THREE.MathUtils.degToRad(this.options.elevation ?? 38)
    const az = Math.PI / 4 - (this.sceneData.angle || 0)
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    this.controls.target.set(cx, 0, cz)
    this.camera.position.copy(this.controls.target).addScaledVector(dir, 2500)
    this.camera.zoom = 1
    // 地块在屏幕上的投影尺寸（按包围圆估算，和朝向无关），_resize 里据此适配宽高
    this.fit = { w: radius * 2 * 1.08, h: radius * 2 * Math.sin(el) * 1.08 + 30 }
    this.controls.minZoom = 0.4
    this.controls.maxZoom = 14
    this._resize()
    this.controls.update()

    this._shadowKey = ''
    this.#updateShadow()
  }

  /**
   * 阴影相机跟着视野走: 只包住当前看得见的范围（不超过整个场景）。
   * 城区有几公里宽，一张 4096 的阴影贴图铺满全城的话每像素 0.7m，影子全是糊的；拉近看街区时自动变清晰。
   */
  #updateShadow() {
    const t = this.controls.target
    const view = ((this.camera.top * 2) / this.camera.zoom) * Math.max(1, this.camera.right / this.camera.top)
    const r = Math.min(this.sceneRadius * 1.15, Math.max(140, view * 0.8))
    const q = r / 6 // 位置按 r/6 取整: 视角小幅移动时不用每帧重设，影子也不会抖
    const key = `${Math.round(t.x / q)},${Math.round(t.z / q)},${Math.round(Math.log2(r) * 3)}`
    if (key === this._shadowKey) return
    this._shadowKey = key
    const cx = Math.round(t.x / q) * q, cz = Math.round(t.z / q) * q
    // 太阳从左后方打过来，影子落向右前
    this.sun.target.position.set(cx, 0, cz)
    this.sun.position.set(cx - r * 0.9, r * 1.5, cz + r * 0.35)
    const sc = this.sun.shadow.camera
    sc.left = sc.bottom = -r
    sc.right = sc.top = r
    sc.near = 1
    sc.far = r * 4
    sc.updateProjectionMatrix()
  }

  // -------------------------------------------------------------------------
  // 视角: 旋转 / 平移 / 缩放（键盘和外部按钮共用这几个方法）
  // -------------------------------------------------------------------------
  /** 绕目标点水平转 dAz、俯仰转 dEl（弧度）。俯仰限制在 5°~78° */
  orbit(dAz, dEl = 0) {
    const off = this.camera.position.clone().sub(this.controls.target)
    const sph = new THREE.Spherical().setFromVector3(off)
    sph.theta += dAz
    sph.phi = THREE.MathUtils.clamp(sph.phi - dEl, this.controls.minPolarAngle, this.controls.maxPolarAngle)
    this.camera.position.copy(this.controls.target).add(off.setFromSpherical(sph))
    this.controls.update()
  }

  /** 沿屏幕的 右/上 方向在地面上平移（单位: 米） */
  pan(right, up) {
    const az = Math.atan2(this.camera.position.x - this.controls.target.x, this.camera.position.z - this.controls.target.z)
    const dx = Math.cos(az) * right - Math.sin(az) * up, dz = -Math.sin(az) * right - Math.cos(az) * up
    this.controls.target.x += dx; this.controls.target.z += dz
    this.camera.position.x += dx; this.camera.position.z += dz
    this.controls.update()
  }

  /** 缩放（乘因子），限制在 minZoom~maxZoom */
  zoomBy(factor) {
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, this.controls.minZoom, this.controls.maxZoom)
    this.camera.updateProjectionMatrix()
  }

  /** 回到初始取景 */
  resetView() {
    if (this.sceneData) this.#frameScene(this.sceneData.bounds)
  }

  /** 键盘: canvas 可聚焦，按下的键记在 this.keys 里，#applyKeys 每帧按住持续运动 */
  #bindKeys() {
    const el = this.renderer.domElement
    el.tabIndex = 0
    el.style.outline = 'none'
    el.addEventListener('pointerdown', () => el.focus())
    el.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase()
      if (k === 'home' || k === '0') return this.resetView()
      if (['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', '+', '=', '-', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { this.keys.add(k); e.preventDefault() }
    })
    el.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()))
    el.addEventListener('blur', () => this.keys.clear())
  }

  /** 按住键持续运动: WASD/方向键平移，Q/E 旋转，R/F 俯仰，+/- 缩放，Home 或 0 复位 */
  #applyKeys(dt) {
    const K = this.keys
    if (!K.size) return
    const speed = ((this.camera.top * 2) / this.camera.zoom) * 0.9 * dt // 每秒移动约 0.9 个屏高
    const h = (K.has('d') || K.has('arrowright') ? 1 : 0) - (K.has('a') || K.has('arrowleft') ? 1 : 0)
    const v = (K.has('w') || K.has('arrowup') ? 1 : 0) - (K.has('s') || K.has('arrowdown') ? 1 : 0)
    if (h || v) this.pan(h * speed, v * speed)
    const rot = (K.has('e') ? 1 : 0) - (K.has('q') ? 1 : 0), tilt = (K.has('r') ? 1 : 0) - (K.has('f') ? 1 : 0)
    if (rot || tilt) this.orbit(rot * dt * 1.4, tilt * dt * 0.9)
    const z = (K.has('+') || K.has('=') ? 1 : 0) - (K.has('-') ? 1 : 0)
    if (z) this.zoomBy(Math.exp(z * dt * 1.4))
  }

  // -------------------------------------------------------------------------
  // 点选建筑 / 室内视图
  // -------------------------------------------------------------------------
  /** 点选: 按下和抬起位置相差 5px 以内算点击，射线打到建筑网格后从 bid 属性读出是哪栋楼 */
  #bindPicking() {
    const el = this.renderer.domElement
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
    let down = null
    el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]))
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !this.buildingsGroup) return // 拖动视角不算点击
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, this.camera)
      const hit = ray.intersectObjects(this.buildingsGroup.children, false)[0]
      if (!hit) return
      const attr = hit.object.geometry.attributes.bid
      const bid = attr ? attr.getX(hit.object.isInstancedMesh ? hit.instanceId : hit.face.a) : -1
      if (bid < 0 || bid === hiddenBuilding.value) return
      const info = this.buildingInfo(this.sceneData.buildings[bid].id)
      if (this.onSelect) this.onSelect(info)
      else if (info.views.length) this.showInterior(info.id, info.views[0])
    })
  }

  /** 这栋楼能看哪些室内视图、此刻楼里多少人、车库占用多少 */
  buildingInfo(id) {
    const b = this.sceneData.buildings.find((x) => x.id === id)
    const garage = this.traffic?.garageInfo(id) || null
    const views = []
    if (b.kind === 'shop') views.push('mall') // 商场一层的室内视图只对商铺楼有意义
    if (garage) views.push('garage')
    return { id, kind: b.kind, floors: b.floors, views, visitors: this.crowd?.buildings.get(id)?.visitors ?? 0, garage: garage && { capacity: garage.capacity, occupied: garage.occupied } }
  }

  /** 进入某栋楼的室内视图（'mall' | 'garage'）: 隐藏楼体、原地建室内、镜头推近；再次调用会切换视图但保留原视角 */
  showInterior(id, kind = 'mall') {
    const idx = this.sceneData.buildings.findIndex((x) => x.id === id)
    if (idx < 0) return
    const b = this.sceneData.buildings[idx]
    const saved = this.interior?.saved || { target: this.controls.target.clone(), position: this.camera.position.clone(), zoom: this.camera.zoom }
    this.hideInterior(false)
    hiddenBuilding.value = idx
    this.interior = new Interior(b, kind, { rand: this.rand, angle: this.sceneData.angle || 0, garage: this.traffic?.garageInfo(id) })
    this.interior.saved = saved
    this.interior.buildingId = id
    this.world.add(this.interior.group)
    // 镜头推到这栋楼
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of b.polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    const size = Math.hypot(maxX - minX, maxY - minY)
    this.#flyTo((minX + maxX) / 2, (minY + maxY) / 2, Math.min(12, (this.camera.top * 2) / (size * 1.5))) // 正交相机: 可见高度 = 视口高 / zoom
  }

  /** 退出室内视图，恢复楼体，可选飞回原视角 */
  hideInterior(restoreCamera = true) {
    if (!this.interior) return
    hiddenBuilding.value = -1
    this.world?.remove(this.interior.group)
    this.interior.dispose()
    const s = this.interior.saved
    this.interior = null
    if (restoreCamera && s) this.#flyTo(s.target.x, s.target.z, s.zoom)
  }

  /** 保持视角方向不变，平移到 (x,z) 并缩放，0.6 秒缓动 */
  #flyTo(x, z, zoom) {
    const t0 = this.controls.target.clone(), off = this.camera.position.clone().sub(t0)
    this.fly = { t: 0, from: t0, to: new THREE.Vector3(x, 0, z), off, z0: this.camera.zoom, z1: zoom }
  }

  /** n = 一天里高峰时刻的同时在场人数；实际人数 = n × 当前时刻的活跃度曲线 */
  setPopulation(n) {
    this._population = n
    this._envTimer = 0
  }

  /** 按仿真时钟刷新「环境」: 人数、车流强度、昼夜光照。每半秒一次就够了 */
  #applyEnvironment(dt) {
    this._envTimer -= dt
    if (this._envTimer > 0 || !this.crowd) return
    this._envTimer = 0.5
    const { dayType, hour } = this.clock
    this.crowd.base = this._population ?? 600
    if (!this.demand) this.crowd.population = Math.round(this.crowd.base * activity('people', dayType, hour)) // 有需求模型时，应有人数由人群分组 + 活动算出
    this.traffic?.setDemand(activity('cars', dayType, hour))

    const dl = daylight(hour)
    this.sun.intensity = 0.15 + 1.95 * dl
    this.sun.color.set('#fff6ea').lerp(new THREE.Color('#ffb070'), THREE.MathUtils.clamp((0.45 - dl) / 0.35, 0, 1)) // 清晨黄昏偏暖
    this.hemi.intensity = 0.3 + 0.85 * dl
    this.lamps?.setNight(1 - dl) // 黄昏开灯，深夜最亮
    const sky = new THREE.Color('#1b2333').lerp(new THREE.Color(this.style.background), dl)
    this.renderer.setClearColor(sky)
    this.backdrop?.material.color.setScalar(0.13 + 0.87 * dl) // 背景楼块的颜色是烘焙的，整体压暗
    const glass = this.buildingsGroup?.getObjectByName('glass')
    if (glass) { glass.material.emissive.set('#ffd9a0'); glass.material.emissiveIntensity = (1 - dl) * 0.85 } // 夜里亮窗
  }

  /** 店内停留时长倍率 */
  setDwellScale(s) {
    this._dwellScale = s
    if (this.crowd) this.crowd.dwellScale = s
  }

  /** { 建筑id: 吸引力 }，接后端的客流 / 消费测算结果 */
  setAttraction(map) { this.crowd?.setAttraction(map) }

  /** 显示 / 隐藏屋顶热力图 */
  setHeatVisible(v) {
    this.heatVisible = v
    if (this.heat) this.heat.mesh.visible = v
  }

  /** 跳到下一场场馆活动开始进场的时候；没有排期返回 false */
  jumpToNextEvent() {
    const t = this.demand?.nextIngress()
    if (t) this.clock.jumpTo(t)
    return !!t
  }

  /** 仿真速度（倍）。0 = 暂停 */
  setRate(r) { this.clock.paused = r <= 0; if (r > 0) this.clock.setRate(r) }

  /** 给界面的统计: 人群各项 + 时钟标签 + 在途车数 + 轨道交通 */
  stats() { return this.crowd ? { ...this.crowd.stats(), clock: this.clock.label, dayType: this.clock.dayType, cars: this.traffic?.roadCount ?? 0, transit: this.transit?.stats() || null } : null }

  /** 容器尺寸变化: 重设渲染尺寸；正交相机的视口按 fit 适配，宽高两个方向都要装得下地块 */
  _resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    const aspect = w / h
    // 宽、高两个方向都要装得下地块，取更紧的那个
    const fit = this.fit || { w: 100, h: 100 }
    const half = Math.max(fit.h, fit.w / aspect) / 2
    this.camera.left = -half * aspect
    this.camera.right = half * aspect
    this.camera.top = half
    this.camera.bottom = -half
    this.camera.updateProjectionMatrix()
  }

  _tick() {
    this.raf = requestAnimationFrame(this._tick)
    const dt = Math.min(this.timer.getDelta(), 0.05)
    // 这一帧要推进多少仿真秒。物理按小步走（车 ≤0.25s、人 ≤0.5s 一步）才稳定；
    // 一帧最多 16 小步，倍速高到算不完时少推进一点，时钟自然就慢下来等物理
    const MAX_STEPS = 16, CAR_STEP = 0.25
    const simDt = this.clock.tick(Math.min(dt, (MAX_STEPS * CAR_STEP) / Math.max(1, this.clock.rate)))
    this.#applyEnvironment(dt)
    if (this.crowd && simDt > 0) {
      const n = Math.max(1, Math.ceil(simDt / CAR_STEP)), step = simDt / n
      let crowdDt = 0
      for (let i = 0; i < n; i++) {
        this.signals?.update(step)
        crowdDt += step
        const last = i === n - 1
        if (crowdDt >= 0.5 || last) { this.crowd.update(crowdDt, last); crowdDt = 0 }
        if (this.crowd.ready) this.traffic?.update(step, last)
        this.transit?.update(step, last)
      }
      if (this.heat && this.heatVisible) this.heat.update(dt, this.crowd.heatSamples, this.crowd.heatCount) // 热力的时间平滑按现实时间，倍速再高也不闪
    }
    if (this.interior) {
      const id = this.interior.buildingId
      this.interior.update(simDt, this.interior.kind === 'garage' ? this.traffic?.garageInfo(id) : this.crowd?.buildings.get(id)?.visitors)
    }
    this.#applyKeys(dt)
    if (this.fly) {
      const f = this.fly
      f.t = Math.min(1, f.t + dt / 0.6)
      const k = f.t * f.t * (3 - 2 * f.t)
      this.controls.target.lerpVectors(f.from, f.to, k)
      this.camera.position.copy(this.controls.target).add(f.off)
      this.camera.zoom = f.z0 + (f.z1 - f.z0) * k
      this.camera.updateProjectionMatrix()
      if (f.t >= 1) this.fly = null
    }
    this.controls.update()
    if (this.world) this.#updateShadow()
    this.renderer.render(this.scene, this.camera)
    this.frame++
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resizeObserver.disconnect()
    this.unload()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
