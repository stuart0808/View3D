// 与框架无关的渲染引擎: 吃一份 scene.json，生成整个三维街区并驱动人群。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { NavGrid } from './navgrid.js'
import { buildGround, buildBackdrop } from './ground.js'
import { buildBuildings, hiddenBuilding } from './buildings.js'
import { Interior } from './interior.js'
import { Crowd } from './crowd.js'
import { HeatLayer } from './heat.js'
import { Traffic } from './traffic.js'
import { Signals } from './signals.js'
import { CURB_H } from './ground.js'
import { buildTrees } from './props.js'
import { makeRandom } from './geometry.js'

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
  park: '#bcd0b1',
  plaza: '#ddd6cb',
  water: '#8fbcdc',
  parking: '#6d727a',
}

export class CityEngine {
  constructor(container, options = {}) {
    this.container = container
    this.options = { seed: 7, peopleScale: 1.5, timeScale: 2, capacity: 4000, ...options }
    this.style = { ...DEFAULT_STYLE, ...(options.style || {}) }
    this.timeScale = this.options.timeScale
    this.heatVisible = true

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.setClearColor(this.style.background)
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(78)
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(5)
    this.controls.screenSpacePanning = false

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xaab4c2, 1.15))
    this.sun = new THREE.DirectionalLight(0xfff6ea, 2.1)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096)
    this.sun.shadow.radius = 5
    this.sun.shadow.blurSamples = 16
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.35
    this.scene.add(this.sun, this.sun.target)

    this.world = null
    this.interior = null
    this.onSelect = options.onSelect || null
    this.#bindPicking()
    this.clock = new THREE.Clock()
    this.frame = 0
    this._tick = this._tick.bind(this)
    this._resize = this._resize.bind(this)
    this.resizeObserver = new ResizeObserver(this._resize)
    this.resizeObserver.observe(container)
    this._resize()
    this.raf = requestAnimationFrame(this._tick)
  }

  async loadUrl(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`加载场景失败: ${url} (${res.status})`)
    this.load(await res.json())
  }

  load(sceneData) {
    this.unload()
    const rand = makeRandom(this.options.seed)
    this.sceneData = sceneData
    const world = new THREE.Group()
    this.nav = new NavGrid(sceneData, { cell: 1.0 })
    this.signals = this.options.signals !== false ? new Signals(sceneData, rand) : null
    // 车流要先建: 停车位线是它排的，地面标线要用
    if (this.options.traffic !== false) this.traffic = new Traffic(sceneData, this.nav, rand, { signals: this.signals })
    world.add(buildGround(sceneData, this.style, this.traffic?.parkingLines || []))
    world.add(buildBackdrop(sceneData, this.style, rand))
    const { group, heatGeometry } = buildBuildings(sceneData, this.nav, rand, this.style)
    world.add(group)
    this.buildingsGroup = group
    this.rand = rand

    this.crowd = new Crowd(sceneData, this.nav, rand, { capacity: this.options.capacity, peopleScale: this.options.peopleScale, signals: this.signals })
    this.crowd.population = this._population ?? 600
    this.crowd.dwellScale = this._dwellScale ?? 1
    world.add(this.crowd.mesh)

    if (this.options.trees !== false) world.add(buildTrees(sceneData, this.nav, rand))
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
    this.world = this.heat = this.crowd = this.nav = this.traffic = this.signals = null
  }

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

    // 太阳从左后方打过来，影子落向右前；阴影相机刚好包住地块
    this.sun.target.position.set(cx, 0, cz)
    this.sun.position.set(cx - radius * 0.9, radius * 1.5, cz + radius * 0.35)
    const sc = this.sun.shadow.camera
    sc.left = sc.bottom = -radius * 1.15
    sc.right = sc.top = radius * 1.15
    sc.near = 1
    sc.far = radius * 4
    sc.updateProjectionMatrix()
    this.sun.shadow.needsUpdate = true
  }

  // -------------------------------------------------------------------------
  // 点选建筑 / 室内视图
  // -------------------------------------------------------------------------
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
    if (b.kind !== 'block') views.push('mall')
    if (garage) views.push('garage')
    return { id, kind: b.kind, floors: b.floors, views, visitors: this.crowd?.buildings.get(id)?.visitors ?? 0, garage: garage && { capacity: garage.capacity, occupied: garage.occupied } }
  }

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

  setPopulation(n) {
    this._population = n
    if (this.crowd) this.crowd.population = n
  }

  setDwellScale(s) {
    this._dwellScale = s
    if (this.crowd) this.crowd.dwellScale = s
  }

  setAttraction(map) { this.crowd?.setAttraction(map) }

  setHeatVisible(v) {
    this.heatVisible = v
    if (this.heat) this.heat.mesh.visible = v
  }

  setTimeScale(s) { this.timeScale = s }

  stats() { return this.crowd ? this.crowd.stats() : null }

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
    const dt = Math.min(this.clock.getDelta(), 0.05)
    if (this.crowd) {
      const simDt = dt * this.timeScale
      this.signals?.update(simDt)
      this.crowd.update(simDt)
      if (this.crowd.ready) this.traffic?.update(simDt)
      if (this.heat && this.heatVisible) this.heat.update(simDt, this.crowd.heatSamples, this.crowd.heatCount)
    }
    if (this.interior) {
      const id = this.interior.buildingId
      this.interior.update(dt * this.timeScale, this.interior.kind === 'garage' ? this.traffic?.garageInfo(id) : this.crowd?.buildings.get(id)?.visitors)
    }
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
