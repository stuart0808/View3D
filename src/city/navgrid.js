// 行人导航网格: 把「人行铺装 - 建筑 + 斑马线」栅格化，再对每个目的地算一张距离场。
// 行人沿距离场下降方向走，所以不需要逐人寻路，几千人也不费劲。

const UNREACHABLE = 65535
const UNIT = 0.1 // 距离场量化单位（米）

export const SURFACE = { NONE: 0, ROAD: 1, PAVE: 2, BUILDING: 3, GREEN: 4, WATER: 5, PARKING: 6, PARK: 7, PLAZA: 8 }
const WALKABLE_SURFACES = new Set([SURFACE.PAVE, SURFACE.PARKING, SURFACE.PARK, SURFACE.PLAZA])

export class NavGrid {
  constructor(scene, { cell = 1.0, maxCells = 200000 } = {}) {
    const b = scene.bounds
    const pad = 4
    this.minX = b.minX - pad
    this.minY = b.minY - pad
    const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2
    // 场景太大时自动放粗格子，控制内存
    this.cell = Math.max(cell, Math.sqrt((w * h) / maxCells))
    this.cols = Math.ceil(w / this.cell)
    this.rows = Math.ceil(h / this.cell)
    this.walkable = this.#rasterize(scene)
    this.penalty = this.#wallPenalty()
  }

  /**
   * 每类地表单独栅格化一遍再叠起来（一次画完的话抗锯齿边缘会串类）。
   * 结果: this.surface（地表类型）+ 返回 walkable。
   */
  #rasterize(scene) {
    const cv = document.createElement('canvas')
    cv.width = this.cols
    cv.height = this.rows
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    const s = 1 / this.cell
    const N = this.cols * this.rows

    const trace = (poly) => {
      ctx.moveTo(poly[0][0], poly[0][1])
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1])
      ctx.closePath()
    }
    const fillPolys = (list, stroke = 0) => {
      for (const p of list) {
        ctx.beginPath()
        trace(p.polygon)
        for (const h of p.holes || []) trace(h)
        ctx.fill('evenodd')
        if (stroke) { ctx.lineWidth = stroke; ctx.lineJoin = 'round'; ctx.stroke() }
      }
    }
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
      if (list.length) pass(() => fillPolys(list, kind === 'green' || kind === 'water' ? 0.6 : 0), (i) => (surface[i] = code))
    }
    pass(() => fillPolys(scene.buildings || [], 0.9), (i) => (surface[i] = SURFACE.BUILDING))

    const out = new Uint8Array(N)
    for (let i = 0; i < N; i++) out[i] = WALKABLE_SURFACES.has(surface[i]) ? 1 : 0
    // 斑马线: 逐格判断是否落在旋转矩形内，顺便记下是第几条（红绿灯要用）
    const cwIndex = (this.cwIndex = new Int16Array(N).fill(-1))
    ;(scene.crosswalks || []).forEach((c, id) => {
      const [tx, ty] = c.dir
      const r = Math.hypot(c.depth, c.span) / 2 + this.cell
      const i0 = Math.max(0, Math.floor((c.center[0] - r - this.minX) / this.cell)), i1 = Math.min(this.cols - 1, Math.ceil((c.center[0] + r - this.minX) / this.cell))
      const j0 = Math.max(0, Math.floor((c.center[1] - r - this.minY) / this.cell)), j1 = Math.min(this.rows - 1, Math.ceil((c.center[1] + r - this.minY) / this.cell))
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = this.minX + (i + 0.5) * this.cell - c.center[0], dy = this.minY + (j + 0.5) * this.cell - c.center[1]
          const along = dx * tx + dy * ty, across = -dx * ty + dy * tx
          if (Math.abs(along) > c.depth / 2 + 0.3 || Math.abs(across) > c.span / 2) continue
          const k = j * this.cols + i
          if (surface[k] === SURFACE.ROAD) { out[k] = 1; cwIndex[k] = id }
        }
      }
    })
    return out
  }

  surfaceAt(x, y) {
    const k = this.index(x, y)
    return k < 0 ? SURFACE.NONE : this.surface[k]
  }

  /** 贴墙的格子加代价，让路径自然走在通道中间而不是擦着墙 */
  #wallPenalty() {
    const { cols, rows, walkable } = this
    const dist = new Uint8Array(cols * rows).fill(255)
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

  index(x, y) {
    const i = Math.floor((x - this.minX) / this.cell), j = Math.floor((y - this.minY) / this.cell)
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1
    return j * this.cols + i
  }

  center(k) {
    return [this.minX + ((k % this.cols) + 0.5) * this.cell, this.minY + (Math.floor(k / this.cols) + 0.5) * this.cell]
  }

  isWalkable(x, y) {
    const k = this.index(x, y)
    return k >= 0 && this.walkable[k] === 1
  }

  /** 螺旋向外找最近的可行走格 */
  nearestWalkable(x, y, maxRadius = 20) {
    const i0 = Math.floor((x - this.minX) / this.cell), j0 = Math.floor((y - this.minY) / this.cell)
    const rMax = Math.ceil(maxRadius / this.cell)
    for (let r = 0; r <= rMax; r++) {
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

  /** 从目标格出发的 Dijkstra 距离场（Uint16，单位 0.1m） */
  buildField(targetIndex) {
    const { cols, rows, walkable, penalty, cell } = this
    const N = cols * rows
    const dist = new Float64Array(N).fill(Infinity) // 必须 64 位: 堆里的键是 double，32 位舍入后会把有效条目误判成过期
    const heapK = [], heapV = []
    const push = (key, v) => {
      let i = heapK.length
      heapK.push(key); heapV.push(v)
      while (i > 0) {
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
      if (n > 0) {
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

    dist[targetIndex] = 0
    push(0, targetIndex)
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1]
    while (heapK.length) {
      const dTop = heapK[0]
      const k = pop()
      if (dTop > dist[k]) continue
      const ci = k % cols, cj = (k / cols) | 0
      for (let n = 0; n < 8; n++) {
        const ni = ci + DX[n], nj = cj + DY[n]
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue
        const nk = nj * cols + ni
        if (!walkable[nk]) continue
        // 斜走不许穿墙角
        if (n >= 4 && (!walkable[cj * cols + ni] || !walkable[nj * cols + ci])) continue
        const nd = dTop + (n < 4 ? cell : cell * 1.4142) * (1 + penalty[nk])
        if (nd < dist[nk]) { dist[nk] = nd; push(nd, nk) }
      }
    }
    const out = new Uint16Array(N)
    for (let k = 0; k < N; k++) out[k] = dist[k] === Infinity ? UNREACHABLE : Math.min(UNREACHABLE - 1, Math.round(dist[k] / UNIT))
    return out
  }

  /** 从 (x,y) 沿距离场往下走 steps 格，返回前方引导点；不可达返回 null */
  lookAhead(field, x, y, steps, out) {
    let k = this.index(x, y)
    if (k < 0) return null
    const { cols, rows } = this
    if (field[k] === UNREACHABLE) {
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
            if (di !== 0 && dj !== 0 && (field[cj * cols + ni] === UNREACHABLE || field[nj * cols + ci] === UNREACHABLE)) continue
            bestD = field[nk]; best = nk
          }
        }
      }
      if (best === k) break
      k = best
    }
    out[0] = this.minX + ((k % cols) + 0.5) * this.cell
    out[1] = this.minY + (((k / cols) | 0) + 0.5) * this.cell
    out[2] = field[k] * UNIT
    return out
  }

  distanceAt(field, x, y) {
    const k = this.index(x, y)
    return k < 0 || field[k] === UNREACHABLE ? Infinity : field[k] * UNIT
  }
}

export { UNREACHABLE }
