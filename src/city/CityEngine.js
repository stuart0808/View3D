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
  background: '#b9c2ce', // 画布清屏色，也是背景楼块「雾」的目标色
  backdrop: '#9aa6b6', // 背景楼块本色
  slab: '#eef0f2', // 地块底座、高架护栏
  road: '#5f636b', // 路面、高架桥面
  marking: '#f2f3f5', // 白色标线（车道线、斑马线、车位线）
  centerLine: '#f0c24b', // 黄色中心线
  pavement: '#e3e4e5', // 人行铺装
  wall: '#cfd3d8', // （保留）早期建筑墙色
  trim: '#eceef1', // （保留）早期女儿墙色
  roof: '#d9dce1', // 屋面底色
  grass: '#b1c9a8', // 绿化带、中央隔离带
  underDeck: '#c3c8c4', // 桥下隔离带、匝道岛
  park: '#bcd0b1', // 公园
  plaza: '#ddd6cb', // 广场
  water: '#8fbcdc', // 水面
  parking: '#6d727a', // 停车场地面
}

export class CityEngine {
  /**
   * @param container  挂 canvas 的 DOM 元素，尺寸变化会自动适配
   * @param options    seed 随机种子 / peopleScale 小人放大 / capacity 人数上限 / clock 时钟参数 /
   *                   traffic、signals、trees、lamps、demand 为 false 时关掉对应模块 / onSelect 点选回调 / style 配色
   */
  constructor(container, options = {}) {
    // 默认值: seed 7 保证同一场景每次打开长得一样；peopleScale 1.5 让小人在等轴测远景里看得清；
    // capacity 4000 是人群实例化网格的上限（超出的人不画，只算数）
    this.container = container
    this.options = { seed: 7, peopleScale: 1.5, capacity: 4000, ...options }
    this.style = { ...DEFAULT_STYLE, ...(options.style || {}) }
    this.heatVisible = true // 屋顶热力层默认显示；load 时同步到 heat.mesh.visible

    // 渲染器: 抗锯齿 + 软阴影；像素比封顶 2，4K 屏也不至于爆显存
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap // 软阴影: 边缘多次采样，等轴测下影子不会有锯齿
    this.renderer.setClearColor(this.style.background) // 清屏色 = 配色里的背景色，夜里由 #applyEnvironment 压暗
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block' // 去掉 inline 元素底部的几像素空隙，否则容器会冒出滚动条

    this.scene = new THREE.Scene()
    // 正交相机: 等轴测的关键。远近的东西一样大，没有透视变形；缩放靠 camera.zoom
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true // 惯性: 松手后视角还会滑一小段；0.08 每帧收敛 8%，大约半秒停下
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(78) // 俯角最低 12°: 再平就会看到楼体穿帮和地面以下
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(5) // 最高只到接近正俯视，留一点方向感
    this.controls.screenSpacePanning = false // 平移贴着地面走，不沿屏幕平面（否则会飞离地面）
    this.controls.zoomToCursor = true // 滚轮朝鼠标位置缩放，看街角时不用先把它拖到屏幕中心
    // 鼠标: 左键旋转 / 右键(或 Ctrl+左键)平移 / 滚轮缩放；触屏: 单指旋转、双指平移+缩放
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
    this.keys = new Set() // 当前按住的键名（小写），#applyKeys 每帧读
    this.#bindKeys()

    // 天光: 半球光（天空白、地面偏蓝灰）；强度和颜色夜里由 #applyEnvironment 调
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xaab4c2, 1.15)
    this.scene.add(this.hemi)
    // 太阳: 平行光 + 4096 的软阴影贴图；阴影相机的范围在 #updateShadow 里跟着视野走
    this.sun = new THREE.DirectionalLight(0xfff6ea, 2.1) // 略暖的白光；强度 2.1 是正午，夜里降到 0.15
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096) // 贴图越大影子越清晰；配合 #updateShadow 只覆盖可见范围
    this.sun.shadow.radius = 5 // PCF 采样半径 + 采样数: 影子边缘的柔和程度
    this.sun.shadow.blurSamples = 16
    this.sun.shadow.bias = -0.0004 // 深度偏移压掉阴影痤疮（表面自遮挡的条纹）
    this.sun.shadow.normalBias = 0.35 // 沿法线偏移 0.35m: 楼体侧面不会出现漏光的细缝，对这个尺度刚好
    this.scene.add(this.sun, this.sun.target)

    // 仿真时钟: 所有模块的时间都来自它（见 clock.js）
    this.clock = new SimClock(options.clock)
    // 时钟事件: 'minute' 每仿真分钟一次（环境按现实时间刷新，不用理）；'hour' / 'jump' 立刻刷新
    this.clock.on((ev) => {
      if (ev !== 'minute') this._envTimer = 0 // 整点 / 跳时间: 立刻刷新一次环境
      if (ev === 'jump' && this.crowd) { this.#applyEnvironment(1); this.crowd.reseed() } // 跳时间后世界不连续，按新时刻重新布置人群
    })
    this._envTimer = 0 // 距下次刷新环境的现实秒数
    this.world = null // 当前场景的根 Group（load 建、unload 拆）
    this.interior = null // 打开中的室内视图
    this.onSelect = options.onSelect || null // 外部点选回调；没给的话点楼直接进室内视图
    this.#bindPicking()
    this.timer = new THREE.Clock() // 现实时间，getDelta 给帧间隔
    this.frame = 0 // 已渲染帧数（调试 / 测试用）
    // rAF 和 ResizeObserver 的回调要绑定 this
    this._tick = this._tick.bind(this)
    this._resize = this._resize.bind(this)
    // 容器尺寸变化自动适配；然后开始逐帧循环
    this.resizeObserver = new ResizeObserver(this._resize)
    this.resizeObserver.observe(container)
    this._resize()
    this.raf = requestAnimationFrame(this._tick)
  }

  /** 从 URL 加载 scene.json 并 load */
  async loadUrl(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`加载场景失败: ${url} (${res.status})`)
    this.baseUrl = url.slice(0, url.lastIndexOf('/') + 1) // 场景里的相对路径（卫星底图）相对它解析
    this.load(await res.json())
  }

  /** 由 scene.json 建整个世界。可重复调用（先 unload）。各模块的建立顺序见文件头 */
  load(sceneData) {
    this.unload()
    // 随机源: 同一个 seed → 同样的楼型、树位、路灯，方便复现和对比
    const rand = makeRandom(this.options.seed)
    this.sceneData = sceneData
    const world = new THREE.Group()
    // 导航网格 1m 一格: 人群寻路、树 / 路灯避让、商铺临街判断都靠它
    this.nav = new NavGrid(sceneData, { cell: 1.0 })
    // 红绿灯先于车流建: 车流按路口的信号相位决定停走
    this.signals = this.options.signals !== false ? new Signals(sceneData, rand) : null
    // 车流要先建: 停车位线是它排的，地面标线要用
    if (this.options.traffic !== false) this.traffic = new Traffic(sceneData, this.nav, rand, { signals: this.signals })
    // 地面要知道: 停车位线（车流排的）、匝道在路缘上开的缺口、桥下的隔离岛
    this.ground = buildGround(sceneData, this.style, this.traffic?.parkingLines || [], (this.traffic?.ramps || []).map((r) => r.gap), this.traffic?.islands || [])
    world.add(this.ground)
    // 卫星底图（导入的场景才有）: 原图按米铺在地面上，打开时隐藏程序生成的路面 / 铺装 / 区域 / 标线，对照识别结果
    this.imagery = sceneData.imagery ? this.#buildImagery(sceneData.imagery) : null
    if (this.imagery) { world.add(this.imagery); this.setImagery(this._imageryOn ?? true) }
    // 背景楼块: 核心区以外的简化体块，只是让画面边缘不空
    this.backdrop = buildBackdrop(sceneData, this.style, rand)
    world.add(this.backdrop)
    // 建筑: 合并网格 + 实例化细部；heatGeometry 是屋顶热力层的几何体
    const { group, heatGeometry } = buildBuildings(sceneData, this.nav, rand, this.style)
    world.add(group)
    this.buildingsGroup = group // 点选只打这一组
    this.rand = rand // 室内视图沿用同一随机源

    // 轨道交通（可选）: 线路、车站、列车由 Transit 管理，时钟共用
    if (sceneData.transit) {
      this.transit = new Transit(sceneData, this.nav, this.clock)
      world.add(this.transit.group)
      // 列车到站 → 这一站的出入口放出一批人。人数取当前「应有人数」的缺口的一部分，总量仍然由日曲线决定
      this.transit.onArrive = (station) => {
        const gap = this.crowd ? this.crowd.population - this.crowd.active : 0
        // 每趟最多 80 人、取缺口的 60%: 一趟车不会把缺口一次填满，多站到达时人数分布更均匀
        if (gap > 0) this.crowd.arrive(station, Math.min(80, Math.ceil(gap * 0.6)))
      }
    }
    const withStations = { ...sceneData, portals: [...(sceneData.portals || []), ...(this.transit?.portals() || [])] } // 车站出入口也是人流出入口
    // 需求模型: 人群分组作息 + 场馆活动排期（options.demand === false 可关掉，退回「随机逛店」）
    // 场馆列表交给需求模型排活动；没写 venue 字段的场馆给默认名 / 类型 / 2000 人容量
    const venues = sceneData.buildings.filter((b) => b.kind === 'venue').map((b) => ({ id: b.id, name: b.venue?.name || b.id, type: b.venue?.type || 'default', capacity: b.venue?.capacity || 2000 }))
    this.demand = this.options.demand === false ? null : new Demand(this.clock, venues, this.options.demandOptions)
    // 人群: 容量、放大倍数、红绿灯（过马路要看灯）、需求模型（决定去哪）
    this.crowd = new Crowd(withStations, this.nav, rand, { capacity: this.options.capacity, peopleScale: this.options.peopleScale, signals: this.signals, demand: this.demand })
    this._envTimer = 0 // 新世界立刻刷一次环境（人数 / 光照）
    this.crowd.dwellScale = this._dwellScale ?? 1 // load 之前设过的停留倍率补上
    world.add(this.crowd.mesh)

    // 树: 沿人行道 / 公园按导航网格布点，静态网格
    if (this.options.trees !== false) world.add(buildTrees(sceneData, this.nav, rand))
    // 路灯: 布点是纯函数，渲染是几个实例化网格；夜里由 #applyEnvironment 点亮
    if (this.options.lamps !== false) { this.lamps = buildLamps(planLamps(sceneData, this.nav, rand)); world.add(this.lamps.group) }
    // 车流网格挂到世界；车流要认识人群（斑马线让行、车库接送）
    if (this.traffic) {
      this.traffic.crowd = this.crowd
      world.add(this.traffic.mesh, this.traffic.decor)
      // 红绿灯灯柱放到车流算出的路口位置上，柱脚抬到路缘高度
      if (this.signals) {
        this.signals.attachSites(this.traffic.signalSites(), CURB_H)
        world.add(this.signals.group)
      }
    }

    // 屋顶热力层: 用建筑给的几何体，颜色由人群热力采样每帧更新
    if (heatGeometry) {
      this.heat = new HeatLayer(sceneData, heatGeometry)
      this.heat.mesh.visible = this.heatVisible
      world.add(this.heat.mesh)
    }
    this.scene.add(world)
    this.world = world
    this.#frameScene(sceneData.bounds) // 按地块范围取景
  }

  /** 拆掉整个世界: 递归释放几何体和材质，各仿真模块 dispose */
  unload() {
    if (!this.world) return
    this.hideInterior(false) // 先关室内视图，不飞回原视角（世界都要拆了）
    this.scene.remove(this.world)
    // 递归释放几何体和材质；材质可能是数组（多材质），贴图也要释放，否则显存只增不减
    this.world.traverse((o) => {
      o.geometry?.dispose()
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
      for (const m of mats) { m.map?.dispose(); m.dispose() }
    })
    // 各仿真模块有自己的 GPU 缓冲 / 定时器，要单独 dispose
    this.heat?.dispose()
    this.crowd?.dispose()
    this.traffic?.dispose()
    this.lamps?.dispose()
    this.lamps = null
    this.transit?.dispose()
    this.transit = null
    this.world = this.heat = this.crowd = this.nav = this.traffic = this.signals = null // 引用清空，stats() / _tick 靠这些判空
  }

  /** 初始取景: 相机对准街区主方向的 45° 斜视，俯角 38°，整个地块刚好装进视口 */
  #frameScene(b) {
    const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2
    const radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2
    this.sceneRadius = radius // 包围圆半径 (m)，#updateShadow 用它封顶阴影范围
    // 相机方位对准街区主方向的 45°，画面里就是标准的等轴测菱形
    // （街区本身转了 angle，所以方位角要减掉它）；俯角默认 38°，options.elevation 可改
    const el = THREE.MathUtils.degToRad(this.options.elevation ?? 38)
    const az = Math.PI / 4 - (this.sceneData.angle || 0)
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    this.controls.target.set(cx, 0, cz)
    this.camera.position.copy(this.controls.target).addScaledVector(dir, 2500) // 拉到 2500m 外: 正交相机距离不影响大小，只要楼都在 near/far 内
    this.camera.zoom = 1 // 视口按 fit 适配，zoom=1 就是整个地块
    // 地块在屏幕上的投影尺寸（按包围圆估算，和朝向无关），_resize 里据此适配宽高
    // 1.08 留 8% 边距；高度乘 sin(el) 是因为俯视时地块在屏幕上被压扁；+30 给楼高留位置
    this.fit = { w: radius * 2 * 1.08, h: radius * 2 * Math.sin(el) * 1.08 + 30 }
    this.controls.minZoom = 0.4 // 最远看到 2.5 倍地块，最近 14 倍（一条街占满屏）
    this.controls.maxZoom = 14
    this._resize()
    this.controls.update()

    this._shadowKey = '' // 清掉缓存键，强制阴影范围重算
    this.#updateShadow()
  }

  /**
   * 阴影相机跟着视野走: 只包住当前看得见的范围（不超过整个场景）。
   * 城区有几公里宽，一张 4096 的阴影贴图铺满全城的话每像素 0.7m，影子全是糊的；拉近看街区时自动变清晰。
   */
  #updateShadow() {
    const t = this.controls.target
    // 屏幕上可见的世界尺寸 (m): 视口高 / zoom，横屏时再乘宽高比取宽的那个方向
    const view = ((this.camera.top * 2) / this.camera.zoom) * Math.max(1, this.camera.right / this.camera.top)
    // 阴影半径 = 可见尺寸的 0.8 倍（影子会往画面外投一点，不用全包）；至少 140m，最多场景的 1.15 倍
    const r = Math.min(this.sceneRadius * 1.15, Math.max(140, view * 0.8))
    const q = r / 6 // 位置按 r/6 取整: 视角小幅移动时不用每帧重设，影子也不会抖
    // 位置和半径凑成缓存键；半径按 log2 的 1/3 量化，缩放 26% 以内不重算
    const key = `${Math.round(t.x / q)},${Math.round(t.z / q)},${Math.round(Math.log2(r) * 3)}`
    if (key === this._shadowKey) return
    this._shadowKey = key
    const cx = Math.round(t.x / q) * q, cz = Math.round(t.z / q) * q
    // 太阳从左后方打过来，影子落向右前；高度 1.5r 保证斜射角固定，阴影方向不随范围变
    this.sun.target.position.set(cx, 0, cz)
    this.sun.position.set(cx - r * 0.9, r * 1.5, cz + r * 0.35)
    // 阴影相机: 正方形 2r×2r；深度范围到 4r（太阳距目标约 1.8r，够包住所有楼）
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
    // 相机相对目标点的偏移转成球坐标: theta 方位、phi 极角（0 = 正上方，所以抬头是减）
    const off = this.camera.position.clone().sub(this.controls.target)
    const sph = new THREE.Spherical().setFromVector3(off)
    sph.theta += dAz
    sph.phi = THREE.MathUtils.clamp(sph.phi - dEl, this.controls.minPolarAngle, this.controls.maxPolarAngle)
    this.camera.position.copy(this.controls.target).add(off.setFromSpherical(sph))
    this.controls.update()
  }

  /** 沿屏幕的 右/上 方向在地面上平移（单位: 米） */
  pan(right, up) {
    // 相机方位角: 屏幕的「上」在地面上就是从相机指向目标的方向，「右」与之垂直
    const az = Math.atan2(this.camera.position.x - this.controls.target.x, this.camera.position.z - this.controls.target.z)
    const dx = Math.cos(az) * right - Math.sin(az) * up, dz = -Math.sin(az) * right - Math.cos(az) * up
    // 目标点和相机一起移，视角方向不变
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
    el.tabIndex = 0 // canvas 默认不能聚焦，tabIndex 让它能收键盘事件
    el.style.outline = 'none' // 聚焦时不画浏览器的焦点框
    el.addEventListener('pointerdown', () => el.focus()) // 点一下画布就聚焦，随后键盘生效
    el.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase()
      if (k === 'home' || k === '0') return this.resetView() // 一次性动作，不进 keys
      // 持续动作的键记下来并拦截默认行为（方向键滚页面、+/- 缩放网页）；其他键放过去
      if (['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', '+', '=', '-', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { this.keys.add(k); e.preventDefault() }
    })
    el.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()))
    el.addEventListener('blur', () => this.keys.clear()) // 失焦时清空，否则切窗口时按住的键会「卡住」
  }

  /** 按住键持续运动: WASD/方向键平移，Q/E 旋转，R/F 俯仰，+/- 缩放，Home 或 0 复位 */
  #applyKeys(dt) {
    const K = this.keys
    if (!K.size) return
    const speed = ((this.camera.top * 2) / this.camera.zoom) * 0.9 * dt // 每秒移动约 0.9 个屏高（按米算，缩放越近走得越慢）
    // 平移: 左右 / 上下各算成 -1/0/1，同时按两个键就斜着走
    const h = (K.has('d') || K.has('arrowright') ? 1 : 0) - (K.has('a') || K.has('arrowleft') ? 1 : 0)
    const v = (K.has('w') || K.has('arrowup') ? 1 : 0) - (K.has('s') || K.has('arrowdown') ? 1 : 0)
    if (h || v) this.pan(h * speed, v * speed)
    // 旋转 1.4 rad/s、俯仰 0.9 rad/s
    const rot = (K.has('e') ? 1 : 0) - (K.has('q') ? 1 : 0), tilt = (K.has('r') ? 1 : 0) - (K.has('f') ? 1 : 0)
    if (rot || tilt) this.orbit(rot * dt * 1.4, tilt * dt * 0.9)
    // 缩放按指数走（每秒 e^1.4 ≈ 4 倍），放大和缩小对称
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
    let down = null // 按下时的屏幕坐标，抬起时比对判断是否是点击
    el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]))
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !this.buildingsGroup) return // 拖动视角不算点击
      // 屏幕坐标 → NDC (-1..1，y 向上)，射线从正交相机发出
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, this.camera)
      // 只打建筑组的直接子网格（墙 / 幕墙 / 屋面 / 实例盒子），不递归；取最近的一个
      const hit = ray.intersectObjects(this.buildingsGroup.children, false)[0]
      if (!hit) return
      // 合并网格从命中三角形的第一个顶点读 bid；实例化网格按实例编号读
      const attr = hit.object.geometry.attributes.bid
      const bid = attr ? attr.getX(hit.object.isInstancedMesh ? hit.instanceId : hit.face.a) : -1
      if (bid < 0 || bid === hiddenBuilding.value) return // 没编号（空实例填 -2）或点到正被隐藏的楼: 忽略
      const info = this.buildingInfo(this.sceneData.buildings[bid].id)
      // 有回调交给界面决定；否则直接打开第一个可用的室内视图
      if (this.onSelect) this.onSelect(info)
      else if (info.views.length) this.showInterior(info.id, info.views[0])
    })
  }

  /** 这栋楼能看哪些室内视图、此刻楼里多少人、车库占用多少 */
  buildingInfo(id) {
    const b = this.sceneData.buildings.find((x) => x.id === id)
    const garage = this.traffic?.garageInfo(id) || null // 有停车场配置的楼才有，来自车流模块
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
    // 已经在室内视图里再切换时，沿用最初保存的视角，退出后回到进楼前的位置
    const saved = this.interior?.saved || { target: this.controls.target.clone(), position: this.camera.position.clone(), zoom: this.camera.zoom }
    this.hideInterior(false) // 先拆旧的室内视图，不飞回
    hiddenBuilding.value = idx // 着色器里隐藏这一栋（见 buildings.js hideable）
    // 室内视图: 商场按楼的轮廓布置店铺 / 走廊，车库用车流的占用数据；angle 让布局顺着街区主方向
    this.interior = new Interior(b, kind, { rand: this.rand, angle: this.sceneData.angle || 0, garage: this.traffic?.garageInfo(id) })
    this.interior.saved = saved
    this.interior.buildingId = id
    this.world.add(this.interior.group)
    // 镜头推到这栋楼: 包围盒中心 + 对角线长度
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of b.polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
    const size = Math.hypot(maxX - minX, maxY - minY)
    // 缩放到对角线占视口高的 2/3，封顶 12 倍（小楼不要贴脸）
    this.#flyTo((minX + maxX) / 2, (minY + maxY) / 2, Math.min(12, (this.camera.top * 2) / (size * 1.5))) // 正交相机: 可见高度 = 视口高 / zoom
  }

  /** 退出室内视图，恢复楼体，可选飞回原视角 */
  hideInterior(restoreCamera = true) {
    if (!this.interior) return
    hiddenBuilding.value = -1 // 恢复楼体
    this.world?.remove(this.interior.group)
    this.interior.dispose()
    const s = this.interior.saved // 先取出保存的视角再置空
    this.interior = null
    if (restoreCamera && s) this.#flyTo(s.target.x, s.target.z, s.zoom)
  }

  /** 保持视角方向不变，平移到 (x,z) 并缩放，0.6 秒缓动 */
  #flyTo(x, z, zoom) {
    // 记下起止目标点、相机偏移（保持方向）和起止缩放；插值在 _tick 里逐帧做
    const t0 = this.controls.target.clone(), off = this.camera.position.clone().sub(t0)
    this.fly = { t: 0, from: t0, to: new THREE.Vector3(x, 0, z), off, z0: this.camera.zoom, z1: zoom }
  }

  /** n = 一天里高峰时刻的同时在场人数；实际人数 = n × 当前时刻的活跃度曲线 */
  setPopulation(n) {
    this._population = n
    this._envTimer = 0 // 下一帧立刻生效
  }

  /** 按仿真时钟刷新「环境」: 人数、车流强度、昼夜光照。每半秒一次就够了 */
  #applyEnvironment(dt) {
    this._envTimer -= dt
    if (this._envTimer > 0 || !this.crowd) return
    this._envTimer = 0.5 // 下次刷新在 0.5 现实秒后
    const { dayType, hour } = this.clock
    this.crowd.base = this._population ?? 600 // 默认高峰 600 人
    if (!this.demand) this.crowd.population = Math.round(this.crowd.base * activity('people', dayType, hour)) // 有需求模型时，应有人数由人群分组 + 活动算出
    this.traffic?.setDemand(activity('cars', dayType, hour)) // 车的日曲线和人的不同（早晚高峰更尖）

    // 昼夜: dl 0（深夜）~ 1（正午）。太阳和天光都留一点底，夜里楼的暗面和影子才看得见
    const dl = daylight(hour)
    this.sun.intensity = 0.15 + 1.95 * dl
    this.sun.color.set('#fff6ea').lerp(new THREE.Color('#ffb070'), THREE.MathUtils.clamp((0.45 - dl) / 0.35, 0, 1)) // 清晨黄昏偏暖: dl 低于 0.45 开始变橙，0.1 以下全橙
    this.hemi.intensity = 0.3 + 0.85 * dl
    this.lamps?.setNight(1 - dl) // 黄昏开灯，深夜最亮
    // 天空: 深夜的深蓝 #1b2333 → 白天配色里的背景色
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

  /**
   * 卫星底图平面。scene.imagery = { url（相对场景 json）, widthM, heightM }；map2scene 的坐标原点就在图中心，
   * 所以平面居中放。高度 1cm: 在路面（0）之上、车和人的脚下，程序生成的地面层隐藏后它就是地面。
   */
  #buildImagery(im) {
    const tex = new THREE.TextureLoader().load(new URL(im.url, new URL(this.baseUrl || '/', location.href)).href)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 8 // 斜着看的平面，各向异性过滤让远处不糊
    const geo = new THREE.PlaneGeometry(im.widthM, im.heightM)
    geo.rotateX(-Math.PI / 2) // 放平；贴图的上边（图的北）朝 −z，和场景的 y 向下一致
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }))
    mesh.position.y = 0.01
    mesh.receiveShadow = true // 楼的影子落在卫星图上，立体感更强
    mesh.name = 'imagery'
    return mesh
  }

  /** 打开 / 关闭卫星底图；场景没有底图返回 false */
  setImagery(v) {
    this._imageryOn = v
    if (!this.imagery) return false
    this.imagery.visible = v
    for (const name of ['roadSurface', 'pavement', 'areas', 'markings']) {
      const o = this.ground?.getObjectByName(name)
      if (o) o.visible = !v
    }
    return true
  }

  /** 当前场景有没有卫星底图 */
  get hasImagery() { return !!this.imagery }

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
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1 // 容器还没排版时给 1，避免 0 尺寸
    this.renderer.setSize(w, h)
    const aspect = w / h
    // 宽、高两个方向都要装得下地块，取更紧的那个；half 是 zoom=1 时的视口半高 (m)，宽按宽高比跟随
    const fit = this.fit || { w: 100, h: 100 } // 还没 load 时随便给个 100m
    const half = Math.max(fit.h, fit.w / aspect) / 2
    this.camera.left = -half * aspect
    this.camera.right = half * aspect
    this.camera.top = half
    this.camera.bottom = -half
    this.camera.updateProjectionMatrix()
  }

  /**
   * 每帧: 现实 dt（封顶 50ms，切标签页回来不会一下推进很多）→ 时钟换算成仿真秒 → 环境刷新 →
   * 子步推进红绿灯 / 人群 / 车流 / 轨道 → 热力 → 室内视图 → 键盘视角 → 镜头缓动 → 阴影范围 → 渲染
   */
  _tick() {
    this.raf = requestAnimationFrame(this._tick) // 先排下一帧，本帧抛异常也不会停循环
    const dt = Math.min(this.timer.getDelta(), 0.05) // 现实秒，封顶 50ms
    // 这一帧要推进多少仿真秒。物理按小步走（车 ≤0.25s、人 ≤0.5s 一步）才稳定；
    // 一帧最多 16 小步，倍速高到算不完时少推进一点，时钟自然就慢下来等物理
    const MAX_STEPS = 16, CAR_STEP = 0.25
    const simDt = this.clock.tick(Math.min(dt, (MAX_STEPS * CAR_STEP) / Math.max(1, this.clock.rate)))
    this.#applyEnvironment(dt)
    if (this.crowd && simDt > 0) {
      // 子步数按车的步长切；最后一步 last=true，各模块在这一步做「每帧一次」的工作（写 GPU 缓冲等）
      const n = Math.max(1, Math.ceil(simDt / CAR_STEP)), step = simDt / n
      let crowdDt = 0 // 人群攒到 0.5s 才走一步（人慢，步长可以大）
      for (let i = 0; i < n; i++) {
        this.signals?.update(step) // 红绿灯最先: 人和车这一小步都按新相位走
        crowdDt += step
        const last = i === n - 1
        if (crowdDt >= 0.5 || last) { this.crowd.update(crowdDt, last); crowdDt = 0 } // 最后一步无论攒了多少都走完
        if (this.crowd.ready) this.traffic?.update(step, last) // 人群铺好之前车不动，避免第一帧车从空街冲出
        this.transit?.update(step, last)
      }
      if (this.heat && this.heatVisible) this.heat.update(dt, this.crowd.heatSamples, this.crowd.heatCount) // 热力的时间平滑按现实时间，倍速再高也不闪
    }
    // 室内视图拿实时数据: 车库要占用数，商场要楼内人数
    if (this.interior) {
      const id = this.interior.buildingId
      this.interior.update(simDt, this.interior.kind === 'garage' ? this.traffic?.garageInfo(id) : this.crowd?.buildings.get(id)?.visitors)
    }
    this.#applyKeys(dt)
    // 镜头缓动（#flyTo 发起）: smoothstep 插值目标点和缩放，视角方向不变
    if (this.fly) {
      const f = this.fly
      f.t = Math.min(1, f.t + dt / 0.6) // 0.6 秒走完
      const k = f.t * f.t * (3 - 2 * f.t) // smoothstep: 起止都平滑
      this.controls.target.lerpVectors(f.from, f.to, k)
      this.camera.position.copy(this.controls.target).add(f.off)
      this.camera.zoom = f.z0 + (f.z1 - f.z0) * k
      this.camera.updateProjectionMatrix()
      if (f.t >= 1) this.fly = null
    }
    this.controls.update() // 阻尼惯性在这里推进
    if (this.world) this.#updateShadow() // 视角变了就跟一下阴影范围（有缓存，多数帧直接返回）
    this.renderer.render(this.scene, this.camera)
    this.frame++
  }

  /** 彻底销毁: 停帧循环、拆世界、释放渲染器并把 canvas 从 DOM 摘掉 */
  dispose() {
    cancelAnimationFrame(this.raf) // 停帧循环
    this.resizeObserver.disconnect()
    this.unload()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
