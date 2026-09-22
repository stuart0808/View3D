// 行人导航网格。
//
// 思路: 把「人能走的地方」栅格化成 1m 左右的格子，然后对每个目的地（一栋楼的所有门、一个出入口、一个歇脚点）
// 算一张「到它的步行距离」的场（Dijkstra）。行人每帧只要看脚下周围 3x3 格谁的距离最小，往那边走就行 ——
// 不用逐人寻路，几千人也不费劲；代价是每个目的地一张 Uint16 的场（城区核心区约 20 万格 = 400KB）。
//
// 两层数据:
//   surface  每格的地表类型（SURFACE.*），别的模块也用它: 路灯避开建筑、车看行人是否在车行道上、店面判断哪面临街
//   walkable 0/1，由 surface 推出来: 人行铺装 / 停车场 / 公园 / 广场可走，再加上斑马线所在的那些车行道格子
//
// 坐标: 网格覆盖 scene.activeRegion（没有就是整个场景）外扩 4m；index(x,y) 把米换成格号，center(k) 反过来。
//
// 典型用法（crowd.js）:
//   const nav = new NavGrid(scene)                       // 一次性栅格化
//   const cell = nav.nearestWalkable(door.x, door.y, 8)  // 门口落到人行道上
//   const field = nav.buildField([cell, cell2, ...])     // 这栋楼所有门共用一张场（预热时分帧算）
//   nav.lookAhead(field, x, y, 5, out)                   // 每帧: 行人朝 out 走
//
// 性能: 核心区 890x670m 约 20 万格，一张场 Dijkstra 约 15ms（8 邻域 + 堆），城区 127 张场分帧预热约 5s。
// 内存: surface + walkable + penalty + cwIndex 约 2MB；每张场 400KB。

const UNREACHABLE = 65535 // 距离场里「到不了」的标记（Uint16 的最大值）
const UNIT = 0.1 // 距离场的量化单位（米）: Uint16 最多表示 6553m，够核心区用

export const SURFACE = { NONE: 0, ROAD: 1, PAVE: 2, BUILDING: 3, GREEN: 4, WATER: 5, PARKING: 6, PARK: 7, PLAZA: 8 }
const WALKABLE_SURFACES = new Set([SURFACE.PAVE, SURFACE.PARKING, SURFACE.PARK, SURFACE.PLAZA])

export class NavGrid {
  /**
   * @param scene    scene.json
   * @param cell     目标格宽（米）；格数超过 maxCells 时会自动放粗
   * @param maxCells 格数上限，控制内存和距离场的计算时间
   * @param surface  【测试用】直接给定地表数组（Uint8Array，长度 = cols*rows），跳过 canvas 栅格化；
   *                 同时要给 cols / rows。浏览器外没有 canvas，单元测试靠它构造小网格
   */
  constructor(scene, { cell = 1.0, maxCells = 200000, surface = null, cols = 0, rows = 0 } = {}) {
    // 城区级的场景只在核心区（activeRegion）里逐人仿真，导航网格也只铺这一块；没有就铺满全场景。
    // 外扩 4m 是为了让核心区边界上的出入口、斑马线也落在网格里，行人走到边界不会突然「掉出去」
    const b = scene.activeRegion || scene.bounds
    const pad = 4
    this.minX = b.minX - pad
    this.minY = b.minY - pad
    if (surface) {
      // 测试入口: 网格尺寸由调用方给定
      this.cell = cell
      this.cols = cols
      this.rows = rows
      this.surface = surface
      this.walkable = this.#walkableFromSurface(scene)
    } else {
      const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2
      // 场景太大时自动放粗格子，控制内存
      this.cell = Math.max(cell, Math.sqrt((w * h) / maxCells))
      this.cols = Math.ceil(w / this.cell)
      this.rows = Math.ceil(h / this.cell)
      this.walkable = this.#rasterize(scene)
    }
    this.penalty = this.#wallPenalty()
  }

  /**
   * 栅格化: 每类地表单独画一遍再叠起来（一次画完的话抗锯齿边缘会串类），后画的盖住先画的:
   * 地块（=车行道底色）→ 人行铺装 → 广场 / 公园 / 停车场 / 水 / 绿化 → 建筑。
   * 返回 walkable；同时填好 this.surface。
   */
  #rasterize(scene) {
    const cv = document.createElement('canvas')
    cv.width = this.cols
    cv.height = this.rows
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    const s = 1 / this.cell // 米 → 格
    const N = this.cols * this.rows

    const trace = (poly) => {
      ctx.moveTo(poly[0][0], poly[0][1])
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1])
      ctx.closePath()
    }
    // 画一组带洞的多边形；stroke > 0 时再描一圈边，让边缘的格子也算进去（建筑要「胖」一点，人不能贴墙穿过）
    const fillPolys = (list, stroke = 0) => {
      for (const p of list) {
        ctx.beginPath()
        trace(p.polygon)
        for (const h of p.holes || []) trace(h)
        ctx.fill('evenodd')
        if (stroke) { ctx.lineWidth = stroke; ctx.lineJoin = 'round'; ctx.stroke() }
      }
    }
    // 一遍: 清黑 → 用米坐标画白 → 读回来，白格子调用 apply。
    // 用 canvas 而不是自己写扫描线，是因为它免费处理了带洞多边形（evenodd）和描边；
    // 代价是每遍要 getImageData 一次，7 遍加起来在城区上约 100ms，可接受
    const pass = (draw, apply) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.setTransform(s, 0, 0, s, -this.minX * s, -this.minY * s)
      ctx.fillStyle = ctx.strokeStyle = '#fff'
      draw()
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data
      for (let i = 0; i < N; i++) if (data[i * 4] > 127) apply(i)
    }

    const surface = (this.surface = new Uint8Array(N))
    const areas = scene.areas || []
    pass(() => fillPolys(scene.site || []), (i) => (surface[i] = SURFACE.ROAD))
    pass(() => fillPolys(scene.pavement || []), (i) => (surface[i] = SURFACE.PAVE))
    for (const [kind, code] of [['plaza', SURFACE.PLAZA], ['park', SURFACE.PARK], ['parking', SURFACE.PARKING], ['water', SURFACE.WATER], ['green', SURFACE.GREEN]]) {
      const list = areas.filter((a) => a.kind === kind)
      // 绿化和水体描一圈边: 它们是「不能走」的，边缘宁可多占一点
      if (list.length) pass(() => fillPolys(list, kind === 'green' || kind === 'water' ? 0.6 : 0), (i) => (surface[i] = code))
    }
    pass(() => fillPolys(scene.buildings || [], 0.9), (i) => (surface[i] = SURFACE.BUILDING))
    return this.#walkableFromSurface(scene)
  }

  /**
   * surface → walkable，再把斑马线所在的车行道格子放开（并记下每格属于哪条斑马线，红绿灯要用）。
   * 车行道整体不可走，人只能从斑马线过马路 —— 这就是为什么路口会自然形成等灯的人群。
   * 路段中间没有斑马线的地方，人绕远也不会横穿。
   */
  #walkableFromSurface(scene) {
    const { surface, cols, rows } = this
    const N = cols * rows
    const out = new Uint8Array(N)
    for (let i = 0; i < N; i++) out[i] = WALKABLE_SURFACES.has(surface[i]) ? 1 : 0
    // 斑马线: 逐格判断是否落在旋转矩形内（斑马线有方向），顺便记下是第几条
    const cwIndex = (this.cwIndex = new Int16Array(N).fill(-1))
    ;(scene.crosswalks || []).forEach((c, id) => {
      const [tx, ty] = c.dir
      // 只扫斑马线包围圆内的格子
      const r = Math.hypot(c.depth, c.span) / 2 + this.cell
      const i0 = Math.max(0, Math.floor((c.center[0] - r - this.minX) / this.cell)), i1 = Math.min(cols - 1, Math.ceil((c.center[0] + r - this.minX) / this.cell))
      const j0 = Math.max(0, Math.floor((c.center[1] - r - this.minY) / this.cell)), j1 = Math.min(rows - 1, Math.ceil((c.center[1] + r - this.minY) / this.cell))
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          // 格中心相对斑马线中心，投影到「沿路方向 / 横跨方向」
          const dx = this.minX + (i + 0.5) * this.cell - c.center[0], dy = this.minY + (j + 0.5) * this.cell - c.center[1]
          const along = dx * tx + dy * ty, across = -dx * ty + dy * tx
          if (Math.abs(along) > c.depth / 2 + 0.3 || Math.abs(across) > c.span / 2) continue
          const k = j * cols + i
          if (surface[k] === SURFACE.ROAD) { out[k] = 1; cwIndex[k] = id }
        }
      }
    })
    return out
  }

  /** (x,y) 处的地表类型；网格外返回 NONE */
  surfaceAt(x, y) {
    const k = this.index(x, y)
    return k < 0 ? SURFACE.NONE : this.surface[k]
  }

  /**
   * 贴墙的格子加通行代价，让距离场的「下坡方向」自然走在通道中间而不是擦着墙。
   * 做法: 从所有可走格的边缘（四邻里有不可走的）出发做 3 层 BFS，离边缘 0/1/2/3 格分别加 160%/70%/25%/8% 的代价。
   * 只影响「路径选哪条」，不影响可达性: 贴墙的格子仍然可走，只是不划算。
   * 副作用: crowd.js 预热铺人时会避开 penalty ≥ 1 的格子，免得开场就有人站在墙缝里。
   */
  #wallPenalty() {
    const { cols, rows, walkable } = this
    const dist = new Uint8Array(cols * rows).fill(255) // 到最近墙的格数，255 = 远
    let frontier = []
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i
        if (!walkable[k]) continue
        const edge = i === 0 || j === 0 || i === cols - 1 || j === rows - 1 ||
          !walkable[k - 1] || !walkable[k + 1] || !walkable[k - cols] || !walkable[k + cols]
        if (edge) { dist[k] = 0; frontier.push(k) }
      }
    }
    for (let d = 1; d <= 3 && frontier.length; d++) {
      const next = []
      for (const k of frontier) {
        for (const n of [k - 1, k + 1, k - cols, k + cols]) {
          if (n >= 0 && n < dist.length && walkable[n] && dist[n] === 255) { dist[n] = d; next.push(n) }
        }
      }
      frontier = next
    }
    const table = [1.6, 0.7, 0.25, 0.08]
    const pen = new Float32Array(cols * rows)
    for (let k = 0; k < pen.length; k++) pen[k] = dist[k] < 4 ? table[dist[k]] : 0
    return pen
  }

  /** 米坐标 → 格号（行优先: j * cols + i）；网格外返回 -1。每帧每人调用几次，保持它无分配 */
  index(x, y) {
    const i = Math.floor((x - this.minX) / this.cell), j = Math.floor((y - this.minY) / this.cell)
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1
    return j * this.cols + i
  }

  /** 格号 → 格中心的米坐标 */
  center(k) {
    return [this.minX + ((k % this.cols) + 0.5) * this.cell, this.minY + (Math.floor(k / this.cols) + 0.5) * this.cell]
  }

  /** (x,y) 在不在导航网格覆盖的范围里 */
  contains(x, y) { return this.index(x, y) >= 0 }

  isWalkable(x, y) {
    const k = this.index(x, y)
    return k >= 0 && this.walkable[k] === 1
  }

  /**
   * 从 (x,y) 起一圈圈向外找最近的可走格（半径 maxRadius 米内），找不到返回 -1。
   * 门、出入口、车站出入口都用它落到人行道上；行人被挤进不可走格时也用它「解套」。
   * 复杂度 O(r²)，r 通常只有几格；maxRadius 别给太大
   */
  nearestWalkable(x, y, maxRadius = 20) {
    const i0 = Math.floor((x - this.minX) / this.cell), j0 = Math.floor((y - this.minY) / this.cell)
    const rMax = Math.ceil(maxRadius / this.cell)
    for (let r = 0; r <= rMax; r++) {
      // 第 r 圈: 切比雪夫距离正好等于 r 的那些格；同一圈里再按欧氏距离挑最近的
      let best = -1, bestD = Infinity
      for (let j = j0 - r; j <= j0 + r; j++) {
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue
          if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue
          const k = j * this.cols + i
          if (!this.walkable[k]) continue
          const d = (i - i0) ** 2 + (j - j0) ** 2
          if (d < bestD) { bestD = d; best = k }
        }
      }
      if (best >= 0) return best
    }
    return -1
  }

  /**
   * 从目标格（可以是多个: 一栋楼的所有门）出发的 Dijkstra 距离场。
   * 返回 Uint16Array，单位 0.1m，UNREACHABLE 表示到不了。8 邻域，斜走代价 √2，斜走不许穿墙角，贴墙有额外代价。
   * 用二叉堆手写（不引第三方库），键必须用 double 存: 距离是 double，用 Float32 存会把有效条目误判成过期。
   * （这是个真踩过的坑: Float32 舍入后 dist[k] 比堆里的键略小，`dTop > dist[k]` 把正常条目当过期扔掉，
   *   结果大片区域算成不可达，行人全部消失。）
   * 一次 Dijkstra 覆盖整张网格，所以「从任何地方到这个目标」的距离都有了 —— 这就是能省掉逐人寻路的原因。
   */
  buildField(targets) {
    const { cols, rows, walkable, penalty, cell } = this
    const N = cols * rows
    const dist = new Float64Array(N).fill(Infinity)
    // 最小堆: heapK 是键（距离），heapV 是格号
    const heapK = [], heapV = []
    const push = (key, v) => {
      let i = heapK.length
      heapK.push(key); heapV.push(v)
      while (i > 0) { // 上浮
        const p = (i - 1) >> 1
        if (heapK[p] <= key) break
        heapK[i] = heapK[p]; heapV[i] = heapV[p]
        i = p
      }
      heapK[i] = key; heapV[i] = v
    }
    const pop = () => {
      const top = heapV[0]
      const key = heapK.pop(), v = heapV.pop()
      const n = heapK.length
      if (n > 0) { // 把最后一个放到堆顶再下沉
        let i = 0
        for (;;) {
          let c = 2 * i + 1
          if (c >= n) break
          if (c + 1 < n && heapK[c + 1] < heapK[c]) c++
          if (heapK[c] >= key) break
          heapK[i] = heapK[c]; heapV[i] = heapV[c]
          i = c
        }
        heapK[i] = key; heapV[i] = v
      }
      return top
    }

    for (const t of Array.isArray(targets) ? targets : [targets]) { dist[t] = 0; push(0, t) }
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1] // 前 4 个是正交邻居，后 4 个是斜邻居
    while (heapK.length) {
      const dTop = heapK[0]
      const k = pop()
      if (dTop > dist[k]) continue // 过期条目（同一格后来又以更短距离入堆过）
      const ci = k % cols, cj = (k / cols) | 0
      for (let n = 0; n < 8; n++) {
        const ni = ci + DX[n], nj = cj + DY[n]
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue
        const nk = nj * cols + ni
        if (!walkable[nk]) continue
        // 斜走不许穿墙角: 两个正交邻居都得可走
        if (n >= 4 && (!walkable[cj * cols + ni] || !walkable[nj * cols + ci])) continue
        const nd = dTop + (n < 4 ? cell : cell * 1.4142) * (1 + penalty[nk])
        if (nd < dist[nk]) { dist[nk] = nd; push(nd, nk) }
      }
    }
    // 量化成 Uint16 省内存
    const out = new Uint16Array(N)
    for (let k = 0; k < N; k++) out[k] = dist[k] === Infinity ? UNREACHABLE : Math.min(UNREACHABLE - 1, Math.round(dist[k] / UNIT))
    return out
  }

  /**
   * 从 (x,y) 沿距离场「下坡」走 steps 格，把前方那个格的中心和剩余距离写进 out = [x, y, dist]。
   * 行人朝这个引导点走，steps 越大转弯越提前、路径越平滑。不可达返回 null。
   * out 由调用方复用（每帧几千次调用，不能每次分配数组）。
   * 只看 3x3 邻域是够的: 距离场是单调的，局部最小值只在目标格。
   */
  lookAhead(field, x, y, steps, out) {
    let k = this.index(x, y)
    if (k < 0) return null
    const { cols, rows } = this
    if (field[k] === UNREACHABLE) {
      // 人被挤到了不可走的格子上（分离力推的）: 就近找一格可走的重新出发
      k = this.nearestWalkable(x, y, 4)
      if (k < 0 || field[k] === UNREACHABLE) return null
    }
    for (let s = 0; s < steps; s++) {
      const ci = k % cols, cj = (k / cols) | 0
      let best = k, bestD = field[k]
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = ci + di, nj = cj + dj
          if ((di === 0 && dj === 0) || ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue
          const nk = nj * cols + ni
          if (field[nk] < bestD) {
            // 和 buildField 一样，斜向不穿墙角
            if (di !== 0 && dj !== 0 && (field[cj * cols + ni] === UNREACHABLE || field[nj * cols + ci] === UNREACHABLE)) continue
            bestD = field[nk]; best = nk
          }
        }
      }
      if (best === k) break // 已经是局部最低（到目标了）
      k = best
    }
    out[0] = this.minX + ((k % cols) + 0.5) * this.cell
    out[1] = this.minY + (((k / cols) | 0) + 0.5) * this.cell
    out[2] = field[k] * UNIT
    return out
  }

  /** (x,y) 处到目标的步行距离（米），到不了返回 Infinity */
  distanceAt(field, x, y) {
    const k = this.index(x, y)
    return k < 0 || field[k] === UNREACHABLE ? Infinity : field[k] * UNIT
  }
}

export { UNREACHABLE }
