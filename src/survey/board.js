// 实地标注「涂色板」的纯逻辑（不碰 DOM，vitest 直接测）:
//   画板      场景范围切成 1 米 × 1 米的格子，每格存一个颜色号（0 = 空白，1~15 = 调色板颜色）
//   商户      相邻（上下左右）而且同色的一片格子 = 一家商户；换色、擦掉、连起来都会改变商户的划分
//   门口      门在格点（格子的角）上，必须在这家商户色块的边缘上，并且有朝向（东 / 南 / 西 / 北，朝色块外面）
//   划区工具  画笔、矩形、多边形、油漆桶的「选中哪些格子」都在这里算，页面只负责把手势换成格子坐标
//   编号延续  每次改完重新找连通块，按「和改之前重叠最多」把旧商户的编号、店名、门口接到新色块上
//   轮廓      色块的外轮廓（和洞）追成折线，导出 GeoJSON 用
//   分块同步  画板按 50 米一块（和考察分工的网格 A01、B07 对齐）压成游程编码，同步时按块取较新的
// 坐标约定和 scene.json 一致: 单位米，x 向东、y 向南。格子 (c, r) 占 [x0 + c, x0 + c + 1] × [y0 + r, y0 + r + 1]，
// 格点 (i, j) 在 (x0 + i, y0 + j)，所以格子 (c, r) 的左上角是格点 (c, r)。
import { cellId } from './model.js' // 50 米分块的编号沿用考察网格的 A01 写法

/** 分块边长（格子数 = 米）；和 SurveyApp 的考察网格一样大，一块就是一个人负责的一格 */
export const TILE = 50

/** 门的四个朝向 → 单位向量（y 向南，所以南是 +y） */
export const DIRS = { E: [1, 0], S: [0, 1], W: [-1, 0], N: [0, -1] }
/** 朝向的轮换顺序（点已有的门时按这个顺序转到下一个合法朝向） */
export const DIR_ORDER = ['E', 'S', 'W', 'N']
/** 朝向的中文名，面板里显示 */
export const DIR_NAME = { E: '东', S: '南', W: '西', N: '北' }

/**
 * 调色板: 下标就是存在画板里的颜色号，0 是空白（不画）
 * 15 种颜色两两差别大，手机太阳底下也分得清；相邻两家店用不同颜色才不会连成一家
 */
export const PALETTE = [
  null, // 0: 空白
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', // 红 绿 蓝 橙 紫
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', // 青 品红 黄绿 粉 墨绿
  '#dcbeff', '#9a6324', '#fffac8', '#800000', '#000075', // 淡紫 棕 米 栗 藏青
]

// ---------------------------------------------------------------------------
// 画板与坐标
// ---------------------------------------------------------------------------

/**
 * 按场景范围建一块空白画板；原点取整到米，格子边界落在整数米上（换算、导出都干净）
 * @param bounds scene.bounds: {minX, minY, maxX, maxY}（米）
 * @returns {{x0, y0, w, h, data: Uint8Array}} data[r * w + c] = 格子 (c, r) 的颜色号
 */
export function makeBoard(bounds) {
  const x0 = Math.floor(bounds.minX), y0 = Math.floor(bounds.minY) // 左上角向下取整
  const w = Math.max(1, Math.ceil(bounds.maxX - x0)), h = Math.max(1, Math.ceil(bounds.maxY - y0)) // 宽高向上取整，场景全部装得下
  return { x0, y0, w, h, data: new Uint8Array(w * h) } // 一格一个字节，2 公里见方的场景也只有几兆
}

/** 场景坐标 (x, y) 落在哪一格 → [c, r]；画板外返回 null */
export function cellAt(b, x, y) {
  const c = Math.floor(x - b.x0), r = Math.floor(y - b.y0) // 一格一米，直接取整
  if (c < 0 || r < 0 || c >= b.w || r >= b.h) return null // 画板外
  return [c, r]
}

/** 离 (x, y) 最近的格点 → [i, j]（截到画板范围里，格点比格子多一行一列） */
export function vertexNear(b, x, y) {
  const i = Math.min(b.w, Math.max(0, Math.round(x - b.x0))) // 四舍五入到最近的整数米
  const j = Math.min(b.h, Math.max(0, Math.round(y - b.y0)))
  return [i, j]
}

/** 格点 (i, j) 的场景坐标 */
export function vertexPos(b, i, j) {
  return [b.x0 + i, b.y0 + j]
}

/** 格子 (c, r) 的颜色号；画板外当空白 */
export function get(b, c, r) {
  if (c < 0 || r < 0 || c >= b.w || r >= b.h) return 0 // 出界 = 空白，边上的色块照样有「外面」
  return b.data[r * b.w + c]
}

// ---------------------------------------------------------------------------
// 划区: 各种工具选中的格子（返回格子下标数组 r * w + c，已去掉出界的）
// ---------------------------------------------------------------------------

/** 以 (c, r) 为中心、边长 size 的方形笔刷；偶数边长时往左上偏半格 */
export function brushCells(b, c, r, size = 1) {
  const out = [] // 选中的格子下标
  const c0 = c - Math.floor(size / 2), r0 = r - Math.floor(size / 2) // 笔刷左上角
  for (let rr = Math.max(0, r0); rr < Math.min(b.h, r0 + size); rr++) {
    for (let cc = Math.max(0, c0); cc < Math.min(b.w, c0 + size); cc++) out.push(rr * b.w + cc) // 截掉出界部分
  }
  return out
}

/**
 * 从 (c0, r0) 到 (c1, r1) 的一笔（Bresenham 直线，每一步盖一个笔刷）
 * 手指移动快时两次 pointermove 之间会跳好几格，连成线才不会断
 */
export function lineCells(b, c0, r0, c1, r1, size = 1) {
  const seen = new Set() // 笔刷互相重叠，去重
  const dc = Math.abs(c1 - c0), dr = -Math.abs(r1 - r0) // 标准 Bresenham 的两个增量（dr 取负）
  const sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1 // 每一步往哪边走
  let err = dc + dr, c = c0, r = r0 // 误差项和当前点
  for (;;) {
    for (const k of brushCells(b, c, r, size)) seen.add(k) // 当前点盖一笔
    if (c === c1 && r === r1) break // 到终点
    const e2 = 2 * err // 决定这一步走 x、走 y 还是都走
    if (e2 >= dr) { err += dr; c += sc }
    if (e2 <= dc) { err += dc; r += sr }
  }
  return [...seen]
}

/** 两个角格子围成的矩形（两角顺序随意，含边界） */
export function rectCells(b, c0, r0, c1, r1) {
  const out = [] // 选中的格子下标
  const ca = Math.max(0, Math.min(c0, c1)), cb = Math.min(b.w - 1, Math.max(c0, c1)) // 列范围，截到画板里
  const ra = Math.max(0, Math.min(r0, r1)), rb = Math.min(b.h - 1, Math.max(r0, r1)) // 行范围
  for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) out.push(r * b.w + c)
  return out
}

/** 射线法: 点在不在多边形里（poly = [[x, y], ...] 场景米，首尾不重复） */
export function inPoly(poly, x, y) {
  let hit = false // 穿过次数的奇偶
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j] // 当前边
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit // 跨过水平线且交点在右边
  }
  return hit
}

/**
 * 多边形（场景米）盖住的格子: 格子中心在多边形里就算
 * 用来做「多边形划区」和「按楼的轮廓填」；holes 里的格子不算（楼有天井时）
 */
export function polygonCells(b, poly, holes = []) {
  if (!poly || poly.length < 3) return [] // 不成形
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity // 外包框，只扫框里的格子
  for (const [x, y] of poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  const out = [] // 选中的格子下标
  const c0 = Math.max(0, Math.floor(minX - b.x0)), c1 = Math.min(b.w - 1, Math.floor(maxX - b.x0)) // 外包框换成列范围
  const r0 = Math.max(0, Math.floor(minY - b.y0)), r1 = Math.min(b.h - 1, Math.floor(maxY - b.y0)) // 行范围
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = b.x0 + c + 0.5, y = b.y0 + r + 0.5 // 格子中心
      if (inPoly(poly, x, y) && !holes.some((h) => inPoly(h, x, y))) out.push(r * b.w + c)
    }
  }
  return out
}

/**
 * 油漆桶: 从 (c, r) 出发，上下左右连通、颜色相同的一片格子
 * @param opts.within 可选，(c, r) → bool；返回 false 的格子当墙（例如只在这栋楼的轮廓里填）
 * @param opts.limit  最多这么多格；超过返回 null（在大片空地上误点，别一下子涂满整个场景）
 */
export function floodCells(b, c, r, { within = null, limit = Infinity } = {}) {
  if (c < 0 || r < 0 || c >= b.w || r >= b.h) return [] // 点在画板外
  const v = b.data[r * b.w + c] // 要填的这一片的颜色
  const seen = new Uint8Array(b.w * b.h) // 访问标记
  const out = [], stack = [r * b.w + c] // 结果和待访问栈
  seen[stack[0]] = 1
  while (stack.length) {
    const k = stack.pop() // 当前格
    out.push(k)
    if (out.length > limit) return null // 太大了，放弃
    const cc = k % b.w, rr = (k - cc) / b.w // 下标拆回行列
    for (const [nc, nr] of [[cc + 1, rr], [cc - 1, rr], [cc, rr + 1], [cc, rr - 1]]) {
      if (nc < 0 || nr < 0 || nc >= b.w || nr >= b.h) continue // 出界
      const nk = nr * b.w + nc // 邻格下标
      if (seen[nk] || b.data[nk] !== v || (within && !within(nc, nr))) continue // 访问过 / 颜色不同 / 在范围外
      seen[nk] = 1
      stack.push(nk)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 涂色与撤销: 一次操作（一笔、一个矩形……）记成一条「改动」，撤销 / 重做就是把格子改回去 / 改过来
// ---------------------------------------------------------------------------

/** 开始一次操作；old 记每个被改过的格子「这次操作之前」的颜色（同一笔里重复涂同一格只记第一次） */
export function beginEdit() {
  return { old: new Map() } // 格子下标 → 原来的颜色号
}

/** 把一批格子涂成 v（0 = 擦掉），记进 edit；返回实际变了几格 */
export function paint(b, edit, cells, v) {
  let n = 0 // 实际改变的格数
  for (const k of cells) {
    if (b.data[k] === v) continue // 本来就是这个颜色
    if (!edit.old.has(k)) edit.old.set(k, b.data[k]) // 第一次改这格才记原色
    b.data[k] = v
    n++
  }
  return n
}

/**
 * 结束一次操作: 算出每格「之后」的颜色，丢掉涂了又涂回原色的格子
 * @returns {{idx: Int32Array, before: Uint8Array, after: Uint8Array}}，没有实际变化时 idx 为空
 */
export function endEdit(b, edit) {
  const idx = [], before = [], after = [] // 三列: 下标、之前、之后
  for (const [k, o] of edit.old) {
    if (b.data[k] === o) continue // 最后又回到原色，等于没改
    idx.push(k); before.push(o); after.push(b.data[k])
  }
  return { idx: Int32Array.from(idx), before: Uint8Array.from(before), after: Uint8Array.from(after) }
}

/** 撤销一条改动（格子改回之前的颜色） */
export function undoDiff(b, d) {
  for (let n = 0; n < d.idx.length; n++) b.data[d.idx[n]] = d.before[n]
}

/** 重做一条改动（格子改成之后的颜色） */
export function redoDiff(b, d) {
  for (let n = 0; n < d.idx.length; n++) b.data[d.idx[n]] = d.after[n]
}

// ---------------------------------------------------------------------------
// 连通块 = 商户
// ---------------------------------------------------------------------------

/**
 * 找出所有连通块（上下左右相邻、同色；斜对角不算连通）
 * @returns {{labels: Int32Array, comps: object[]}}
 *   labels[k] = 格子 k 属于第几块（0 = 空白格）；comps[L] 是第 L 块（comps[0] 占位为 null）:
 *   {label, color, count 格数 = 面积㎡, seed 扫描顺序里的第一格（最上面一行最左边）, cells 格子下标数组,
 *    c0, r0, c1, r1 外包框（格子）, cx, cy 格子中心的平均（场景米）}
 */
export function label(b) {
  const { w, h, data } = b
  const labels = new Int32Array(w * h) // 0 = 还没归块 / 空白
  const comps = [null] // 块号从 1 开始
  const stack = [] // 广度 / 深度都行，用栈省事
  for (let k0 = 0; k0 < w * h; k0++) {
    if (!data[k0] || labels[k0]) continue // 空白格或已归块
    const L = comps.length, v = data[k0] // 新块的编号和颜色
    const comp = { label: L, color: v, count: 0, seed: k0, cells: [], c0: w, r0: h, c1: -1, r1: -1, cx: 0, cy: 0 }
    labels[k0] = L
    stack.push(k0)
    while (stack.length) {
      const k = stack.pop() // 当前格
      const c = k % w, r = (k - c) / w // 拆回行列
      comp.cells.push(k)
      comp.cx += c; comp.cy += r // 先累加，最后求平均
      if (c < comp.c0) comp.c0 = c
      if (c > comp.c1) comp.c1 = c
      if (r < comp.r0) comp.r0 = r
      if (r > comp.r1) comp.r1 = r
      // 四个邻格: 同色、没归块就加进来（边界判断写开，免得左右越行）
      if (c + 1 < w && data[k + 1] === v && !labels[k + 1]) { labels[k + 1] = L; stack.push(k + 1) }
      if (c > 0 && data[k - 1] === v && !labels[k - 1]) { labels[k - 1] = L; stack.push(k - 1) }
      if (r + 1 < h && data[k + w] === v && !labels[k + w]) { labels[k + w] = L; stack.push(k + w) }
      if (r > 0 && data[k - w] === v && !labels[k - w]) { labels[k - w] = L; stack.push(k - w) }
    }
    comp.count = comp.cells.length
    comp.cx = b.x0 + comp.cx / comp.count + 0.5 // 格子中心的平均 → 场景米
    comp.cy = b.y0 + comp.cy / comp.count + 0.5
    comps.push(comp)
  }
  return { labels, comps }
}

/** 格子 (c, r) 的块号；出界 = 0（当成外面） */
function lab(b, labels, c, r) {
  if (c < 0 || r < 0 || c >= b.w || r >= b.h) return 0
  return labels[r * b.w + c]
}

/**
 * 格点 (i, j) 上，第 L 块的门可以朝哪些方向
 *
 * 格点周围四个格子: 西北 (i-1, j-1)、东北 (i, j-1)、西南 (i-1, j)、东南 (i, j)。
 * 门朝东 = 格点所在的竖线 x = i 上，有一段（格点上方或下方的那段）左边是这家店、右边不是；其余三个方向同理。
 * 这样门一定在色块的边缘上，朝向一定是从店里指向店外；在色块的凸角上两个方向都合法。
 * @returns 合法朝向的数组（按 DIR_ORDER 顺序），不在边缘上返回空数组
 */
export function doorDirs(b, labels, L, i, j) {
  if (!L) return []
  const nw = lab(b, labels, i - 1, j - 1) === L, ne = lab(b, labels, i, j - 1) === L // 上面两格是不是这家店
  const sw = lab(b, labels, i - 1, j) === L, se = lab(b, labels, i, j) === L // 下面两格
  const ok = {
    E: (nw && !ne) || (sw && !se), // 竖线上方或下方那段: 西边是店、东边不是
    S: (nw && !sw) || (ne && !se), // 横线左段或右段: 北边是店、南边不是
    W: (ne && !nw) || (se && !sw), // 东边是店、西边不是
    N: (sw && !nw) || (se && !ne), // 南边是店、北边不是
  }
  return DIR_ORDER.filter((d) => ok[d])
}

/** 格点 (i, j) 周围四格里出现的块号（去重，不含 0）: 这个格点可能是这几家店的门 */
export function blocksAround(b, labels, i, j) {
  const s = new Set([lab(b, labels, i - 1, j - 1), lab(b, labels, i, j - 1), lab(b, labels, i - 1, j), lab(b, labels, i, j)])
  s.delete(0) // 空白不算
  return [...s]
}

/**
 * 在 (x, y) 附近放一扇门: 吸到最近的格点，挑一家店、挑一个朝向
 * @param prefer 优先给这一块（当前选中的店）；不行再看点的位置落在哪家店里，最后随便取周围合法的一家
 * @returns {{label, i, j, dir, dirs}} dirs = 这个格点上这家店所有合法朝向；放不了返回 null
 *          朝向取和「格点 → 手点位置」最同向的那个: 点在墙外一点就朝外，自然
 */
export function placeDoor(b, labels, x, y, prefer = 0) {
  const [i, j] = vertexNear(b, x, y) // 最近的格点
  const around = blocksAround(b, labels, i, j) // 格点周围有哪几家店
  const cell = cellAt(b, x, y), under = cell ? labels[cell[1] * b.w + cell[0]] : 0 // 手点位置所在格子的店
  const order = [prefer, under, ...around].filter((L, k, a) => L && around.includes(L) && a.indexOf(L) === k) // 候选顺序，去重
  for (const L of order) {
    const dirs = doorDirs(b, labels, L, i, j) // 这家店在这个格点上能朝哪
    if (!dirs.length) continue // 这个格点不在它的边缘上（在它里面）
    const [vx, vy] = vertexPos(b, i, j), ox = x - vx, oy = y - vy // 手点相对格点的偏移
    let best = dirs[0], bestDot = -Infinity // 和偏移最同向的朝向
    for (const d of dirs) {
      const dot = DIRS[d][0] * ox + DIRS[d][1] * oy
      if (dot > bestDot) { bestDot = dot; best = d }
    }
    return { label: L, i, j, dir: best, dirs }
  }
  return null // 周围没店，或者格点在店的内部
}

/** 门在场景里的位置和朝外法线（写回仿真 / 导出用） */
export function doorGeom(b, d) {
  return { pos: vertexPos(b, d.i, d.j), normal: [...DIRS[d.dir]] }
}

// ---------------------------------------------------------------------------
// 编号延续: 改完一笔后，新的连通块和原来的商户对上号
// ---------------------------------------------------------------------------

/** 键排好序的 JSON（比较两份记录内容是否相同，不受键的先后影响） */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']' // 数组按顺序
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' // 对象按键名排序
  return JSON.stringify(v ?? null) // 基本类型；undefined 当 null
}

/** 找一块里的某一格作为「种子」: 原来的种子还在块里就不换（种子稳定，同步时比对少变动），否则取块的第一格 */
function seedOf(b, labels, comp, old) {
  if (old && old[0] >= 0 && old[1] >= 0 && old[0] < b.w && old[1] < b.h && labels[old[1] * b.w + old[0]] === comp.label) return old
  const c = comp.seed % b.w // 块的第一格
  return [c, (comp.seed - c) / b.w]
}

/**
 * 把商户记录对到新的连通块上，并整理每家店的门
 *
 * 对号规则（「和改之前重叠最多」）:
 *   有 prev（上一次的 labels 和「块号 → 商户编号」）时，新块里每一格投票给它原来所属的商户（颜色要一样）；
 *   没有 prev（刚打开 / 刚同步完）时，用每家店存的种子格投票。
 *   票数从多到少贪心配对，一家店最多配一块，一块最多配一家店。
 *   结果: 画大画小、挪一点编号都不变；一家店被切成两半，大的那半留编号，小的变新店；
 *   两家同色的店连成一片，重叠多的那家留下，另一家删掉（留墓碑），它的门如果还在新色块边上就并过来。
 * 门: 还在自己色块边缘上（朝向也合法）的留下，否则去掉。
 *
 * @param records 画板商户记录（有 seed 的，含已删的墓碑也行，会跳过）
 * @param prev    {labels, owner: Map<块号, 商户编号>} 或 null
 * @param opts.newId()           新店的编号
 * @param opts.info(comp)        额外的派生字段（所在楼、所在考察格……），并进记录
 * @returns {{shops, owner, changed}} shops = 更新后的全部记录（含新店和新墓碑）；owner = 块号 → 商户编号；
 *          changed = 内容有变化的商户编号（调用方给它们记标注人和时间）
 */
export function reconcile(b, labeled, records, prev = null, opts = {}) {
  const { labels, comps } = labeled
  const newId = opts.newId || (() => 's' + Math.random().toString(36).slice(2, 10)) // 测试里可以注入固定编号
  const info = opts.info || (() => ({})) // 派生字段，默认不加
  const live = records.filter((s) => !s.deleted && s.seed) // 参与对号的: 没删的画板商户
  const byId = new Map(live.map((s) => [s.id, s])) // 编号 → 记录
  // 投票: key = 块号 + 商户编号，票数 = 重叠格数
  const votes = new Map()
  const vote = (L, id, n) => { const k = L + '|' + id; votes.set(k, (votes.get(k) || 0) + n) }
  for (let L = 1; L < comps.length; L++) {
    const comp = comps[L]
    if (prev) {
      for (const k of comp.cells) {
        const id = prev.owner.get(prev.labels[k]) // 这一格原来属于哪家店
        if (id && byId.get(id)?.color === comp.color) vote(L, id, 1) // 同色才算延续（换了颜色就是另一家）
      }
    }
    for (const s of live) {
      const [c, r] = s.seed // 种子格
      if (s.color === comp.color && c >= 0 && r >= 0 && c < b.w && r < b.h && labels[r * b.w + c] === L) vote(L, s.id, 0.5) // 种子在块里: 半票（没有 prev 时靠它，有 prev 时只用来打破平局）
    }
  }
  // 贪心配对: 票多的先配
  const pairs = [...votes].map(([k, n]) => { const p = k.indexOf('|'); return { L: +k.slice(0, p), id: k.slice(p + 1), n } })
  pairs.sort((a, c) => c.n - a.n || a.L - c.L || (a.id < c.id ? -1 : 1)) // 票数相同按块号、编号排，结果稳定
  const owner = new Map(), taken = new Set() // 块号 → 编号；已配上的编号
  for (const p of pairs) {
    if (owner.has(p.L) || taken.has(p.id)) continue // 这块或这家店已经配过了
    owner.set(p.L, p.id)
    taken.add(p.id)
  }
  const labelOf = new Map([...owner].map(([L, id]) => [id, L])) // 编号 → 块号
  // 门: 自己的块上合法就留；没配上块的店（被合并 / 擦掉）的门，若在周围某家店的边上合法，就并给那家店
  const doorsOf = new Map() // 块号 → 门列表
  const addDoor = (L, d) => {
    const list = doorsOf.get(L) || []
    if (!list.some((e) => e.i === d.i && e.j === d.j && e.dir === d.dir)) list.push(d) // 同一格点同朝向只留一扇
    doorsOf.set(L, list)
  }
  for (const s of live) {
    const L = labelOf.get(s.id) // 这家店现在的块
    for (const d of s.doors || []) {
      if (L && doorDirs(b, labels, L, d.i, d.j).includes(d.dir)) { addDoor(L, d); continue } // 还在自己边上
      if (L) continue // 店还在但门不在边上了（边被擦掉 / 涂到门外面去了）: 去掉
      const to = blocksAround(b, labels, d.i, d.j).find((M) => doorDirs(b, labels, M, d.i, d.j).includes(d.dir)) // 被合并的店: 找接手的
      if (to) addDoor(to, d)
    }
  }
  // 生成新记录
  const shops = [], changed = new Set()
  const keyOf = ({ by, t, ...rest }) => canon(rest) // 比较内容有没有变（标注人、时间不算）
  for (let L = 1; L < comps.length; L++) {
    const comp = comps[L]
    let id = owner.get(L), old = id ? byId.get(id) : null // 配上的老店
    if (!id) {
      id = newId() // 新块: 新店，默认零售、1 层（最常见）
      owner.set(L, id)
      old = { id, name: '', category: 'retail', floor: '1', hours: '', note: '' }
    }
    const doors = (doorsOf.get(L) || []).map((d) => ({ i: d.i, j: d.j, dir: d.dir, ...doorGeom(b, d) })) // 门带上场景坐标和法线，写回仿真直接用
    const next = { ...old, color: comp.color, seed: seedOf(b, labels, comp, old.seed), area: comp.count, doors, ...info(comp) }
    if (!byId.has(id) || keyOf(next) !== keyOf(old)) changed.add(id) // 新店或者形状 / 门变了
    shops.push(next)
  }
  // 没配上的老店: 变成墓碑（同步后别的手机也删掉）
  for (const s of live) {
    if (labelOf.has(s.id)) continue
    shops.push({ ...s, deleted: true, doors: [] })
    changed.add(s.id)
  }
  // 不参与对号的记录（已有的墓碑、旧版按楼标的商户）原样保留
  for (const s of records) if (s.deleted || !s.seed) shops.push(s)
  return { shops, owner, changed }
}

// ---------------------------------------------------------------------------
// 配色: 新店自动挑一个和周围不一样的颜色
// ---------------------------------------------------------------------------

/**
 * 在格子 (c, r) 周围 radius 格内没出现过的颜色里挑一个（从 after 的下一个开始轮，颜色才有变化）
 * 全都出现过时挑周围用得最少的
 */
export function freeColor(b, c, r, radius = 12, after = 0) {
  const used = new Array(PALETTE.length).fill(0) // 每种颜色在周围出现的格数
  for (let rr = r - radius; rr <= r + radius; rr++) for (let cc = c - radius; cc <= c + radius; cc++) used[get(b, cc, rr)]++
  const n = PALETTE.length - 1 // 可用颜色数
  let best = 1, bestN = Infinity // 用得最少的
  for (let k = 0; k < n; k++) {
    const v = ((after + k) % n) + 1 // 从 after + 1 开始轮
    if (!used[v]) return v // 周围没有，直接用
    if (used[v] < bestN) { bestN = used[v]; best = v }
  }
  return best
}

// ---------------------------------------------------------------------------
// 轮廓: 色块的边界追成多边形（导出 GeoJSON、选中时描边）
// ---------------------------------------------------------------------------

/**
 * 第 L 块的边界环（场景米）
 * 每个格子朝外的边记成有向边，方向让店在前进方向的右侧（屏幕上外轮廓顺时针，洞逆时针），再首尾相接串成环，
 * 最后去掉共线的中间点。
 * @returns {{outer: [x, y][][], holes: [x, y][][]}} 连通块只有一个外轮廓，洞可以有多个
 */
export function outline(b, labels, comp) {
  const L = comp.label, next = new Map() // 起点格点 → 从它出发的有向边终点列表
  const key = (i, j) => j * (b.w + 1) + i // 格点编号
  const add = (i0, j0, i1, j1) => { const k = key(i0, j0); (next.get(k) || next.set(k, []).get(k)).push([i1, j1]) }
  for (const k of comp.cells) {
    const c = k % b.w, r = (k - c) / b.w // 这一格
    if (lab(b, labels, c, r - 1) !== L) add(c, r, c + 1, r) // 上边朝外: 自西向东
    if (lab(b, labels, c + 1, r) !== L) add(c + 1, r, c + 1, r + 1) // 右边: 自北向南
    if (lab(b, labels, c, r + 1) !== L) add(c + 1, r + 1, c, r + 1) // 下边: 自东向西
    if (lab(b, labels, c - 1, r) !== L) add(c, r + 1, c, r) // 左边: 自南向北
  }
  const rings = []
  for (const [k0, list0] of next) {
    while (list0.length) {
      // 从一条没走过的边出发，一直走回起点
      const ring = []
      let i = k0 % (b.w + 1), j = (k0 - i) / (b.w + 1), pd = null // 当前格点和上一步的方向
      for (;;) {
        if (pd && key(i, j) === k0) break // 回到起点: 这个环走完了（起点若还有别的出边，留给下一个环）
        const list = next.get(key(i, j))
        if (!list || !list.length) break // 断了（不会发生，保险）
        // 一个格点有两条出边（两个块只在对角相接）时，优先右转，环不会互相穿过
        let pick = 0
        if (list.length > 1 && pd) {
          const turn = (e) => pd[0] * (e[1] - j) - pd[1] * (e[0] - i) // 叉积 > 0 = 右转（y 向下时）
          pick = list.reduce((bi, e, n) => (turn(e) > turn(list[bi]) ? n : bi), 0)
        }
        const [i1, j1] = list.splice(pick, 1)[0] // 用掉这条边
        ring.push([i, j])
        pd = [i1 - i, j1 - j]
        i = i1; j = j1
      }
      rings.push(simplifyRing(ring).map(([ii, jj]) => vertexPos(b, ii, jj)))
    }
  }
  // 面积为正的是外轮廓（y 向下时顺时针），负的是洞
  const outer = [], holes = []
  for (const r of rings) (ringArea(r) > 0 ? outer : holes).push(r)
  return { outer, holes }
}

/** 去掉共线的中间点（格子边界走出来全是 1 米一段，直墙只要两端） */
function simplifyRing(ring) {
  const n = ring.length, out = []
  for (let k = 0; k < n; k++) {
    const a = ring[(k - 1 + n) % n], p = ring[k], c = ring[(k + 1) % n] // 前一点、这一点、后一点
    if ((p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0]) !== 0) out.push(p) // 拐弯了才留
  }
  return out
}

/** 鞋带公式求有向面积（y 向下坐标里顺时针为正） */
export function ringArea(ring) {
  let s = 0
  for (let k = 0; k < ring.length; k++) {
    const [x0, y0] = ring[k], [x1, y1] = ring[(k + 1) % ring.length]
    s += x0 * y1 - x1 * y0
  }
  return s / 2
}

// ---------------------------------------------------------------------------
// 分块存储 / 同步: 50 米一块，游程编码
// ---------------------------------------------------------------------------

/** 画板分成几行几列块 */
export function tileDims(b) {
  return { rows: Math.ceil(b.h / TILE), cols: Math.ceil(b.w / TILE) }
}

/** 格子下标 → 所在块的编号（A01 这种） */
export function tileOfIndex(b, k) {
  const c = k % b.w, r = (k - c) / b.w
  return cellId(Math.floor(r / TILE), Math.floor(c / TILE))
}

/** 块编号 → [行, 列]（cellId 的逆: 字母是 26 进制无零的行号，数字是 1 起的列号）；格式不对返回 null */
export function parseTileId(id) {
  const m = /^([A-Z]+)(\d+)$/.exec(id || '')
  if (!m) return null
  let row = 0
  for (const ch of m[1]) row = row * 26 + (ch.charCodeAt(0) - 64) // A = 1 … Z = 26
  return [row - 1, parseInt(m[2], 10) - 1]
}

/** 一块覆盖的格子范围（最后一行 / 一列的块可能不满 50） */
function tileRange(b, tr, tc) {
  const c0 = tc * TILE, r0 = tr * TILE
  return { c0, r0, c1: Math.min(b.w, c0 + TILE), r1: Math.min(b.h, r0 + TILE) }
}

/**
 * 一块压成游程编码: "颜色x个数,颜色x个数…"，按行优先；全空的一块就是 "0x2500"
 * 商户大多是整片的矩形，压完通常只有几十个字符
 */
export function encodeTile(b, tr, tc) {
  const { c0, r0, c1, r1 } = tileRange(b, tr, tc)
  const runs = []
  let v = -1, n = 0 // 当前游程的颜色和长度
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const x = b.data[r * b.w + c]
      if (x === v) n++
      else {
        if (n) runs.push(v + 'x' + n) // 结束上一个游程
        v = x
        n = 1
      }
    }
  }
  if (n) runs.push(v + 'x' + n)
  return runs.join(',')
}

/** 游程编码解回画板的这一块；长度对不上（画板尺寸变了）返回 false 并且不改画板 */
export function decodeTile(b, tr, tc, s) {
  const { c0, r0, c1, r1 } = tileRange(b, tr, tc)
  const vals = [] // 展开后的颜色
  for (const part of (s || '').split(',')) {
    if (!part) continue
    const [v, n] = part.split('x').map(Number)
    if (!(v >= 0 && v < PALETTE.length && n > 0)) return false // 坏数据
    for (let k = 0; k < n; k++) vals.push(v)
  }
  if (vals.length !== (c1 - c0) * (r1 - r0)) return false // 尺寸不符
  let k = 0
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) b.data[r * b.w + c] = vals[k++]
  return true
}

/** 把 survey.tiles（块编号 → {rle}）全部铺到画板上；返回铺上的块数 */
export function loadTiles(b, tiles) {
  let n = 0
  for (const [id, t] of Object.entries(tiles || {})) {
    const rc = parseTileId(id)
    const { rows, cols } = tileDims(b)
    if (!rc || rc[0] >= rows || rc[1] >= cols) continue // 编号不在这块画板上
    if (decodeTile(b, rc[0], rc[1], t.rle)) n++
  }
  return n
}

/** 一批格子下标涉及哪些块（改完一笔后只重新编码这些块） */
export function tilesOfCells(b, idx) {
  const s = new Set()
  for (const k of idx) s.add(tileOfIndex(b, k))
  return [...s]
}
