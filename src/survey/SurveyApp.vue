<script setup>
// 实地标注工具（手机 / 平板 / 电脑网页）: 甲方的考察人员在现场，在一张「涂色板」上把每家商户涂出来。
//   底图     卫星图生成的简化二维示意图（场景里的路面、绿地水面、楼轮廓），不放卫星照片；叠 1 米网格
//   涂色     每格 1 米 × 1 米；上下左右相邻、同一个颜色的一片格子 = 一家商户（色块）
//   工具     选择、平移、画笔、橡皮、矩形划区、多边形划区、油漆桶（点色块换色 / 点楼里空白填满这栋楼）、门口、吸管；撤销重做
//   门口     点在色块边缘的格点上，自动吸附并取朝外的方向；在拐角上再点一下换朝向；一家店可以有多扇门
//   网格     50 米一格的考察分工（A01…），屏幕中心十字所在的格子可以改状态；画板也按这 50 米一块同步
//   存储     每次改动先存本机（没网也不丢），「同步」时传给导入服务合并（几台手机各画各的格子）
//   输出     导出 GeoJSON（色块轮廓 + 门）/ CSV；「写回仿真」生成带实测门口的新场景
// 画板、连通块、门口校验、编号延续等纯逻辑在 board.js，数据 / 坐标 / 导出在 model.js（都有单元测试），这里只管交互和绘制。
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue' // Vue 组合式 API
import * as M from './model.js' // 网格编号 / 坐标 / 数据 / 导出
import * as B from './board.js' // 涂色板

// ---------------------------------------------------------------------------
// 场景、画板与标注数据
// ---------------------------------------------------------------------------
const sceneId = new URLSearchParams(location.search).get('scene') || 'district' // 和三维页同一套场景 id
const sceneUrl = new URL(`/scenes/${sceneId}.json`, location.href) // 场景文件地址
const scene = shallowRef(null) // scene.json 内容（很大，不需要深层响应）
const loadError = ref('') // 读场景失败时的提示
const geo = computed(() => (scene.value ? M.makeGeo(scene.value.origin) : null)) // 没有地理位置时为 null
// 画板和连通块结果很大（几百万格），不放进 Vue 的响应式；改完后把 rev 加一，依赖它的计算属性就会重算
let board = null // B.makeBoard 的结果
let labeled = null // B.label 的结果: {labels, comps}
let owner = new Map() // 块号 → 商户编号
const rev = ref(0) // 画板 / 连通块的版本号
const grid = shallowRef(null) // 50 米考察网格，和画板的分块对齐
// 标注数据按「原始场景」存: 在写回后的场景（-surveyed）上继续标，还是同一份
const surveyKey = computed(() => scene.value?.surveyOf || sceneId) // 写回后的场景带 surveyOf，指回原场景
const survey = ref(M.emptySurvey(sceneId)) // 先放一份空白的，onMounted 里换成本机存的
const surveyor = ref(readLocal('view3d-surveyor') || '') // 标注人姓名 / 代号，记进每条修改

/** localStorage 读（隐私模式等情况下会抛异常，当成没有） */
function readLocal(k) {
  try {
    return localStorage.getItem(k) // 没存过返回 null
  } catch {
    return null // 当成没存过
  }
}

/** localStorage 写（失败不影响使用，只是刷新后会丢；同步到服务器的不会丢） */
function writeLocal(k, v) {
  try {
    localStorage.setItem(k, v) // 整份 JSON 存一个键
  } catch {
    /* 存储满了 / 被禁用 */
  }
}

const storeKey = () => `view3d-survey:${surveyKey.value}` // 本地存储的键（第 1 版数据也在这个键下，读进来照样能用）
watch(survey, (v) => writeLocal(storeKey(), JSON.stringify(v))) // survey 每次都整体替换，浅监听就够
watch(surveyor, (v) => writeLocal('view3d-surveyor', v)) // 下次打开不用再填名字

// ---------------------------------------------------------------------------
// 连通块 → 商户记录
// ---------------------------------------------------------------------------
const labelOf = computed(() => (rev.value, new Map([...owner].map(([L, id]) => [id, L])))) // 商户编号 → 块号
let bldBoxes = [] // 每栋楼的外包框，点选楼时先用框筛一遍（楼多、每次改完所有色块都要找所在楼）
const infoCache = new Map() // 色块签名 → 派生字段，形状没变的色块不用重算

/** (x, y) 在哪栋楼里（后画的楼优先，和 model.buildingAt 一致）；先比外包框再做射线法 */
function buildingAtFast(x, y) {
  for (let k = bldBoxes.length - 1; k >= 0; k--) {
    const [b, x0, y0, x1, y1] = bldBoxes[k] // 楼和它的外包框
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && B.inPoly(b.polygon, x, y)) return b // 外包框里再做精确判断
  }
  return null
}

/**
 * 色块的派生字段（写进商户记录，写回仿真和导出直接用）:
 *   building 所在的楼（色块中心在哪栋楼里；L 形等中心落在外面的，抽样投票）
 *   cell     所在的 50 米考察格；center 色块中心（米）
 */
function info(comp) {
  const sig = `${comp.color}|${comp.seed}|${comp.count}|${comp.c0},${comp.r0},${comp.c1},${comp.r1}` // 形状签名
  if (infoCache.has(sig)) return infoCache.get(sig) // 同样的形状算过了
  let b = buildingAtFast(comp.cx, comp.cy) // 先看中心
  if (!b) { // 中心不在任何楼里
    const votes = new Map(), step = Math.max(1, Math.floor(comp.count / 40)) // 最多抽 40 格投票
    for (let n = 0; n < comp.cells.length; n += step) {
      const k = comp.cells[n], c = k % board.w, r = (k - c) / board.w // 抽到的格子
      const hit = buildingAtFast(board.x0 + c + 0.5, board.y0 + r + 0.5) // 它在哪栋楼里
      if (hit) votes.set(hit, (votes.get(hit) || 0) + 1) // 这栋楼得一票
    }
    b = [...votes].sort((p, q) => q[1] - p[1])[0]?.[0] || null // 票最多的楼；都不在楼里就是 null（写回时跳过）
  }
  const out = { building: b?.id || null, cell: M.cellAt(grid.value, comp.cx, comp.cy), center: [Math.round(comp.cx * 10) / 10, Math.round(comp.cy * 10) / 10] } // 中心坐标保留 1 位小数
  infoCache.set(sig, out) // 记进缓存
  return out
}

/**
 * 给有变化的商户记上标注人和时间，并各记一条日志（同步时按时间取新，所以改了就必须换时间）
 * @param s       当前的 survey
 * @param shops   新的商户列表
 * @param changed 有变化的商户编号
 */
function stamp(s, shops, changed) {
  if (!changed.size) return { ...s, shops } // 没变化: 只换列表（顺序可能变了）
  const now = Date.now(), by = surveyor.value // 这一批统一的时间和人
  const old = new Set(s.shops.map((x) => x.id)) // 原来就有的编号，区分新增和修改
  const next = shops.map((x) => (changed.has(x.id) ? { ...x, by, t: now } : x)) // 有变化的才换人和时间
  const log = [...s.log] // 日志追加在后面
  for (const x of next) if (changed.has(x.id)) log.push({ t: now, by, action: x.deleted ? 'delete' : old.has(x.id) ? 'edit' : 'add', id: x.id })
  return { ...s, shops: next, log }
}

/**
 * 重新找连通块，把商户记录对上号（board.reconcile），返回更新后的 survey
 * @param usePrev true = 刚画了一笔，按「和改之前重叠最多」对号；false = 刚打开 / 同步 / 撤销，按种子格对号
 */
function relabel(s, usePrev) {
  const lb = B.label(board) // 新的连通块
  const prev = usePrev && labeled ? { labels: labeled.labels, owner } : null // 上一次的结果
  const out = B.reconcile(board, lb, s.shops, prev, { newId: () => M.newShopId(), info }) // 对号，新店用时间 + 随机数编号
  labeled = lb // 记下来给下一次对号、点选用
  owner = out.owner // 块号 → 编号
  rev.value++ // 通知计算属性
  return stamp(s, out.shops, out.changed) // 有变化的商户记人和时间
}

const liveBoardShops = computed(() => survey.value.shops.filter((s) => !s.deleted && s.seed)) // 画板上现有的商户
const shopById = computed(() => new Map(liveBoardShops.value.map((s) => [s.id, s]))) // 编号 → 记录

// ---------------------------------------------------------------------------
// 同步（导入服务 tools/sat_server.py 的 /api/survey）
// ---------------------------------------------------------------------------
const sync = reactive({ state: 'idle', at: 0, msg: '' }) // state: idle | busy | ok | fail；at = 上次成功同步的时间
const pending = computed(() => survey.value.log.filter((e) => e.t > sync.at).length) // 上次同步以后本机改了几处

/** 上传本机数据，服务器合并后把完整数据发回来，用它替换本机的（这样也拿到了别人画的） */
async function doSync() {
  sync.state = 'busy' // 按钮置灰，防止连点
  try {
    const r = await fetch('/api/survey?scene=' + encodeURIComponent(surveyKey.value), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(survey.value),
    })
    const j = await r.json() // 服务器合并后的完整数据
    if (!r.ok || j.error) throw new Error(j.error || r.status) // HTTP 错误或服务端校验不过
    // 旧版导入服务不认识 tiles，合并时会把画板丢掉；这时绝不能用它的结果覆盖本机，否则画好的色块全没了
    if (!j.tiles) { // 回来的数据没有画板分块
      sync.state = 'fail' // 按钮变红
      sync.msg = '导入服务版本太旧（不支持涂色板），请重启 python tools/sat_server.py；数据仍在本机'
      return // 本机数据不动
    }
    const tilesChanged = JSON.stringify(j.tiles || {}) !== JSON.stringify(survey.value.tiles || {}) // 别人改过画板没有
    survey.value = j // 用合并结果替换本机的，别人标的也有了
    if (tilesChanged && board) reloadBoard() // 画板换成合并后的
    sync.state = 'ok' // 按钮显示「已同步」
    sync.at = Date.now() // 之后的修改才算「未同步」
    sync.msg = '' // 清掉上次的错误提示
  } catch {
    // 没网 / 服务没开: 数据还在本机，等有网再点同步
    sync.state = 'fail' // 按钮变红「重试同步」
    sync.msg = '同步失败，数据已存在本机'
  }
}

/** 写回仿真: 服务器用最新标注生成 imported/<名字>-surveyed 场景 */
const applied = ref('') // 生成的场景 id，有了就显示「打开仿真」链接
async function applyToSim() {
  await doSync() // 先同步，保证写回的是最新数据
  if (sync.state !== 'ok') return // 同步失败就不写回，错误提示已经显示了
  const r = await fetch('/api/survey/apply?scene=' + encodeURIComponent(sceneId), { method: 'POST' }) // 服务器生成 -surveyed 场景
  const j = await r.json().catch(() => ({ error: '服务没响应' })) // 代理 502 等返回的不是 JSON
  if (j.error) sync.msg = j.error // 场景不存在等
  else applied.value = j.scene // 显示「打开 …」链接
}

// ---------------------------------------------------------------------------
// 视图: 视口中心 (cx, cy) + 视口宽度 w（米）
// ---------------------------------------------------------------------------
const cv = ref(null) // 画布元素
let ctx = null // 2D 绘图上下文
let dpr = 1 // 设备像素比（高分屏画布要按它放大，线才不糊）
const size = reactive({ w: 1, h: 1 }) // 画布的 CSS 像素尺寸
const view = reactive({ cx: 0, cy: 0, w: 300 }) // 初始值只是占位，读到场景后 fitAll
const viewH = computed(() => (view.w * size.h) / size.w) // 视口高度（米），保持像素是正方形
const scale = computed(() => size.w / view.w) // 一米是多少屏幕像素
const px = computed(() => view.w / size.w) // 一个屏幕像素是多少米: 线宽、点的大小按它换算，缩放时屏幕上大小不变
const centerCell = computed(() => (grid.value ? M.cellAt(grid.value, view.cx, view.cy) : null)) // 屏幕中心十字所在的考察格

/** 屏幕像素坐标 → 场景米 */
function toScene(clientX, clientY) {
  const r = cv.value.getBoundingClientRect() // 画布在页面上的位置
  return [view.cx + ((clientX - r.left) / r.width - 0.5) * view.w, view.cy + ((clientY - r.top) / r.height - 0.5) * viewH.value] // 按比例从视口左上角算过去
}

/** 以屏幕上某点为不动点缩放（k > 1 放大）；最近看 8 米宽（一格一米看得很清楚），最远两倍场景宽 */
function zoomAt(clientX, clientY, k) {
  const [x, y] = toScene(clientX, clientY) // 手指下面的场景点，缩放前后保持不动
  const maxW = board ? board.w * 2 : 5000 // 最多缩到两倍场景宽
  const w = Math.min(maxW, Math.max(8, view.w / k)) // 截到上下限
  const f = w / view.w // 实际缩放比
  view.cx = x + (view.cx - x) * f // 不动点公式: 新中心 = 手指 + (旧中心 - 手指) × 缩放比
  view.cy = y + (view.cy - y) * f // 纵向同理
  view.w = w // 新的视口宽度
}

/** 缩放到整个场景 */
function fitAll() {
  if (!board) return // 场景还没读到
  view.cx = board.x0 + board.w / 2 // 视口中心放到画板中心
  view.cy = board.y0 + board.h / 2 // 纵向居中
  view.w = Math.max(board.w, (board.h * size.w) / size.h) * 1.05 // 宽高都装得下，留 5% 边
}

// ---------------------------------------------------------------------------
// 绘制: 底图（示意图）→ 涂色层 → 网格 → 选中轮廓 → 门 → 工具预览 → 定位
// ---------------------------------------------------------------------------
// 示意图配色: 浅灰地面、白楼、淡绿绿地、淡蓝水面；饱和的颜色都留给商户色块
const BG = '#eef0f3' // 场地外 / 画布底色
const AREA_FILL = { green: '#d5ead0', park: '#d5ead0', water: '#c9def0', parking: '#e1e3e8', plaza: '#ece7de' } // 区域按种类上色
let base = null // 底图的 Path2D 缓存（坐标是米，画的时候套视图变换）
let paintCv = null, paintImg = null, paintU32 = null // 涂色层: 一格一个像素的离屏画布，放大画上去（不插值，格子边缘锐利）
const RGBA = B.PALETTE.map((hex) => (hex ? packRGBA(hex) : 0)) // 颜色号 → ImageData 里的 32 位像素值；0 = 透明

/** '#rrggbb' → 小端 Uint32 像素（内存顺序 R G B A，所以数值是 A<<24 | B<<16 | G<<8 | R） */
function packRGBA(hex) {
  const n = parseInt(hex.slice(1), 16) // 0xRRGGBB
  return ((255 << 24) | ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)) >>> 0 // 不透明
}

/** 把场景的多边形图层拼成 Path2D（带洞的用 evenodd 填）；只在读到场景时做一次 */
function buildBase(sc) {
  const rings = (path, poly) => { poly.forEach(([x, y], k) => (k ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath() } // 一个环
  const polys = (list) => { const p = new Path2D(); for (const it of list || []) { rings(p, it.polygon); for (const h of it.holes || []) rings(p, h) } return p } // 一层多边形
  const areas = {} // 种类 → Path2D
  for (const a of sc.areas || []) (areas[a.kind] ||= []).push(a) // 按种类分组
  const lanes = new Map() // 路宽 → 这种宽度的所有路的 Path2D（同宽的路一次描完）
  for (const l of sc.lanes || []) { // 路按宽度分组
    const w = Math.round(l.width * 2) / 2 // 按半米归并，减少描边次数
    const p = lanes.get(w) || new Path2D() // 这种宽度的路径
    l.points.forEach(([x, y], k) => (k ? p.lineTo(x, y) : p.moveTo(x, y))) // 折线逐点连
    lanes.set(w, p) // 存回去
  }
  return {
    site: polys(sc.site), pavement: polys(sc.pavement), // 场地、人行铺装
    areas: Object.entries(areas).map(([k, list]) => [AREA_FILL[k] || '#e5e7eb', polys(list)]), // 区域
    lanes: [...lanes], buildings: polys(sc.buildings), // 路面、楼
  }
}

/** 整个涂色层按画板重画（读到场景 / 同步后） */
function rebuildPaint() {
  paintCv = document.createElement('canvas') // 一格一像素
  paintCv.width = board.w // 宽 = 画板列数
  paintCv.height = board.h // 高 = 画板行数
  const pctx = paintCv.getContext('2d') // 离屏画布的上下文
  paintImg = pctx.createImageData(board.w, board.h) // 像素缓冲
  paintU32 = new Uint32Array(paintImg.data.buffer) // 按 32 位整块写，比逐通道快
  for (let k = 0; k < board.data.length; k++) paintU32[k] = RGBA[board.data[k]] // 每格填颜色
  pctx.putImageData(paintImg, 0, 0) // 一次拷进离屏画布
  requestDraw() // 画到屏幕上
}

/** 只更新改过的格子（按外包框局部 putImageData） */
function updatePaint(idx) {
  if (!idx.length) return // 没有改动
  let c0 = board.w, r0 = board.h, c1 = -1, r1 = -1 // 改动范围
  for (const k of idx) {
    paintU32[k] = RGBA[board.data[k]] // 这格的新颜色
    const c = k % board.w, r = (k - c) / board.w // 下标拆回行列
    if (c < c0) c0 = c // 扩大外包框
    if (c > c1) c1 = c
    if (r < r0) r0 = r
    if (r > r1) r1 = r
  }
  paintCv.getContext('2d').putImageData(paintImg, 0, 0, c0, r0, c1 - c0 + 1, r1 - r0 + 1) // 只拷这一块
  requestDraw() // 画到屏幕上
}

let raf = 0 // 待执行的重画帧
/** 请求下一帧重画（一帧里多次请求只画一次） */
function requestDraw() {
  if (!raf) raf = requestAnimationFrame(draw) // 同一帧只排一次
}

/** 画一帧 */
function draw() {
  raf = 0 // 这一帧已经开始画
  if (!ctx) return // 还没挂载
  const W = size.w, H = size.h, s = scale.value, p = px.value // 画布尺寸、米→像素、像素→米
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // 先按屏幕像素清屏
  ctx.fillStyle = BG // 底色
  ctx.fillRect(0, 0, W, H)
  if (!board || !base) return // 场景还没读到
  const ox = view.cx - view.w / 2, oy = view.cy - viewH.value / 2 // 视口左上角（米）
  ctx.setTransform(dpr * s, 0, 0, dpr * s, -ox * s * dpr, -oy * s * dpr) // 之后都用米画
  // 底图: 场地 → 铺装 → 区域 → 路面 → 楼
  ctx.fillStyle = '#f7f7f5' // 场地: 近白
  ctx.fill(base.site, 'evenodd')
  ctx.fillStyle = '#e6e8ec' // 人行铺装: 浅灰
  ctx.fill(base.pavement, 'evenodd')
  for (const [color, path] of base.areas) { ctx.fillStyle = color; ctx.fill(path, 'evenodd') } // 绿地 / 水面 / 停车场
  ctx.strokeStyle = '#d3d7de' // 路面: 灰
  ctx.lineCap = 'round' // 路端圆头
  ctx.lineJoin = 'round'
  for (const [w, path] of base.lanes) { ctx.lineWidth = w; ctx.stroke(path) } // 路宽就是描边宽（米）
  ctx.fillStyle = '#ffffff' // 楼: 白底
  ctx.fill(base.buildings, 'evenodd')
  ctx.strokeStyle = '#94a3b8' // 楼轮廓: 灰蓝细线
  ctx.lineWidth = 1.2 * p // 1.2 个屏幕像素
  ctx.stroke(base.buildings)
  // 涂色层: 一格一像素放大，关掉平滑
  ctx.imageSmoothingEnabled = false // 放大不插值，格子边缘锐利
  ctx.globalAlpha = 0.85 // 稍透一点，楼的轮廓线还看得见
  ctx.drawImage(paintCv, board.x0, board.y0, board.w, board.h) // 一格一像素铺到画板位置
  ctx.globalAlpha = 1 // 恢复不透明
  drawGrid(ox, oy, p, s) // 网格和考察格
  drawSelection(p) // 选中商户的轮廓
  drawDoors(p, s) // 门口
  drawPreview(p) // 工具预览
  if (me.value) { // 我的位置: 精度圈 + 蓝点
    ctx.fillStyle = 'rgba(59,130,246,0.15)' // 精度圈
    ctx.beginPath(); ctx.arc(me.value.x, me.value.y, me.value.acc, 0, 7); ctx.fill()
    ctx.fillStyle = '#2563eb'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * p // 蓝点白边
    ctx.beginPath(); ctx.arc(me.value.x, me.value.y, 6 * p, 0, 7); ctx.fill(); ctx.stroke()
  }
}

/**
 * 网格: 1 米细线（放大到一米 ≥ 6 像素才画，否则糊成一片）、10 米中线、50 米考察格粗线 + 状态底色 + 编号
 * 线都对齐画板原点，所以 50 米线正好是分块边界
 */
function drawGrid(ox, oy, p, s) {
  const bx0 = board.x0, by0 = board.y0, bx1 = bx0 + board.w, by1 = by0 + board.h // 画板范围
  const vx0 = Math.max(bx0, ox), vy0 = Math.max(by0, oy) // 可见部分
  const vx1 = Math.min(bx1, ox + view.w), vy1 = Math.min(by1, oy + viewH.value) // 可见部分的右下角
  if (vx1 <= vx0 || vy1 <= vy0) return // 画板不在视野里
  const lines = (step, color, width) => { // 画一种间距的线
    ctx.beginPath() // 一种间距一条路径
    for (let x = bx0 + Math.ceil((vx0 - bx0) / step) * step; x <= vx1; x += step) { ctx.moveTo(x, vy0); ctx.lineTo(x, vy1) }
    for (let y = by0 + Math.ceil((vy0 - by0) / step) * step; y <= vy1; y += step) { ctx.moveTo(vx0, y); ctx.lineTo(vx1, y) }
    ctx.strokeStyle = color // 线色
    ctx.lineWidth = width // 线宽
    ctx.stroke() // 一次描完
  }
  // 考察格状态底色
  const g = grid.value // 50 米考察网格
  for (const c of g.cells) {
    if (c.x1 < vx0 || c.x0 > vx1 || c.y1 < vy0 || c.y0 > vy1) continue // 不在视野里
    const st = survey.value.cells[c.id]?.status // 这一格的考察状态
    if (CELL_FILL[st]) { ctx.fillStyle = CELL_FILL[st]; ctx.fillRect(c.x0, c.y0, g.size, g.size) }
  }
  if (s >= 6) lines(1, 'rgba(30,41,59,0.13)', p) // 1 米格
  if (s >= 1.2) lines(10, 'rgba(30,41,59,0.25)', p) // 10 米
  lines(B.TILE, 'rgba(15,23,42,0.55)', 1.5 * p) // 50 米考察格
  // 当前格（屏幕中心十字所在）加粗
  const cur = g.cells.find((c) => c.id === centerCell.value) // 屏幕中心所在的格
  if (cur) { ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2.5 * p; ctx.strokeRect(cur.x0, cur.y0, g.size, g.size) }
  // 编号: 白字黑边，写在左上角
  if (B.TILE * s >= 40) { // 格子太小时不写，免得挤成一团
    ctx.font = `${11 * p}px system-ui, sans-serif` // 11 像素的字
    ctx.textBaseline = 'top' // 从左上角往下写
    ctx.lineWidth = 3 * p // 白色描边
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.fillStyle = '#334155'
    for (const c of g.cells) { // 每个可见的格子写编号
      if (c.x1 < vx0 || c.x0 > vx1 || c.y1 < vy0 || c.y0 > vy1) continue // 不在视野里
      ctx.strokeText(c.id, c.x0 + 3 * p, c.y0 + 3 * p)
      ctx.fillText(c.id, c.x0 + 3 * p, c.y0 + 3 * p)
    }
  }
}

/** 选中的商户: 轮廓描一圈白边 + 深色线 */
function drawSelection(p) {
  const o = selOutline.value // 选中店的轮廓
  if (!o) return // 没选中
  const path = new Path2D() // 外轮廓和洞一起描
  for (const ring of [...o.outer, ...o.holes]) { ring.forEach(([x, y], k) => (k ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath() }
  ctx.lineJoin = 'miter' // 直角不削边
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4 * p; ctx.stroke(path) // 白底
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2 * p; ctx.stroke(path) // 深色线
}

/** 门: 格点上一个白圆点 + 朝外的箭头；选中店的门是深色。缩得很小时（一米不到 1.5 像素）不画 */
function drawDoors(p, s) {
  if (s < 1.5) return // 缩得太小
  const x0 = view.cx - view.w / 2 - 2, x1 = view.cx + view.w / 2 + 2 // 视野（多留 2 米）
  const y0 = view.cy - viewH.value / 2 - 2, y1 = view.cy + viewH.value / 2 + 2 // 视野上下边
  // 场景自动生成的门（参考）: 小灰点，放大后才画
  if (s >= 4) { // 放大到一米 4 像素以上
    ctx.fillStyle = 'rgba(100,116,139,0.6)' // 灰点
    for (const d of scene.value.doors || []) {
      const [x, y] = d.pos // 门的位置
      if (x < x0 || x > x1 || y < y0 || y > y1) continue // 不在视野里
      ctx.beginPath(); ctx.arc(x, y, 2.5 * p, 0, 7); ctx.fill()
    }
  }
  const L = Math.max(0.9, 13 * p), r = 4.5 * p // 箭头长度（至少 0.9 米）、圆点半径
  for (const shop of liveBoardShops.value) { // 每家店
    const sel = shop.id === selectedId.value // 选中的店
    for (const d of shop.doors || []) { // 每扇门
      const [x, y] = d.pos, [nx, ny] = B.DIRS[d.dir] // 格点位置和朝向
      if (x < x0 || x > x1 || y < y0 || y > y1) continue // 不在视野里
      const ink = sel ? '#0f172a' : '#1e293b' // 箭头颜色
      ctx.strokeStyle = ink // 箭杆颜色
      ctx.fillStyle = ink // 箭头颜色
      ctx.lineWidth = (sel ? 2.5 : 1.8) * p // 选中的更粗
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + nx * L, y + ny * L); ctx.stroke() // 箭杆
      const hx = x + nx * L, hy = y + ny * L, a = 5 * p // 箭头尖和大小
      ctx.beginPath(); ctx.moveTo(hx + nx * a, hy + ny * a); ctx.lineTo(hx - ny * a, hy + nx * a); ctx.lineTo(hx + ny * a, hy - nx * a); ctx.closePath(); ctx.fill() // 三角形箭头
      ctx.fillStyle = sel ? '#facc15' : '#fff' // 圆点: 选中的店黄色
      ctx.lineWidth = 1.5 * p // 圆点描边
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke()
    }
  }
}

/** 工具预览: 矩形框、多边形已点的顶点、鼠标悬停时的笔刷 / 格点 */
function drawPreview(p) {
  ctx.lineWidth = 1.5 * p // 预览线宽
  ctx.setLineDash([4 * p, 3 * p]) // 虚线表示「还没落下」
  const col = paintValue() ? B.PALETTE[paintValue()] : '#64748b' // 预览用当前颜色（擦除用灰色）
  if (gesture?.rect) { // 矩形划区拖动中
    const { c0, r0, c1, r1 } = gesture.rect // 矩形的两个角（格）
    ctx.strokeStyle = '#0f172a' // 深色边
    ctx.fillStyle = col + '66' // 半透明
    const x = board.x0 + Math.min(c0, c1), y = board.y0 + Math.min(r0, r1) // 左上角
    const w = Math.abs(c1 - c0) + 1, h = Math.abs(r1 - r0) + 1 // 宽高（格）
    ctx.fillRect(x, y, w, h) // 半透明填充
    ctx.strokeRect(x, y, w, h) // 虚线边框
  }
  if (polyPts.value.length) { // 多边形划区: 已点的顶点连线，末点连到鼠标 / 起点
    ctx.strokeStyle = '#0f172a' // 深色线
    ctx.beginPath() // 顶点连线
    polyPts.value.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    if (hover.value) ctx.lineTo(...snapVertex(...hover.value))
    ctx.stroke() // 描出来
    ctx.setLineDash([]) // 顶点圆圈用实线
    ctx.fillStyle = '#fff' // 白底
    for (const [x, y] of polyPts.value) { ctx.beginPath(); ctx.arc(x, y, 4 * p, 0, 7); ctx.fill(); ctx.stroke() }
  }
  ctx.setLineDash([]) // 恢复实线
  if (!hover.value || pointers.size) return // 没有悬停（手机）或者正按着
  const [hx, hy] = hover.value // 悬停位置
  const t = tool.value // 当前工具
  if (t === 'brush' || t === 'eraser') { // 笔刷的方框
    const cell = B.cellAt(board, hx, hy) // 悬停的格子
    if (!cell) return // 在画板外
    const off = Math.floor(brush.value / 2) // 和 brushCells 一样的偏移
    ctx.strokeStyle = '#0f172a' // 深色框
    ctx.strokeRect(board.x0 + cell[0] - off, board.y0 + cell[1] - off, brush.value, brush.value)
  } else if (t === 'door' || t === 'poly') { // 会吸到的格点
    const [x, y] = snapVertex(hx, hy) // 吸到的格点
    ctx.strokeStyle = '#0f172a' // 深色圆圈
    ctx.beginPath(); ctx.arc(x, y, 5 * p, 0, 7); ctx.stroke()
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const TOOLS = [
  { id: 'select', t: '选择', icon: '↖', key: 'v' }, // 点色块选商户，改店名等
  { id: 'pan', t: '平移', icon: '✋', key: 'h' }, // 单指拖动地图（其他工具下用双指 / 右键拖）
  { id: 'brush', t: '画笔', icon: '✎', key: 'b' }, // 按住涂
  { id: 'eraser', t: '橡皮', icon: '⌫', key: 'e' }, // 按住擦
  { id: 'rect', t: '矩形', icon: '▭', key: 'r' }, // 拖一个矩形划区
  { id: 'poly', t: '多边形', icon: '⬠', key: 'p' }, // 逐点点出多边形划区（顶点吸到格点）
  { id: 'fill', t: '油漆桶', icon: '◧', key: 'g' }, // 点色块整块换色；点楼里的空白把这栋楼填满
  { id: 'door', t: '门口', icon: '⇥', key: 'd' }, // 在色块边缘的格点上放门
  { id: 'picker', t: '吸管', icon: '◉', key: 'i' }, // 取色块的颜色
]
const tool = ref('brush') // 当前工具
const brush = ref(1) // 笔刷边长（格 = 米）
const BRUSHES = [1, 2, 3, 5, 9] // 可选的笔刷大小
const color = ref(1) // 当前颜色号；0 = 擦除
const hint = ref('') // 屏幕上方的操作提示
const hover = ref(null) // 鼠标悬停的位置（场景米），手机上没有
const polyPts = ref([]) // 多边形划区已点的顶点（场景米）
let prevTool = 'brush' // 吸管用完回到哪个工具

/** 当前工具落下的颜色: 橡皮永远是 0，其余用当前颜色（选了「空白」色也能用矩形 / 多边形 / 油漆桶擦） */
const paintValue = () => (tool.value === 'eraser' ? 0 : color.value)

/** 切工具（多边形画到一半切走就丢掉） */
function setTool(t) {
  if (t === 'picker' && tool.value !== 'picker') prevTool = tool.value // 记下来，吸完回去
  tool.value = t // 换工具
  polyPts.value = [] // 丢掉没画完的多边形
  hint.value = TOOL_HINT[t] || '' // 显示这个工具的用法
  requestDraw() // 预览要换
}
const TOOL_HINT = {
  select: '点色块选中一家商户，在下面填店名、业态', pan: '拖动地图',
  brush: '按住涂色；同色相连的一片 = 一家店', eraser: '按住擦除',
  rect: '拖出一个矩形，涂成当前颜色', poly: '逐个点多边形的顶点（吸到格点），点回起点或按「闭合」完成',
  fill: '点色块: 整块换成当前颜色；点楼里的空白: 把这栋楼填满', door: '点色块边缘的格点放门，箭头朝外；再点同一扇门换朝向',
  picker: '点色块取它的颜色',
}

/** 离 (x, y) 最近的格点的场景坐标 */
function snapVertex(x, y) {
  const [i, j] = B.vertexNear(board, x, y) // 最近的格点
  return B.vertexPos(board, i, j) // 格点的坐标
}

// 撤销 / 重做: 每条记 {diff 格子改动（可为空）, before / after 改动前后的商户列表}
const undoStack = shallowRef([]) // 用 shallowRef 包数组，按钮的禁用状态跟着变
const redoStack = shallowRef([])

/**
 * 一次划区结束: 更新涂色层、写分块、重新对号，并压进撤销栈
 * @returns 有没有实际改动
 */
function commitEdit(edit) {
  const d = B.endEdit(board, edit) // 这次实际改了哪些格
  if (!d.idx.length) return false // 什么都没变（涂了同样的颜色）
  const before = survey.value.shops // 改之前的商户列表（数组是整体替换的，直接留引用）
  afterCells(d.idx, true) // 按重叠对号
  undoStack.value = [...undoStack.value.slice(-99), { diff: d, before, after: survey.value.shops }] // 最多留 100 步
  redoStack.value = [] // 新的操作之后不能再重做
  return true // 有改动
}

/** 格子变了之后: 涂色层、分块编码、连通块对号 */
function afterCells(idx, usePrev) {
  updatePaint(idx) // 先更新像素
  const tiles = {} // 改动涉及的块 → 新的游程编码
  for (const id of B.tilesOfCells(board, idx)) {
    const [r, c] = B.parseTileId(id) // 块编号 → 行列
    tiles[id] = B.encodeTile(board, r, c) // 整块重新编码
  }
  survey.value = relabel(M.setTiles(survey.value, tiles, surveyor.value), usePrev) // 写分块、重新对号
}

const META = ['name', 'category', 'floor', 'hours', 'note'] // 店的属性（撤销只撤形状和门，不撤后来填的店名）

/** 撤销 / 重做时把商户列表换回快照: 属性用现在的，形状和门用快照的；快照里没有的画板商户删掉 */
function restoreShops(snapshot) {
  const cur = new Map(survey.value.shops.map((s) => [s.id, s])) // 现在的记录
  const snapIds = new Set(snapshot.map((s) => s.id)) // 快照里的编号
  const next = snapshot.map((s) => {
    const c = cur.get(s.id) // 同编号的现有记录
    return c ? { ...s, ...Object.fromEntries(META.map((k) => [k, c[k]])) } : s // 保留现在的属性
  })
  for (const c of survey.value.shops) if (!snapIds.has(c.id)) next.push(c.seed && !c.deleted ? { ...c, deleted: true, doors: [] } : c) // 之后新建的店: 删掉
  const changed = new Set(next.filter((s) => B.canon(s) !== B.canon(cur.get(s.id) || {})).map((s) => s.id)) // 真有变化的才换时间
  survey.value = stamp(survey.value, next, changed) // 有变化的记人和时间
}

/** 撤销 */
function undo() {
  const e = undoStack.value.at(-1) // 最近一步
  if (!e) return // 没有可撤销的
  undoStack.value = undoStack.value.slice(0, -1) // 出栈
  if (e.diff) B.undoDiff(board, e.diff) // 格子改回去
  restoreShops(e.before) // 商户列表换回改之前的
  if (e.diff) afterCells(e.diff.idx, false) // 按种子重新对号（快照里的种子对应的正是改之前的画板）
  redoStack.value = [...redoStack.value, e] // 可以重做了
}

/** 重做 */
function redo() {
  const e = redoStack.value.at(-1) // 最近撤销的一步
  if (!e) return // 没有可重做的
  redoStack.value = redoStack.value.slice(0, -1) // 出栈
  if (e.diff) B.redoDiff(board, e.diff) // 格子改成之后的颜色
  restoreShops(e.after) // 商户列表换成改之后的
  if (e.diff) afterCells(e.diff.idx, false) // 按种子对号
  undoStack.value = [...undoStack.value, e] // 又可以撤销了
}

/** 同步拿到别人画的之后: 整块画板按分块重铺，重新对号；撤销栈清掉（画板已经不是撤销记录里的样子了） */
function reloadBoard() {
  board.data.fill(0) // 先清空
  B.loadTiles(board, survey.value.tiles) // 按分块铺
  rebuildPaint() // 涂色层整张重画
  survey.value = relabel(survey.value, false) // 按种子对号
  undoStack.value = [] // 撤销记录失效
  redoStack.value = [] // 重做记录失效
}

// --- 各工具的按下 / 移动 / 抬起 ---
/** 按下 */
function toolDown(g, x, y) {
  const t = tool.value, cell = B.cellAt(board, x, y) // 当前工具和按下的格子
  if (t === 'brush' || t === 'eraser') {
    g.edit = B.beginEdit() // 整个一笔是一次操作
    g.last = cell // 记下这一格，移动时连线
    if (cell) { const cells = B.brushCells(board, cell[0], cell[1], brush.value); B.paint(board, g.edit, cells, paintValue()); updatePaint(cells) }
  } else if (t === 'rect') {
    const [c, r] = clampCell(x, y) // 从画板外拖进来也行
    g.rect = { c0: c, r0: r, c1: c, r1: r } // 起点 = 终点
  }
}

/** 把点截到画板里的格子（矩形拖到画板外时用） */
function clampCell(x, y) {
  return [Math.min(board.w - 1, Math.max(0, Math.floor(x - board.x0))), Math.min(board.h - 1, Math.max(0, Math.floor(y - board.y0)))]
}

/** 移动 */
function toolMove(g, x, y) {
  if (g.edit) { // 画笔 / 橡皮: 和上一个点连成线（手指快时不断）
    const cell = B.cellAt(board, x, y) // 当前格子
    if (!cell) { g.last = null; return } // 移出画板
    const from = g.last || cell // 上一个点（刚进画板时就是自己）
    const cells = B.lineCells(board, from[0], from[1], cell[0], cell[1], brush.value) // 两点之间连线
    B.paint(board, g.edit, cells, paintValue()) // 涂上
    updatePaint(cells) // 只更新像素，抬手时才重新对号
    g.last = cell // 记下来
  } else if (g.rect) {
    const [c, r] = clampCell(x, y) // 截到画板里
    g.rect.c1 = c // 更新矩形的另一角
    g.rect.r1 = r
    requestDraw() // 预览要换
  }
}

/** 抬起；tap = 这次按下几乎没动（当成点一下） */
function toolUp(g, x, y, tap) {
  if (g.edit) return commitEdit(g.edit) // 画笔 / 橡皮: 一笔结束
  if (g.rect) { // 矩形: 落下
    const { c0, r0, c1, r1 } = g.rect // 两个角
    g.rect = null // 清掉预览
    const e = B.beginEdit() // 一次操作
    B.paint(board, e, B.rectCells(board, c0, r0, c1, r1), paintValue()) // 涂上整个矩形
    commitEdit(e) // 对号、进撤销栈
    return requestDraw() // 清掉预览
  }
  if (tap) tapAt(x, y) // 其余工具都是点一下
}

/** 第二根手指按下: 取消正在进行的划区（改成双指缩放） */
function toolCancel(g) {
  if (g.edit) { const d = B.endEdit(board, g.edit); B.undoDiff(board, d); updatePaint(d.idx); g.edit = null } // 已经涂上的格子还原
  g.rect = null // 清掉矩形预览
  requestDraw() // 预览要换
}

/** 点一下 */
function tapAt(x, y) {
  const t = tool.value // 当前工具
  if (t === 'select') return selectAt(x, y) // 选择工具
  if (t === 'picker') { // 吸管: 取色后回到原来的工具
    const cell = B.cellAt(board, x, y), v = cell ? B.get(board, ...cell) : 0
    if (v) color.value = v // 空白格不取
    return setTool(prevTool) // 回到原来的工具
  }
  if (t === 'fill') return bucket(x, y) // 油漆桶
  if (t === 'poly') return polyTap(x, y) // 多边形
  if (t === 'door') return doorTap(x, y) // 门口
}

/** 选择: 先看是不是点到了门（12 像素内），再看点到哪个色块 */
function selectAt(x, y) {
  const r = Math.max(0.3, 12 * px.value) // 门的点选半径
  const hit = liveBoardShops.value.find((s) => (s.doors || []).some((d) => Math.hypot(d.pos[0] - x, d.pos[1] - y) < r)) // 点到了哪家店的门
  if (hit) return (selectedId.value = hit.id) // 选中这家店
  const cell = B.cellAt(board, x, y) // 点到的格子
  const L = cell && labeled ? labeled.labels[cell[1] * board.w + cell[0]] : 0 // 点到的块号
  selectedId.value = L ? owner.get(L) || null : null // 点空白 = 取消选择
}

/** 油漆桶 */
function bucket(x, y) {
  const cell = B.cellAt(board, x, y)
  if (!cell) return // 点在画板外
  const [c, r] = cell, v = B.get(board, c, r), target = paintValue() // 点到的颜色、要涂的颜色
  let cells // 要涂的格子
  if (v) { // 点到色块
    if (v === target) return (hint.value = '已经是这个颜色了') // 颜色一样不用换
    cells = B.floodCells(board, c, r) // 整个色块换色
  } else { // 点到空白
    const bld = buildingAtFast(x, y) // 点在哪栋楼的空白处
    if (bld) { // 在楼里
      const inside = new Set(B.polygonCells(board, bld.polygon, bld.holes || [])) // 这栋楼的格子
      cells = B.floodCells(board, c, r, { within: (cc, rr) => inside.has(rr * board.w + cc) }) // 只在楼里、被已有色块挡住
    } else { // 在楼外
      cells = B.floodCells(board, c, r, { limit: 3000 }) // 楼外空地: 限制大小
      if (!cells) return (hint.value = '这片空地太大了，先用矩形或多边形圈出范围')
    }
    if (!target) return // 空白填空白，没意义
  }
  const e = B.beginEdit() // 一次操作
  B.paint(board, e, cells, target) // 涂上
  if (commitEdit(e)) hint.value = `填了 ${cells.length} 格（${cells.length} ㎡）` // 提示填了多大
}

/** 多边形: 点顶点；点回起点闭合 */
function polyTap(x, y) {
  const p = snapVertex(x, y) // 顶点吸到格点，边界齐整
  const pts = polyPts.value // 已点的顶点
  if (pts.length >= 3 && Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) < Math.max(0.5, 14 * px.value)) return closePoly() // 点回起点
  const last = pts.at(-1) // 上一个顶点
  if (last && last[0] === p[0] && last[1] === p[1]) return // 同一个格点点了两次
  polyPts.value = [...pts, p] // 加一个顶点
  hint.value = pts.length + 1 >= 3 ? `已点 ${pts.length + 1} 个顶点，点回起点或按「闭合」` : '继续点下一个顶点'
  requestDraw() // 预览要换
}

/** 闭合多边形并涂色 */
function closePoly() {
  const pts = polyPts.value // 所有顶点
  polyPts.value = [] // 清掉预览
  if (pts.length < 3) return (hint.value = '至少要 3 个顶点')
  const e = B.beginEdit() // 一次操作
  const cells = B.polygonCells(board, pts) // 多边形盖住的格子
  B.paint(board, e, cells, paintValue()) // 涂上
  if (commitEdit(e)) hint.value = `多边形 ${cells.length} ㎡` // 提示面积
  requestDraw() // 预览要换
}

/** 门口: 放在色块边缘的格点上；点已有的门换到下一个合法朝向 */
function doorTap(x, y) {
  const prefer = selectedId.value ? labelOf.value.get(selectedId.value) || 0 : 0 // 优先给选中的店
  const pd = B.placeDoor(board, labeled.labels, x, y, prefer) // 吸到格点、挑店、挑朝向
  if (!pd) return (hint.value = '门要放在色块边缘的格点上（格子的角）') // 附近没有边缘格点
  const id = owner.get(pd.label), shop = shopById.value.get(id) // 这扇门属于哪家店
  const doors = shop.doors || [] // 这家店现有的门
  const k = doors.findIndex((d) => d.i === pd.i && d.j === pd.j) // 这个格点上已经有门了吗
  let next // 改完的门列表
  if (k >= 0) { // 这个格点已经有门: 换朝向
    if (pd.dirs.length < 2) return (selectedId.value = id, hint.value = `这里只能朝${B.DIR_NAME[pd.dirs[0]]}；要删除在下面的门列表里点 ×`)
    const nd = pd.dirs[(pd.dirs.indexOf(doors[k].dir) + 1) % pd.dirs.length] // 轮到下一个朝向
    next = doors.map((d, m) => (m === k ? { ...d, dir: nd } : d)) // 换成下一个朝向
    hint.value = `门改朝${B.DIR_NAME[nd]}` // 提示新朝向
  } else { // 新的格点: 加门
    next = [...doors, { i: pd.i, j: pd.j, dir: pd.dir }] // 朝向用 placeDoor 挑的
    hint.value = `加了一扇朝${B.DIR_NAME[pd.dir]}的门` + (pd.dirs.length > 1 ? '，在拐角上再点一下换朝向' : '')
  }
  selectedId.value = id // 选中这家店
  setDoors(id, next) // 写进数据
}

/** 改一家店的门（带场景坐标和法线），可撤销 */
function setDoors(id, doors) {
  const shop = shopById.value.get(id) // 这家店现在的记录
  if (!shop) return // 店已经不在了
  const before = survey.value.shops // 改之前的商户列表
  const next = { ...shop, doors: doors.map((d) => ({ i: d.i, j: d.j, dir: d.dir, ...B.doorGeom(board, d) })) } // 门带上坐标和法线
  survey.value = M.upsertShop(survey.value, next, surveyor.value) // 记人、时间、日志
  undoStack.value = [...undoStack.value.slice(-99), { diff: null, before, after: survey.value.shops }] // 进撤销栈
  redoStack.value = [] // 新的操作之后不能再重做
  requestDraw() // 门变了要重画
}

/** 选中的店整块擦掉（可撤销） */
function eraseSelected() {
  const L = labelOf.value.get(selectedId.value) // 选中店的块号
  if (!L) return // 没选中
  const e = B.beginEdit() // 一次操作
  B.paint(board, e, labeled.comps[L].cells, 0) // 整块擦成空白
  commitEdit(e) // 对号（这家店变墓碑）、进撤销栈
  selectedId.value = null // 取消选择
}

/** 自动挑一个和屏幕中心附近都不一样的颜色（新开一家店，免得和旁边的店连成一家） */
function newColor() {
  const [c, r] = clampCell(view.cx, view.cy) // 屏幕中心的格子
  color.value = B.freeColor(board, c, r, Math.max(12, Math.round(view.w / 4)), color.value) // 找周围没用过的颜色
  if (tool.value === 'eraser' || tool.value === 'select' || tool.value === 'pan') setTool('brush') // 换好颜色直接画
  hint.value = '换了一个附近没用过的颜色，画出来就是一家新店' // 提示
}

// ---------------------------------------------------------------------------
// 选中商户与属性表单
// ---------------------------------------------------------------------------
const selectedId = ref(null) // 选中的商户编号
const selShop = computed(() => (selectedId.value ? shopById.value.get(selectedId.value) || null : null)) // 被合并 / 擦掉后自动变 null
const selOutline = computed(() => { // 选中店的轮廓（画描边用）
  rev.value // 画板变了要重算
  const L = selShop.value && labelOf.value.get(selShop.value.id)
  return L ? B.outline(board, labeled.labels, labeled.comps[L]) : null
})
const form = reactive({ name: '', category: 'retail', floor: '1', hours: '', note: '' }) // 表单（改完失焦 / 回车才写进数据）
watch(selectedId, () => { // 换了选中的店: 表单换成它的属性
  for (const k of META) form[k] = selShop.value?.[k] ?? ''
  requestDraw()
})
watch([selOutline, liveBoardShops], requestDraw) // 轮廓 / 门变了要重画

/** 表单写回（只有真的改了才记一条） */
function saveForm() {
  const s = selShop.value // 选中的店
  if (!s || META.every((k) => (s[k] ?? '') === form[k])) return
  survey.value = M.upsertShop(survey.value, { ...s, ...form }, surveyor.value) // 写进数据（记人、时间、日志）
}

/** 删一扇门 */
function removeDoor(k) {
  setDoors(selShop.value.id, selShop.value.doors.filter((_, m) => m !== k)) // 去掉第 k 扇
}

/** 地图移到这扇门并放大 */
function focusDoor(d) {
  Object.assign(view, { cx: d.pos[0], cy: d.pos[1], w: Math.min(view.w, 30) }) // 最多放大到 30 米宽
}

/** 改屏幕中心那一格的考察状态 */
function setCell(status) {
  if (centerCell.value) survey.value = M.setCellStatus(survey.value, centerCell.value, status, surveyor.value) // 十字不在网格里就不改
}
const CELL_FILL = { doing: 'rgba(250,204,21,0.16)', done: 'rgba(34,197,94,0.16)', review: 'rgba(239,68,68,0.18)' } // 考察格状态底色
const statusOf = (id) => survey.value.cells[id]?.status || 'todo' // 没记录就是「未查」

// 进度: 已完成的考察格 / 有楼的考察格，画了几家店
const busyCells = computed(() => {
  if (!grid.value || !scene.value) return new Set() // 场景还没读到
  const s = new Set() // 有楼的格子
  for (const b of scene.value.buildings) s.add(M.cellAt(grid.value, ...M.centroid(b.polygon))) // 按楼的中心算它在哪一格
  s.delete(null) // 网格外的楼不算
  return s // 返回集合
})
const doneCount = computed(() => [...busyCells.value].filter((c) => survey.value.cells[c]?.status === 'done').length) // 有楼且已完成的格子数
const shopCount = computed(() => liveBoardShops.value.length) // 画板上的店数
const doorCount = computed(() => liveBoardShops.value.reduce((n, s) => n + (s.doors || []).length, 0)) // 所有门数

// ---------------------------------------------------------------------------
// 手势: 单指 / 左键 = 当前工具；双指 = 缩放平移；右键 / 中键 / 空格 + 拖 / 平移工具 = 平移；滚轮缩放
// ---------------------------------------------------------------------------
const pointers = new Map() // pointerId → {x, y}
let gesture = null // {mode: tool | pan | pinch, x0, y0, t0, moved, edit, last, rect}
let spaceDown = false // 按住空格临时平移（电脑上）

function onDown(e) {
  cv.value.setPointerCapture(e.pointerId) // 手指移出画布也继续收到 move / up
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }) // 记下起点
  if (pointers.size === 1) { // 第一根手指 / 鼠标
    const pan = e.button === 1 || e.button === 2 || tool.value === 'pan' || spaceDown // 这一下是不是平移
    gesture = { mode: pan ? 'pan' : 'tool', x0: e.clientX, y0: e.clientY, t0: Date.now(), moved: false } // 可能是点一下，也可能是拖
    if (!pan && board) toolDown(gesture, ...toScene(e.clientX, e.clientY)) // 工具开始
  } else { // 第二根手指
    if (gesture?.mode === 'tool') toolCancel(gesture) // 第二根手指: 取消划区，改成缩放
    gesture = { mode: 'pinch', moved: true } // 双指缩放
  }
}

function onMove(e) {
  const p = pointers.get(e.pointerId) // 这根手指上一次的位置
  if (!p) { // 没按下（鼠标悬停）: 只更新预览
    if (board) { hover.value = toScene(e.clientX, e.clientY); requestDraw() } // 只更新悬停预览
    return // 没按下就不处理拖动
  }
  if (gesture?.mode === 'pinch' && pointers.size === 2) { // 双指
    const other = [...pointers.values()].find((q) => q !== p) // 另一根手指
    const d0 = Math.hypot(p.x - other.x, p.y - other.y), d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y) // 两指距离前后
    view.cx -= ((e.clientX - p.x) / 2) * px.value // 两指中点移动 = 平移（这根手指动了一半）
    view.cy -= ((e.clientY - p.y) / 2) * px.value // 纵向同理
    if (d0 > 0) zoomAt((e.clientX + other.x) / 2, (e.clientY + other.y) / 2, d1 / d0) // 距离变大 = 放大
  } else if (gesture?.mode === 'pan') { // 平移
    view.cx -= (e.clientX - p.x) * px.value // 往右拖 = 视口往左移
    view.cy -= (e.clientY - p.y) * px.value // 往下拖 = 视口往上移
  } else if (gesture?.mode === 'tool') { // 工具
    toolMove(gesture, ...toScene(e.clientX, e.clientY)) // 交给当前工具
  }
  p.x = e.clientX // 更新这根手指的位置
  p.y = e.clientY // 纵向同理
  if (gesture && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 8) gesture.moved = true // 超过 8 像素不算点一下
}

function onUp(e) {
  if (!pointers.has(e.pointerId)) return // 不是我们记下的指针
  pointers.delete(e.pointerId) // 这根手指抬起了
  if (pointers.size) return // 还有手指按着
  if (gesture?.mode === 'tool') toolUp(gesture, ...toScene(e.clientX, e.clientY), !gesture.moved && Date.now() - gesture.t0 < 600) // 工具结束（没怎么动、不太久 = 点一下）
  gesture = null // 手势结束
  requestDraw() // 清掉预览
}

/** 滚轮缩放 */
function onWheel(e) {
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)) // 一格滚轮约 15%
}

/** 键盘快捷键（电脑上）: 工具字母、Ctrl+Z / Ctrl+Y、[ ] 笔刷大小、Enter 闭合多边形、Esc 取消、空格平移 */
function onKey(e) {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return // 在填表单
  const k = e.key.toLowerCase() // 统一小写
  if (e.type === 'keyup') { if (k === ' ') spaceDown = false; return } // 松开空格
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo() } // Ctrl+Z 撤销，Ctrl+Shift+Z 重做
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); return redo() } // Ctrl+Y 重做
  if (e.ctrlKey || e.metaKey || e.altKey) return // 别的组合键留给浏览器
  if (k === ' ') { spaceDown = true; e.preventDefault(); return } // 按住空格临时平移
  const t = TOOLS.find((x) => x.key === k) // 工具字母
  if (t) return setTool(t.id) // 切工具
  if (k === '[' || k === ']') { const n = BRUSHES.indexOf(brush.value) + (k === ']' ? 1 : -1); brush.value = BRUSHES[Math.max(0, Math.min(BRUSHES.length - 1, n))]; return requestDraw() } // [ ] 调笔刷大小
  if (k === 'enter' && polyPts.value.length) return closePoly() // 回车闭合多边形
  if (k === 'escape') { polyPts.value = []; selectedId.value = null; hint.value = ''; return requestDraw() } // Esc 取消
  if (k === 'n') return newColor() // N 换新店颜色
}

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------
const me = ref(null) // {x, y, acc}（场景米）
let watchId = null // watchPosition 的句柄
const locating = ref(false) // 定位按钮是否按下

/** 开 / 关定位；第一次拿到位置时把地图移过去 */
function toggleLocate() {
  if (locating.value) { // 已经开着: 关掉
    navigator.geolocation.clearWatch(watchId) // 停止监听
    locating.value = false // 按钮弹起
    me.value = null // 蓝点去掉
    return requestDraw() // 重画
  }
  if (!navigator.geolocation) return (hint.value = '这个浏览器不支持定位') // 不支持定位
  locating.value = true // 按钮按下
  let first = true // 第一次才移地图
  watchId = navigator.geolocation.watchPosition( // 持续监听位置
    (p) => {
      const [x, y] = geo.value.toScene(p.coords.longitude, p.coords.latitude) // GPS 是 WGS84，换成场景米
      me.value = { x, y, acc: p.coords.accuracy } // accuracy = 定位精度（米）
      if (first) Object.assign(view, { cx: x, cy: y, w: Math.min(view.w, 80) }) // 移到自己的位置，放大到能画的尺度
      first = false // 之后不再抢着移地图
      requestDraw() // 蓝点移动
    },
    (err) => { hint.value = '定位失败: ' + (err.code === 1 ? '没有权限（手机上需要 https 访问）' : err.message); locating.value = false },
    { enableHighAccuracy: true, maximumAge: 5000 }, // 高精度，5 秒内的旧位置可以复用
  )
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
/** 让浏览器下载一段文本 */
function download(name, text, type) {
  const a = document.createElement('a') // 临时的下载链接
  a.href = URL.createObjectURL(new Blob([text], { type })) // 文本包成 Blob 地址
  a.download = name // 下载时的文件名
  a.click() // 触发下载
  setTimeout(() => URL.revokeObjectURL(a.href), 1000) // 稍后释放
}
const fileBase = () => surveyKey.value.replace('/', '_') + '-survey' // 下载文件名前缀
/** GeoJSON: 每家店的色块轮廓 + 门 */
function exportGeoJSON() {
  const outlines = new Map([...labelOf.value].map(([id, L]) => [id, B.outline(board, labeled.labels, labeled.comps[L])])) // 每家店的色块轮廓
  download(fileBase() + '.geojson', JSON.stringify(M.toGeoJSON(survey.value, geo.value, outlines), null, 1), 'application/geo+json') // 带轮廓导出
}
const exportCSV = () => download(fileBase() + '.csv', M.toCSV(survey.value, geo.value), 'text/csv') // Excel 能直接打开

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
let ro = null // 尺寸监听器
/** 画布尺寸跟着窗口变（手机横竖屏），按设备像素比放大 */
function resize() {
  const r = cv.value.getBoundingClientRect() // 画布在页面上的大小
  size.w = r.width || 1 // CSS 像素宽
  size.h = r.height || 1 // CSS 像素高
  dpr = window.devicePixelRatio || 1 // 高分屏倍数
  cv.value.width = Math.round(size.w * dpr) // 画布实际像素宽
  cv.value.height = Math.round(size.h * dpr) // 画布实际像素高
  requestDraw() // 尺寸变了要重画
}
watch(view, requestDraw) // 平移缩放都要重画
watch(() => survey.value.cells, requestDraw) // 考察格状态变了

onMounted(async () => {
  ctx = cv.value.getContext('2d') // 2D 上下文
  ro = new ResizeObserver(resize) // 尺寸监听
  ro.observe(cv.value) // 开始监听
  resize() // 先取一次尺寸
  window.addEventListener('keydown', onKey) // 快捷键
  window.addEventListener('keyup', onKey) // 松开空格
  try {
    const r = await fetch(sceneUrl) // 读场景 JSON
    if (!r.ok) throw new Error(r.status) // 404 等
    scene.value = await r.json() // 楼、路、区域、地理位置都在里面
  } catch (e) {
    loadError.value = `读不到场景 ${sceneId}（${e.message}）` // 页面上显示红色提示
    return // 后面都做不了
  }
  const sc = scene.value // 场景
  board = B.makeBoard(sc.bounds) // 1 米格画板
  grid.value = M.makeGrid({ minX: board.x0, minY: board.y0, maxX: board.x0 + board.w, maxY: board.y0 + board.h }, B.TILE) // 考察格和分块对齐
  bldBoxes = sc.buildings.map((b) => { const xs = b.polygon.map((p) => p[0]), ys = b.polygon.map((p) => p[1]); return [b, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] })
  base = buildBase(sc) // 底图路径
  // 先用本机存的数据（没网也能接着画），再和服务器同步一次
  const local = readLocal(storeKey()) // 本机存的标注
  let s = local ? JSON.parse(local) : M.emptySurvey(surveyKey.value) // 没有就从空白开始
  if (!s.tiles) s = { ...s, version: 2, tiles: {} } // 第 1 版数据: 补上画板分块
  B.loadTiles(board, s.tiles) // 铺画板
  rebuildPaint() // 涂色层
  survey.value = relabel(s, false) // 按种子对号
  fitAll() // 整个场景装进屏幕
  hint.value = TOOL_HINT[tool.value] // 显示当前工具的用法
  doSync() // 拿到别人画的
})
onBeforeUnmount(() => {
  ro?.disconnect() // 停止监听尺寸
  if (watchId !== null) navigator.geolocation.clearWatch(watchId) // 停止定位
  window.removeEventListener('keydown', onKey) // 去掉快捷键
  window.removeEventListener('keyup', onKey) // 去掉快捷键
  cancelAnimationFrame(raf) // 取消没画的帧
})
</script>

<template>
  <div class="page">
    <!-- 地图画布: 整屏；touch-action: none 让浏览器别抢手势；右键不弹菜单（右键拖是平移） -->
    <canvas ref="cv" class="map" :class="'t-' + tool" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
      @pointerleave="hover = null; requestDraw()" @wheel.prevent="onWheel" @contextmenu.prevent></canvas>
    <!-- 屏幕中心十字: 「当前考察格」就是它所在的格子 -->
    <div class="cross"></div>

    <!-- 顶栏: 场景、进度、同步、定位、导出 -->
    <div class="top">
      <div class="row">
        <a class="btn" :href="'/?scene=' + sceneId">‹ 仿真</a>
        <b class="title">{{ sceneId }}</b>
        <span class="stat">格 {{ doneCount }}/{{ busyCells.size }} · 店 {{ shopCount }} · 门 {{ doorCount }}</span>
      </div>
      <div class="row">
        <input v-model="surveyor" class="who" placeholder="标注人" />
        <button class="btn" :class="{ warn: sync.state === 'fail' }" :disabled="sync.state === 'busy'" @click="doSync">
          {{ sync.state === 'busy' ? '同步中…' : sync.state === 'fail' ? '重试同步' : pending ? `同步 (${pending})` : sync.state === 'ok' ? '已同步' : '同步' }}
        </button>
        <button class="btn" :class="{ on: locating }" :disabled="!geo" :title="geo ? '' : '这个场景没有经纬度'" @click="toggleLocate">定位</button>
        <button class="btn" @click="fitAll">全图</button>
        <button class="btn" @click="exportGeoJSON">GeoJSON</button>
        <button class="btn" @click="exportCSV">CSV</button>
        <button class="btn" @click="applyToSim">写回仿真</button>
      </div>
      <div v-if="applied || sync.msg" class="row msg">
        <a v-if="applied" :href="'/?scene=' + applied">打开 {{ applied }}</a>
        <span v-if="sync.msg" class="err">{{ sync.msg }}</span>
      </div>
    </div>

    <!-- 左侧工具栏: 工具 + 撤销重做 -->
    <div class="tools">
      <button v-for="t in TOOLS" :key="t.id" class="tool" :class="{ on: tool === t.id }" :title="`${t.t}（${t.key.toUpperCase()}）`" @click="setTool(t.id)">
        <span class="ico">{{ t.icon }}</span><span class="lbl">{{ t.t }}</span>
      </button>
      <button class="tool" :disabled="!undoStack.length" title="撤销（Ctrl+Z）" @click="undo"><span class="ico">↶</span><span class="lbl">撤销</span></button>
      <button class="tool" :disabled="!redoStack.length" title="重做（Ctrl+Y）" @click="redo"><span class="ico">↷</span><span class="lbl">重做</span></button>
    </div>

    <!-- 操作提示 -->
    <div v-if="hint" class="hint" @click="hint = ''">{{ hint }}</div>
    <div v-if="loadError" class="hint err">{{ loadError }}</div>

    <!-- 底部: 调色板 + 笔刷大小，下面是面板 -->
    <div v-if="scene" class="bottom">
      <div class="palette">
        <!-- 0 号「空白」: 用矩形 / 多边形 / 油漆桶擦除 -->
        <button class="sw empty" :class="{ on: color === 0 }" title="空白（擦除）" @click="color = 0"></button>
        <button v-for="(c, k) in B.PALETTE.slice(1)" :key="k" class="sw" :class="{ on: color === k + 1 }" :style="{ background: c }" @click="color = k + 1"></button>
        <button class="btn small" title="换一个附近没用过的颜色（N）" @click="newColor">新店色</button>
        <!-- 画笔 / 橡皮时才显示笔刷大小 -->
        <span v-if="tool === 'brush' || tool === 'eraser'" class="sizes">
          <button v-for="n in BRUSHES" :key="n" class="btn small" :class="{ on: brush === n }" @click="brush = n">{{ n }}m</button>
        </span>
      </div>

      <div class="sheet">
        <!-- 多边形画到一半: 闭合 / 退一点 / 取消 -->
        <template v-if="tool === 'poly' && polyPts.length">
          <div class="row">
            <b>多边形 {{ polyPts.length }} 个顶点</b>
            <button class="btn go" :disabled="polyPts.length < 3" @click="closePoly">闭合</button>
            <button class="btn" @click="polyPts = polyPts.slice(0, -1); requestDraw()">退一点</button>
            <button class="btn" @click="polyPts = []; requestDraw()">取消</button>
          </div>
        </template>
        <!-- 选中了一家店: 属性 + 门列表 -->
        <template v-else-if="selShop">
          <div class="row">
            <span class="chip" :style="{ background: B.PALETTE[selShop.color] }"></span>
            <b>商户</b>
            <span class="sub">{{ selShop.area }} ㎡ · {{ selShop.building ? '楼 ' + selShop.building : '不在楼里' }} · {{ selShop.cell || '' }}</span>
            <button class="btn close" @click="selectedId = null">×</button>
          </div>
          <div class="row">
            <input v-model="form.name" placeholder="店名" class="grow" @change="saveForm" />
            <select v-model="form.category" @change="saveForm"><option v-for="c in M.CATEGORIES" :key="c.id" :value="c.id">{{ c.t }}</option></select>
          </div>
          <div class="row">
            <input v-model="form.floor" placeholder="楼层" class="short" @change="saveForm" />
            <input v-model="form.hours" placeholder="营业时间 如 9:00-22:00" class="grow" @change="saveForm" />
          </div>
          <div class="row"><input v-model="form.note" placeholder="备注" class="grow" @change="saveForm" /></div>
          <div class="row">
            <b>门 {{ (selShop.doors || []).length }}</b>
            <span v-for="(d, k) in selShop.doors" :key="k" class="door-chip" @click="focusDoor(d)">
              朝{{ B.DIR_NAME[d.dir] }} ({{ d.pos[0] }}, {{ d.pos[1] }})<button class="x" title="删除这扇门" @click.stop="removeDoor(k)">×</button>
            </span>
            <button class="btn small" :class="{ on: tool === 'door' }" @click="setTool('door')">+ 门</button>
          </div>
          <div class="row">
            <button class="btn small" @click="color = selShop.color; setTool('brush')">用它的颜色继续画</button>
            <button class="btn small danger" @click="eraseSelected">擦掉这家店</button>
          </div>
        </template>
        <!-- 什么都没选: 当前考察格状态 -->
        <template v-else>
          <div class="row">
            <b>当前格 {{ centerCell || '—' }}</b>
            <span v-if="centerCell && survey.cells[centerCell]" class="sub">{{ survey.cells[centerCell].by }}</span>
            <button v-for="st in M.CELL_STATUS" :key="st.id" class="btn small" :class="{ on: centerCell && statusOf(centerCell) === st.id }" :disabled="!centerCell" @click="setCell(st.id)">{{ st.t }}</button>
          </div>
          <div class="sub">每格 1 米。同色相连 = 一家店；门放在色块边缘的格点上。双指 / 右键拖动平移，滚轮 / 双指缩放。</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 整页: 地图铺满，其余浮在上面 */
.page { position: fixed; inset: 0; font: 13px/1.45 system-ui, 'Microsoft YaHei', sans-serif; color: #1e293b; }
/* 画布: 手势全交给自己处理；光标跟工具走 */
.map { width: 100%; height: 100%; touch-action: none; display: block; background: #eef0f3; cursor: crosshair; }
.map.t-pan { cursor: grab; }
.map.t-select { cursor: default; }
/* 屏幕中心十字 */
.cross { position: fixed; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; pointer-events: none;
  background: linear-gradient(#0f172a, #0f172a) center / 2px 100% no-repeat, linear-gradient(#0f172a, #0f172a) center / 100% 2px no-repeat; opacity: 0.35; }
/* 顶栏 / 底部面板 / 工具栏: 半透明毛玻璃卡片 */
.top, .sheet, .tools, .palette { background: rgba(255, 255, 255, 0.93); backdrop-filter: blur(8px); border-radius: 10px; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.18); }
.top { position: fixed; left: 8px; right: 8px; top: calc(8px + env(safe-area-inset-top)); padding: 6px 8px; }
/* 左侧工具栏: 竖排，图标 + 小字 */
.tools { position: fixed; left: 8px; top: calc(96px + env(safe-area-inset-top)); display: flex; flex-direction: column; padding: 4px; gap: 2px; max-height: calc(100vh - 330px); overflow-y: auto; }
.tool { width: 46px; min-height: 40px; border: 0; border-radius: 7px; background: transparent; display: flex; flex-direction: column; align-items: center; justify-content: center; font: inherit; color: inherit; padding: 2px 0; }
.tool .ico { font-size: 17px; line-height: 1.1; }
.tool .lbl { font-size: 10px; color: #475569; }
.tool.on { background: #1e293b; color: #fff; }
.tool.on .lbl { color: #cbd5e1; }
.tool:disabled { opacity: 0.35; }
/* 底部: 调色板一行 + 面板 */
.bottom { position: fixed; left: 8px; right: 8px; bottom: calc(8px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 6px; }
.palette { display: flex; align-items: center; gap: 5px; padding: 6px 8px; overflow-x: auto; }
/* 色块按钮: 手指好点（28px） */
.sw { flex: none; width: 28px; height: 28px; border-radius: 6px; border: 2px solid rgba(15, 23, 42, 0.15); padding: 0; }
.sw.on { border-color: #0f172a; box-shadow: 0 0 0 2px #fff inset; }
.sw.empty { background: repeating-conic-gradient(#cbd5e1 0 25%, #fff 0 50%) 0 0 / 10px 10px; }
.sizes { display: inline-flex; gap: 4px; margin-left: 4px; }
.sheet { padding: 6px 8px; max-height: 38vh; overflow-y: auto; }
/* 宽屏（电脑 / 横放的平板）: 底部面板靠右、限宽，别挡住一大片地图 */
@media (min-width: 900px) { .bottom { left: auto; width: 560px; } }
.row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 3px 0; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40vw; }
.stat, .sub { color: #64748b; font-size: 12px; }
.stat { margin-left: auto; }
/* 按钮: 至少 32px 高 */
.btn { min-height: 32px; padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; font: inherit; color: inherit; text-decoration: none; display: inline-flex; align-items: center; flex: none; }
.btn.small { min-height: 28px; padding: 2px 8px; font-size: 12px; }
.btn.on, .btn.go { background: #1e293b; color: #fff; border-color: #1e293b; }
.btn.warn { border-color: #dc2626; color: #dc2626; }
.btn.danger { color: #dc2626; }
.btn:disabled { opacity: 0.45; }
.btn.close { margin-left: auto; }
/* 输入框: 16px 字号，iOS 才不会一聚焦就放大整页 */
input, select { font-size: 16px; padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 6px; min-height: 32px; box-sizing: border-box; }
.grow { flex: 1; min-width: 120px; }
.short { width: 64px; }
.who { width: 88px; }
/* 选中店的颜色小方块、门列表的小标签 */
.chip { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(15, 23, 42, 0.3); }
.door-chip { display: inline-flex; align-items: center; gap: 2px; background: #f1f5f9; border-radius: 12px; padding: 1px 4px 1px 9px; font-size: 12px; cursor: pointer; }
.door-chip .x { border: 0; background: transparent; color: #dc2626; font-size: 15px; padding: 0 4px; }
/* 操作提示: 顶栏下面一条深色横幅，点一下消失 */
.hint { position: fixed; left: 50%; top: calc(100px + env(safe-area-inset-top)); transform: translateX(-50%); max-width: 80vw; background: rgba(15, 23, 42, 0.85); color: #fff; padding: 6px 12px; border-radius: 16px; }
.msg a { color: #2563eb; }
.err { color: #dc2626; }
.hint.err { color: #fff; background: rgba(220, 38, 38, 0.9); }
</style>
