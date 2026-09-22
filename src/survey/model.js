// 实地标注工具的纯逻辑（不碰 DOM，vitest 直接测）:
//   网格        场景切成固定边长的方格，编号 A01、B07……，给考察人员分工、记进度
//   坐标        场景米 ⇄ 经纬度（Web 墨卡托截图 / 经纬度网格两种地理参考，可带 GCJ-02 火星坐标）
//   吸附        手点的位置吸到楼的外墙上，算出门朝外的方向；两点之间沿外墙取一段当「临街范围」
//   标注数据    商户增改删（删除留墓碑）、格子状态、涂色板分块、操作日志
//   导出        GeoJSON（给 GIS / 甲方）和 CSV（给表格）
// 涂色板本身（1 米格、划区、连通块、门口）在 board.js；这里的「吸附到外墙」是旧版按楼标门时用的，场景编辑器还在用。
// 场景坐标约定和 tools/map2scene.py 一致: 原点在原图中心，单位米，x 向东、y 向南（图像的 y 向下）。

// ---------------------------------------------------------------------------
// 网格
// ---------------------------------------------------------------------------

/** 第 i 行的字母编号: 0 → A，25 → Z，26 → AA（行数超过 26 时接着编，和表格列名一样） */
export function rowLabel(i) {
  let s = '' // 从最低位往高位拼
  i += 1 // 转成 1 起的「26 进制无零」表示
  while (i > 0) {
    const r = (i - 1) % 26 // 当前位 0~25
    s = String.fromCharCode(65 + r) + s // 这一位的字母拼到前面
    i = Math.floor((i - 1) / 26) // 去掉这一位
  }
  return s
}

/** 行列号 → 格子编号，列号补成两位（A01 而不是 A1，排序才对） */
export function cellId(row, col) {
  return rowLabel(row) + String(col + 1).padStart(2, '0')
}

/**
 * 把场景范围切成 size 米见方的格子
 * @param bounds 场景的 {minX, minY, maxX, maxY}（米）
 * @param size   格子边长（米），默认 50: 一个人半小时左右能走完一格的沿街商户
 * @returns {{size, x0, y0, cols, rows, cells: {id, row, col, x0, y0, x1, y1}[]}}
 *          行从北（y 小）往南编字母，列从西往东编两位数字，例如 B03 = 第 2 行第 3 列
 */
export function makeGrid(bounds, size = 50) {
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / size)) // 列数: 东西方向格子数
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / size)) // 行数: 南北方向格子数
  const cells = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = bounds.minX + c * size, y0 = bounds.minY + r * size // 这一格的左上角
      // 最后一行 / 一列可能不满一格，这里照样按整格画，超出场景的部分无所谓
      cells.push({ id: cellId(r, c), row: r, col: c, x0, y0, x1: x0 + size, y1: y0 + size })
    }
  }
  return { size, x0: bounds.minX, y0: bounds.minY, cols, rows, cells } // 网格原点 = 场景左上角
}

/** 场景坐标 (x, y) 落在哪一格；在网格外返回 null */
export function cellAt(grid, x, y) {
  const c = Math.floor((x - grid.x0) / grid.size), r = Math.floor((y - grid.y0) / grid.size) // 按格子边长整除
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return null // 网格外
  return cellId(r, c)
}

// ---------------------------------------------------------------------------
// 坐标: 场景米 ⇄ 经纬度（和 tools/osm.py 的 GeoRef 同一套公式）
// ---------------------------------------------------------------------------
const GCJ_A = 6378245.0 // GCJ-02 用的克拉索夫斯基椭球长半轴（米）
const GCJ_EE = 0.00669342162296594323 // 该椭球的第一偏心率平方

/** 大致在中国境外就不加偏（高德 / 腾讯在国外也用 WGS84） */
function outOfChina(lon, lat) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}

/** GCJ-02 相对 WGS84 的偏移（度）。常数来自公开算法，没有物理含义，别改；和 osm.py 的 _delta 逐项对应 */
function gcjDelta(lon, lat) {
  const x = lon - 105.0, y = lat - 35.0, PI = Math.PI // 相对中国大致中心的经纬度差（度）
  // 纬度方向扰动（米级量）
  let dlat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) // 多项式部分
  dlat += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  dlat += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  dlat += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  // 经度方向扰动（米级量）
  let dlon = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  dlon += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  dlon += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  dlon += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  // 米 → 度: 除以当地的子午圈 / 卯酉圈曲率半径
  const rad = (lat / 180.0) * PI // 纬度换成弧度
  const magic = 1 - GCJ_EE * Math.sin(rad) ** 2 // 1 - e²·sin²φ
  const sq = Math.sqrt(magic) // √(1 - e²·sin²φ)
  dlat = (dlat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sq)) * PI) // M = a(1-e²)/(1-e²sin²φ)^1.5
  dlon = (dlon * 180.0) / ((GCJ_A / sq) * Math.cos(rad) * PI) // N·cosφ = a/√(1-e²sin²φ)·cosφ
  return [dlon, dlat]
}

/** WGS84 → GCJ-02（手机 GPS 是 WGS84，高德 / 腾讯截图是 GCJ-02，要先换过去才能对上图） */
export function wgs84ToGcj02(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat] // 国外原样
  const [a, b] = gcjDelta(lon, lat) // 偏移量（度）
  return [lon + a, lat + b]
}

/** GCJ-02 → WGS84: 没有解析逆，不动点迭代 3 轮（误差 < 0.5 米） */
export function gcj02ToWgs84(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat] // 国外原样
  let wl = lon, wa = lat // 初值直接当 WGS84
  for (let k = 0; k < 3; k++) {
    const [gl, ga] = wgs84ToGcj02(wl, wa) // 猜测值正向加偏
    wl -= gl - lon // 正向结果比目标多多少，猜测值就减多少
    wa -= ga - lat // 纬度同理
  }
  return [wl, wa]
}

/** 经纬度 → Web 墨卡托「世界像素」（world = 整个世界的像素宽），x 向东、y 向南 */
function merc(lon, lat, world) {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180) // 截到 ±85°，墨卡托在极点发散
  return [((lon + 180) / 360) * world, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world] // y = 0.5 - ln((1+sinφ)/(1-sinφ)) / 4π
}

/** merc 的逆 */
function unmerc(x, y, world) {
  return [(x / world) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) * 180) / Math.PI] // Gudermann 函数反算纬度
}

/**
 * 从 scene.origin 建一个坐标换算器；场景没有地理位置（只给了分辨率导入的图、内置示例）返回 null
 * @param origin scene.origin: {geo, summary: {width, height, mpp}}，由 tools/autoscene.py 写入
 * @returns {{toScene(lon, lat): [x, y], toLonLat(x, y): [lon, lat]}} 进出都是 WGS84
 */
export function makeGeo(origin) {
  const g = origin?.geo, sm = origin?.summary // autoscene 写的地理参考和原图尺寸
  if (!g || !sm?.width || !sm?.height || !sm?.mpp) return null // 缺任何一项都没法换算
  const W = sm.width, H = sm.height, mpp = sm.mpp // 原图宽高（像素）和米/像素
  const gcj = g.datum === 'gcj02' // 图片是火星坐标: 进来先加偏，出去先去偏
  let pxOf, lonLatOf // 图片坐标系下的 经纬度 ⇄ 像素
  if (g.type === 'lonlat') {
    // 左上角像素的经纬度 + 每像素度数；纬度向下递减
    pxOf = (lon, lat) => [(lon - g.lon0) / g.dlon, (g.lat0 - lat) / g.dlat]
    lonLatOf = (px, py) => [g.lon0 + px * g.dlon, g.lat0 - py * g.dlat]
  } else if (g.type === 'webmerc') {
    // 截图: 图中心 = (lon, lat)，世界像素宽 = 256 × 2^zoom × 截图倍率
    const world = 256 * 2 ** g.zoom * (g.scale || 1)
    const [cx, cy] = merc(g.lon, g.lat, world) // 图中心的世界像素坐标
    pxOf = (lon, lat) => {
      const [x, y] = merc(lon, lat, world) // 目标点的世界像素坐标
      return [x - cx + W / 2, y - cy + H / 2] // 图中心对应 (cx, cy)
    }
    lonLatOf = (px, py) => unmerc(px - W / 2 + cx, py - H / 2 + cy, world)
  } else return null
  return {
    // WGS84 → 场景米: 必要时加偏 → 像素 → 以图中心为原点乘 mpp
    toScene(lon, lat) {
      if (gcj) [lon, lat] = wgs84ToGcj02(lon, lat)
      const [px, py] = pxOf(lon, lat) // 图片像素坐标
      return [(px - W / 2) * mpp, (py - H / 2) * mpp] // 以图中心为原点换成米
    },
    // 场景米 → WGS84: 上面的逆，最后去偏
    toLonLat(x, y) {
      const ll = lonLatOf(x / mpp + W / 2, y / mpp + H / 2) // 场景米换回图片像素再反投影
      return gcj ? gcj02ToWgs84(ll[0], ll[1]) : ll
    },
  }
}

// ---------------------------------------------------------------------------
// 几何: 点选楼、吸附到外墙、沿墙取一段
// ---------------------------------------------------------------------------

/** 射线法判断点是否在多边形里（poly = [[x, y], ...]，首尾不重复） */
export function inside(poly, x, y) {
  let hit = false // 穿过次数的奇偶
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j] // 当前边的两个端点
    // 这条边跨过水平线 y，并且交点在 x 右边 → 翻转一次
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** 多边形的顶点平均点（楼算「在哪一格」用；不需要严格的面积重心） */
export function centroid(poly) {
  let x = 0, y = 0 // 坐标累加
  for (const p of poly) {
    x += p[0]
    y += p[1]
  }
  return [x / poly.length, y / poly.length]
}

/** 点到哪栋楼里（后面的楼优先，和画的顺序一致: 后画的盖在上面）；都不在返回 null */
export function buildingAt(buildings, x, y) {
  for (let k = buildings.length - 1; k >= 0; k--) if (inside(buildings[k].polygon, x, y)) return buildings[k]
  return null
}

/** 保留两位小数（厘米），存出来的 JSON 短一点 */
function round2(v) {
  return Math.round(v * 100) / 100
}

/** 外墙的周长累计: cum[i] = 第 i 个顶点离起点多远（沿墙走），cum[n] = 周长 */
function perimeter(poly) {
  const cum = [0] // 第 0 个顶点处弧长为 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length] // 当前边的两个端点（最后一条边回到第 0 个顶点）
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])) // 累加边长
  }
  return cum
}

/**
 * 把点 (x, y) 吸到多边形外墙上最近的一点，并给出朝外的单位法线
 * @returns {{pos: [x, y], normal: [nx, ny], edge, s, dist}}
 *          s = 沿外墙从第 0 个顶点走到这一点的距离（取临街范围用）；dist = 手点位置离墙多远
 */
export function snapToWall(poly, x, y) {
  const cum = perimeter(poly) // 每个顶点处的弧长
  let best = null // 目前最近的墙上点
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length] // 当前边
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy // 边向量和长度平方
    if (L2 < 1e-9) continue // 重复顶点
    // 投影到线段上，t 截到 [0, 1]
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2))
    const px = a[0] + t * dx, py = a[1] + t * dy // 墙上的投影点
    const d = Math.hypot(x - px, y - py) // 手点位置离墙多远
    if (!best || d < best.dist) best = { edge: i, pos: [px, py], dist: d, dir: [dx, dy], s: cum[i] + t * Math.sqrt(L2) } // 更近就记下，s = 顶点弧长 + 边内距离
  }
  if (!best) return null // 退化多边形
  // 两个垂直方向里，往外迈一小步不在楼里的那个就是「朝外」；不依赖多边形是顺时针还是逆时针
  const L = Math.hypot(best.dir[0], best.dir[1]) // 最近那条边的长度
  let n = [-best.dir[1] / L, best.dir[0] / L] // 边方向转 90°
  if (inside(poly, best.pos[0] + n[0] * 0.3, best.pos[1] + n[1] * 0.3)) n = [-n[0], -n[1]]
  return { pos: best.pos.map(round2), normal: n.map((v) => Math.round(v * 1e4) / 1e4 + 0), edge: best.edge, s: best.s, dist: best.dist }
}

/** 沿外墙在弧长 s 处的点（s 可以超出 [0, 周长)，自动绕圈） */
function pointAt(poly, cum, s) {
  const P = cum[cum.length - 1] // 周长
  s = ((s % P) + P) % P
  let i = 0 // 从第 0 条边开始找
  while (i < poly.length - 1 && cum[i + 1] < s) i++ // 找 s 落在哪条边上
  const a = poly[i], b = poly[(i + 1) % poly.length], L = cum[i + 1] - cum[i] // 所在边的两端和边长
  const t = L > 0 ? (s - cum[i]) / L : 0 // 边内比例
  return [round2(a[0] + t * (b[0] - a[0])), round2(a[1] + t * (b[1] - a[1]))] // 线性插值
}

/**
 * 外墙上两点之间的一段（临街范围）: 沿墙走较短的那个方向，途经的拐角都带上
 * @param poly 楼的外轮廓
 * @param s0, s1 两端的弧长（snapToWall 返回的 s）
 * @returns {{path: [x, y][], length}} path 从 s0 那端开始，length 单位米
 */
export function wallSegment(poly, s0, s1) {
  const cum = perimeter(poly), P = cum[cum.length - 1]
  const fwd = (((s1 - s0) % P) + P) % P // 顺着顶点顺序走的距离
  const dir = fwd <= P / 2 ? 1 : -1 // 反过来更短就倒着走
  const len = dir > 0 ? fwd : P - fwd
  const path = [pointAt(poly, cum, s0)]
  // 途经的顶点: 从 s0 出发沿 dir 方向、距离落在 (0, len) 之间的都要，拐角才不会被抄近路切掉
  const verts = cum.slice(0, poly.length).map((c, i) => ({ i, d: (((dir * (c - s0)) % P) + P) % P }))
  verts
    .filter((v) => v.d > 1e-6 && v.d < len - 1e-6)
    .sort((a, b) => a.d - b.d)
    .forEach((v) => path.push(poly[v.i].map(round2)))
  path.push(pointAt(poly, cum, s0 + dir * len))
  return { path, length: round2(len) }
}

// ---------------------------------------------------------------------------
// 标注数据
// ---------------------------------------------------------------------------

/** 业态 → 默认吸引力 w（写回场景时按楼汇总成 attraction）；空置的店不吸引人 */
export const CATEGORIES = [
  { id: 'food', t: '餐饮', w: 1.6 },
  { id: 'retail', t: '零售', w: 1.2 },
  { id: 'service', t: '生活服务', w: 0.8 },
  { id: 'fun', t: '休闲娱乐', w: 1.4 },
  { id: 'office', t: '办公', w: 0.5 },
  { id: 'other', t: '其他', w: 0.6 },
  { id: 'vacant', t: '空置', w: 0 },
]

/** 网格格子的考察状态 */
export const CELL_STATUS = [
  { id: 'todo', t: '未查' },
  { id: 'doing', t: '进行中' },
  { id: 'done', t: '已完成' },
  { id: 'review', t: '待复核' },
]

/**
 * 空白标注数据；scene = 场景 id（'district'、'imported/xxx'）
 * 第 2 版加了 tiles: 涂色板按 50 米分块的游程编码 {块编号: {rle, by, t}}（见 board.js），同步时按块取新
 */
export function emptySurvey(scene) {
  return { version: 2, scene, cells: {}, tiles: {}, shops: [], log: [] }
}

/**
 * 涂色板改了一笔后，把涉及的块写进标注数据（整块替换，记标注人和时间；一笔记一条日志）
 * @param tiles {块编号: 游程编码}
 * @returns 新的 survey（不改原对象）
 */
export function setTiles(survey, tiles, by = '', now = Date.now()) {
  const next = { ...(survey.tiles || {}) } // 旧版数据没有 tiles
  for (const [id, rle] of Object.entries(tiles)) next[id] = { rle, by, t: now } // 每块单独带时间，合并时按块比
  const ids = Object.keys(tiles).sort().join(' ') // 日志里记改了哪几块
  return { ...survey, version: 2, tiles: next, log: ids ? [...survey.log, { t: now, by, action: 'paint', id: ids }] : survey.log }
}

/** 新商户的编号: 时间 + 随机数，几台手机同时标也不会撞（合并时按编号对齐） */
export function newShopId(now = Date.now(), rnd = Math.random) {
  return 's' + now.toString(36) + Math.floor(rnd() * 36 ** 4).toString(36).padStart(4, '0')
}

/**
 * 增改一家商户，同时记一条操作日志（谁、什么时候、做了什么）
 * shop.deleted = true 表示删除: 保留「墓碑」，同步时别的手机才知道它被删了
 * @returns 新的 survey（不改原对象，Vue 里直接整体替换）
 */
export function upsertShop(survey, shop, by = '', now = Date.now()) {
  const old = survey.shops.find((s) => s.id === shop.id)
  const next = { ...shop, by, t: now }
  const action = shop.deleted ? 'delete' : old ? 'edit' : 'add'
  return {
    ...survey,
    shops: old ? survey.shops.map((s) => (s.id === shop.id ? next : s)) : [...survey.shops, next],
    log: [...survey.log, { t: now, by, action, id: shop.id }],
  }
}

/** 改一格的考察状态（同样记日志） */
export function setCellStatus(survey, cell, status, by = '', now = Date.now()) {
  return {
    ...survey,
    cells: { ...survey.cells, [cell]: { status, by, t: now } },
    log: [...survey.log, { t: now, by, action: 'cell:' + status, id: cell }],
  }
}

/** 没删掉的商户 */
export function liveShops(survey) {
  return survey.shops.filter((s) => !s.deleted)
}

/** 某栋楼上的商户 */
export function shopsOf(survey, buildingId) {
  return liveShops(survey).filter((s) => s.building === buildingId)
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** 业态 id → 中文名；不认识的原样返回 */
export function catName(id) {
  return CATEGORIES.find((c) => c.id === id)?.t || id || ''
}

/** 门朝向的中文名（涂色板的门有 dir；旧版按楼标的门只有法线，按法线换算） */
export function dirName(d) {
  const names = { E: '东', S: '南', W: '西', N: '北' } // 和 board.js 的 DIR_NAME 一致
  if (d?.dir) return names[d.dir] || ''
  if (!d?.normal) return ''
  const [x, y] = d.normal // y 向南
  return Math.abs(x) >= Math.abs(y) ? (x > 0 ? '东' : '西') : y > 0 ? '南' : '北' // 取绝对值大的分量
}

/**
 * 导出 GeoJSON: 每家店的色块轮廓（多边形，涂色板商户才有）+ 每扇门一个点 + 一条临街线（旧版数据才有）
 * 场景有地理位置时坐标是 WGS84 经纬度（crs = EPSG:4326）；没有时是场景米（crs = scene-m）
 * @param outlines 可选，商户编号 → {outer, holes}（board.outline 的结果，页面上现算好传进来）
 */
export function toGeoJSON(survey, geo, outlines = null) {
  // 经纬度保留 7 位小数 ≈ 1 厘米
  const P = (p) => (geo ? geo.toLonLat(p[0], p[1]).map((v) => Math.round(v * 1e7) / 1e7) : p)
  // GeoJSON 要求环首尾相同、外环逆时针（北在上看）；轮廓在 y 向南的场景里是顺时针，反过来就行
  const ring = (r) => { const q = [...r].reverse().map(P); return [...q, q[0]] }
  const features = []
  for (const s of liveShops(survey)) {
    const props = {
      id: s.id, building: s.building || '', name: s.name || '', category: catName(s.category), floor: s.floor || '',
      hours: s.hours || '', note: s.note || '', cell: s.cell || '', area: s.area ?? '', by: s.by || '', time: s.t ? new Date(s.t).toISOString() : '',
    }
    const o = outlines?.get(s.id) // 这家店的色块轮廓
    if (o?.outer?.length) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(o.outer[0]), ...o.holes.map(ring)] }, properties: { ...props, feature: 'shop' } })
    for (const d of s.doors || []) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: P(d.pos) }, properties: { ...props, feature: 'door', normal: d.normal, facing: dirName(d) } })
    if (s.frontage?.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: s.frontage.map(P) }, properties: { ...props, feature: 'frontage' } })
  }
  return { type: 'FeatureCollection', crs: geo ? 'EPSG:4326' : 'scene-m', scene: survey.scene, features }
}

/** CSV 单元格转义: 有逗号 / 引号 / 换行就整个加引号，里面的引号写两遍 */
function csvCell(v) {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/**
 * 导出 CSV（一店一行，位置取第一扇门）；开头加 BOM，Excel 打开中文不乱码
 * 有地理位置时给经纬度，没有时给场景米
 */
export function toCSV(survey, geo) {
  const head = ['编号', '楼', '网格', '店名', '业态', '楼层', '营业时间', '备注', geo ? '门口经度' : '门口x(米)', geo ? '门口纬度' : '门口y(米)', '门朝向', '门数', '面积(㎡)', '临街长度(米)', '标注人', '时间']
  const rows = liveShops(survey).map((s) => {
    const d = s.doors?.[0]
    const p = d ? (geo ? geo.toLonLat(d.pos[0], d.pos[1]).map((v) => v.toFixed(7)) : d.pos) : ['', '']
    return [s.id, s.building || '', s.cell || '', s.name || '', catName(s.category), s.floor || '', s.hours || '', s.note || '', p[0], p[1], dirName(d), (s.doors || []).length, s.area ?? '', s.frontageLen ?? '', s.by || '', s.t ? new Date(s.t).toISOString() : '']
  })
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
}
