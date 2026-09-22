// 场景编辑器的纯逻辑（不碰 DOM，vitest 直接测）:
//   矢量图      新建空白画布；把已有场景（scene.json）拆回可编辑的路 / 楼 / 区域
//   几何        点到折线距离、命中测试（点选元素）、画路时吸附到已有道路、按住 Shift 取 45° 整数倍方向
//   检查        生成前的问题清单（和后端 editor/backend/drawscene.py 的 validate 同一套规则）
// 坐标约定和 scene.json 一致: 原点在画布中心，单位米，x 向东、y 向南。
// 矢量图格式见 editor/backend/drawscene.py 文件头；后端把它画成标记图交给 map2scene，所以这里不管路口、斑马线这些。
import { laneLayout } from '../../src/city/roads.js' // 没指定车道数的路按路宽推，和前端车流同一套规则

export const LANE_W = 3.5 // 按车道数算路宽时每条车道的宽度（米），和后端一致

/** 建筑类型: id 和 map2scene / buildings.js 的 kind 一致；color 是标记调色板里的颜色；floors 是新画时的默认层数 */
export const BUILDING_KINDS = [ // 建筑类型表
  { id: 'shop', t: '商铺', color: '#FF0000', floors: 2 },
  { id: 'block', t: '写字楼', color: '#FF00FF', floors: 12 },
  { id: 'residential', t: '住宅', color: '#00FF80', floors: 11 },
  { id: 'venue', t: '场馆', color: '#80FF00', floors: 4 },
]

/** 面状区域类型（颜色同标记调色板） */
export const AREA_KINDS = [ // 区域类型表
  { id: 'green', t: '绿化带', color: '#00FF00' },
  { id: 'park', t: '公园', color: '#008000' },
  { id: 'water', t: '水体', color: '#0080FF' },
  { id: 'plaza', t: '广场', color: '#FF80FF' },
  { id: 'parking', t: '停车场', color: '#8000FF' },
]

/** 路宽（米）: 手填了就用，否则 = 每方向车道数 × 3.5（双向乘 2） */
export function roadWidth(r) {
  if (r.width) return r.width // 手填的路宽优先
  const n = Math.max(1, r.lanes || 1) // 没填车道数按 1 条
  return n * LANE_W * (r.oneway ? 1 : 2) // 每条车道 3.5 米
}

/** 空白画布（默认 400 × 300 米） */
export function emptyDrawing(widthM = 400, heightM = 300) {
  return { version: 1, widthM, heightM, roads: [], buildings: [], areas: [], doors: [], portals: [], background: null, origin: null } // 店门 / 出入口也是列表；底图、经纬度可选
}

/**
 * 已有场景 → 可编辑的矢量图
 * - 路: roadGraph 的每条边一条折线，保留原路宽；单行边按行驶方向重排点序；环道当普通路（重新生成时按形状再识别成环岛）
 * - 高架: level = 1 的边
 * - 楼 / 区域: 原样；店门、出入口不带（重新生成时自动布，手工要改的再画）
 * - 底图: 导入场景的底图和场景文件在同一目录，文件名直接沿用；地理位置原样带上（实地标注的定位还能用）
 * 画布尺寸: 有底图用底图的宽高（原点就是底图中心）；没有就取能包住场景范围、关于原点对称的大小
 */
export function sceneToDrawing(scene) {
  const b = scene.bounds // 场景范围（米）
  const widthM = scene.imagery?.widthM || Math.ceil(2 * Math.max(Math.abs(b.minX), Math.abs(b.maxX))) // 有底图用底图宽
  const heightM = scene.imagery?.heightM || Math.ceil(2 * Math.max(Math.abs(b.minY), Math.abs(b.maxY))) // 有底图用底图高
  const d = emptyDrawing(widthM, heightM) // 空白矢量图，下面往里填
  for (const e of scene.roadGraph?.edges || []) { // 每条道路边一条折线
    const ring = !!e.roundabout // 环道
    const oneway = !!e.oneway && !ring // 普通单行路（环道的方向由形状决定，不当单行画）
    const pts = oneway && e.oneway < 0 ? [...e.points].reverse() : e.points // 点序 = 行驶方向
    // 车道数: 场景里指定过就用，否则按路宽推一个（显示用；路宽原样保留，重新生成时车道还是按路宽推）
    const lanes = e.laneCount || laneLayout(e.width, oneway || ring, e.median || 0).n
    d.roads.push({ points: pts.map((p) => [p[0], p[1]]), lanes, oneway, width: e.width, elevated: e.level === 1 }) // 路宽原样保留
  }
  d.buildings = scene.buildings.map((x) => ({ polygon: x.polygon.map((p) => [p[0], p[1]]), kind: x.kind, floors: x.floors })) // 楼: 轮廓、类型、层数
  d.areas = (scene.areas || []).map((x) => ({ polygon: x.polygon.map((p) => [p[0], p[1]]), kind: x.kind })) // 区域: 轮廓、类型（洞不带）
  if (scene.imagery) d.background = { url: scene.imagery.url } // 底图文件名
  if (scene.origin?.geo) d.origin = { geo: scene.origin.geo, summary: scene.origin.summary } // 经纬度换算要原图尺寸
  return d // 可编辑的矢量图
}

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

/** 点 p 在线段 ab 上的最近点和距离 */
export function nearestOnSegment(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy // 线段方向和长度平方
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0 // 投影参数，截到线段内
  const q = [a[0] + t * dx, a[1] + t * dy] // 垂足
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) } // 最近点和距离
}

/** 点到折线的最短距离 */
export function distToPolyline(pts, p) {
  let best = Infinity // 目前最近的距离
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, nearestOnSegment(pts[i], pts[i + 1], p).d) // 逐段取最小
  return best // 最短距离
}

/** 射线法: 点是否在多边形内 */
export function inside(poly, x, y) {
  let hit = false // 穿过次数的奇偶
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j] // 当前边的两个端点
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit // 跨过水平线且交点在右边
  }
  return hit // 奇数次 = 在里面
}

/** 顶点平均点（标层数、车道数文字用） */
export function centroid(poly) {
  let x = 0, y = 0 // 坐标累加
  for (const p of poly) {
    x += p[0]
    y += p[1]
  }
  return [x / poly.length, y / poly.length] // 平均
}

/**
 * 点选: 返回点到的元素 {type, index}，没点到返回 null
 * 优先级: 店门 / 出入口（小，放最前）→ 道路（路面范围 + tol）→ 建筑 → 区域；同类里后画的优先（盖在上面）
 * @param tol 容差（米），一般取 8 个屏幕像素换算成米
 */
export function hitTest(d, p, tol) {
  for (const type of ['doors', 'portals']) { // 点状元素最小，最先判断
    for (let i = d[type].length - 1; i >= 0; i--) if (Math.hypot(d[type][i].pos[0] - p[0], d[type][i].pos[1] - p[1]) <= tol * 1.5) return { type, index: i }
  }
  for (let i = d.roads.length - 1; i >= 0; i--) if (distToPolyline(d.roads[i].points, p) <= roadWidth(d.roads[i]) / 2 + tol) return { type: 'roads', index: i } // 点在路面范围内
  for (const type of ['buildings', 'areas']) { // 面状元素
    for (let i = d[type].length - 1; i >= 0; i--) if (inside(d[type][i].polygon, p[0], p[1])) return { type, index: i }
  }
  return null // 什么都没点到
}

/**
 * 画路时的吸附: 先吸已有道路的端点 / 拐点（tol 内最近的），再吸道路中心线上的最近点
 * 路口靠两条路的路面在标记图上连成一片，端点正好落在别的路中心线上时连得最干净
 * @param skip 正在画 / 正在改的那条路的下标，不吸自己
 * @returns {{p: [x, y], kind: 'vertex' | 'line'} | null}
 */
export function snapToRoads(d, p, tol, skip = -1) {
  let best = null // 目前最好的吸附
  d.roads.forEach((r, i) => {
    if (i === skip) return // 不吸自己
    for (const v of r.points) {
      const dd = Math.hypot(v[0] - p[0], v[1] - p[1])
      if (dd <= tol && (!best || best.kind !== 'vertex' || dd < best.d)) best = { p: [v[0], v[1]], kind: 'vertex', d: dd } // 顶点优先
    }
  })
  if (best) return best // 吸到顶点就不再看中心线
  d.roads.forEach((r, i) => {
    if (i === skip) return // 不吸自己
    for (let k = 0; k + 1 < r.points.length; k++) {
      const { q, d: dd } = nearestOnSegment(r.points[k], r.points[k + 1], p)
      if (dd <= tol && (!best || dd < best.d)) best = { p: q, kind: 'line', d: dd } // 更近就换成中心线上的点
    }
  })
  return best // 没有就是 null
}

/** 按住 Shift 画: 从上一个点出发的方向取到最近的 45° 整数倍，长度不变 */
export function snapAngle(prev, p) {
  const dx = p[0] - prev[0], dy = p[1] - prev[1] // 从上一个点出发的向量
  const L = Math.hypot(dx, dy) // 长度
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4) // 最近的 45° 整数倍
  return [prev[0] + L * Math.cos(a), prev[1] + L * Math.sin(a)] // 沿取整后的方向走同样的长度
}

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------

/** 生成前的问题清单（空数组 = 可以生成）；规则和后端 validate 一致，只是在前端先拦一道、提示得更具体 */
export function problems(d) {
  const out = [] // 问题列表
  if (!(d.widthM >= 20 && d.widthM <= 3000 && d.heightM >= 20 && d.heightM <= 3000)) out.push('画布宽高要在 20 ~ 3000 米之间')
  if (!d.roads.length && !d.buildings.length) out.push('至少画一条路或一栋楼')
  d.roads.forEach((r, i) => { if (r.points.length < 2) out.push(`第 ${i + 1} 条路少于 2 个点`) })
  d.buildings.forEach((b, i) => { if (b.polygon.length < 3) out.push(`第 ${i + 1} 栋楼少于 3 个点`) })
  d.areas.forEach((a, i) => { if (a.polygon.length < 3) out.push(`第 ${i + 1} 块区域少于 3 个点`) })
  return out // 空数组 = 可以生成
}

/** 统计（状态栏显示） */
export function stats(d) {
  const len = d.roads.reduce((s, r) => s + r.points.slice(1).reduce((t, p, k) => t + Math.hypot(p[0] - r.points[k][0], p[1] - r.points[k][1]), 0), 0) // 所有路的总长（米）
  return { roads: d.roads.length, roadKm: Math.round(len / 100) / 10, buildings: d.buildings.length, areas: d.areas.length, doors: d.doors.length, portals: d.portals.length } // 路长换成公里，保留一位小数
}
