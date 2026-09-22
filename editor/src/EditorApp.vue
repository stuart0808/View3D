<script setup>
// 场景编辑器（editor/index.html，地址 /editor/）: 在空白画布或卫星底图上画路、楼、绿地水面、店门和出入口，一键生成场景并在仿真里打开。
//   画路     沿中心线点几下，双击 / 回车结束；每条路可设每方向车道数、单行（按画的方向行驶）、高架；端点自动吸附到已有道路
//   画楼     点出轮廓，双击 / 回车闭合；类型（商铺 / 写字楼 / 住宅 / 场馆）和层数
//   画区域   绿化带 / 公园 / 水体 / 广场 / 停车场
//   点       店门（自动吸附到最近的外墙）、人流出入口
//   选择     点选元素改属性、拖顶点改形状、Delete 删除；撤销 / 重做
//   生成     矢量图交给导入服务（tools/sat_server.py → editor/backend/drawscene.py → tools/map2scene.py），路口、斑马线、红绿灯、人行道自动生成
// 打开方式: /editor/（空白）、/editor/?scene=<场景 id>（在已有场景上改）
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue' // Vue 组合式 API
import * as E from './model.js' // 矢量图的纯函数（几何、吸附、检查）
import { snapToWall } from '../../src/survey/model.js' // 店门吸附外墙沿用实地标注页的函数

// ---------------------------------------------------------------------------
// 矢量图 + 撤销 / 重做
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search) // 地址栏参数
const fromScene = params.get('scene') // 在哪个已有场景上改（null = 空白画布）
const name = ref(params.get('name') || 'my-scene') // 生成的场景名（imported/<名字>）
const d = ref(E.emptyDrawing()) // 当前矢量图
const bgBase = ref('/scenes/imported/') // 底图 url 相对的目录（导入场景的底图和场景文件在同一目录）
const undoStack = [] // 每次修改前的快照（JSON 字符串）
const redoStack = [] // 撤销后的快照，重做用
const dirty = ref(0) // 修改计数，触发自动保存

/** 修改前调用: 存一份快照进撤销栈，清空重做栈 */
function snapshot() {
  undoStack.push(JSON.stringify(d.value)) // 当前状态进撤销栈
  if (undoStack.length > 200) undoStack.shift() // 最多撤销 200 步
  redoStack.length = 0 // 有新修改，重做链断开
  dirty.value++ // 触发自动保存
}

/** 撤销 */
function undo() {
  if (!undoStack.length) return // 没有可撤销的
  redoStack.push(JSON.stringify(d.value)) // 当前状态进重做栈
  d.value = JSON.parse(undoStack.pop()) // 回到上一步
  sel.value = null // 下标可能已经失效
  dirty.value++ // 触发自动保存
}

/** 重做 */
function redo() {
  if (!redoStack.length) return // 没有可重做的
  undoStack.push(JSON.stringify(d.value)) // 当前状态进撤销栈
  d.value = JSON.parse(redoStack.pop()) // 回到下一步
  sel.value = null // 下标可能已经失效
  dirty.value++ // 触发自动保存
}

// 自动保存到本机（刷新 / 关页面不丢）；底图是大 dataUrl 时可能存不下，存不下就算了
// 深度监听整张图（面板里改属性也算），停手 0.5 秒后才写，拖顶点时不会每帧都序列化
const storeKey = () => `view3d-draw:${name.value}` // 每个场景名一份
let saveTimer = null // 防抖定时器
watch(
  [d, dirty], // 矢量图和修改计数都监听
  () => {
    clearTimeout(saveTimer) // 还在改就推迟
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(storeKey(), JSON.stringify(d.value)) // 整张矢量图存一个键
      } catch {
        /* 存储满了（多半是底图太大）: 不影响编辑，只是刷新后要重新载入底图 */
      }
    }, 500) // 停手 0.5 秒
  },
  { deep: true }, // 楼、路的每个点都算
)

// ---------------------------------------------------------------------------
// 视图（和实地标注页同一套: 视口中心 + 视口宽度，单位米）
// ---------------------------------------------------------------------------
const svg = ref(null) // 画布 SVG 元素
const size = reactive({ w: 1, h: 1 }) // SVG 像素尺寸
const view = reactive({ cx: 0, cy: 0, w: 400 }) // 视口中心和宽度（米）
const viewH = computed(() => (view.w * size.h) / size.w) // 视口高度（米）
const viewBox = computed(() => `${view.cx - view.w / 2} ${view.cy - viewH.value / 2} ${view.w} ${viewH.value}`) // x y 宽 高（米）
const px = computed(() => view.w / size.w) // 一个屏幕像素多少米: 线宽、点大小、吸附距离都按它算，缩放时屏幕上不变

/** 屏幕坐标 → 场景米 */
function toScene(e) {
  const r = svg.value.getBoundingClientRect() // SVG 在页面上的位置
  return [view.cx + ((e.clientX - r.left) / r.width - 0.5) * view.w, view.cy + ((e.clientY - r.top) / r.height - 0.5) * viewH.value] // 按比例从视口左上角算过去
}

/** 缩放到整个画布 */
function fitAll() {
  view.cx = 0 // 画布中心就是场景原点
  view.cy = 0 // 画布中心就是场景原点
  view.w = Math.max(d.value.widthM, (d.value.heightM * size.w) / size.h) * 1.08 // 宽高都装得下，留 8% 边
}

/** 滚轮缩放，以鼠标位置为不动点 */
function onWheel(e) {
  const [x, y] = toScene(e) // 鼠标下的场景点，缩放前后保持不动
  const k = Math.exp(e.deltaY * 0.0015) // 往下滚 = 缩小
  const w = Math.min(Math.max(d.value.widthM, d.value.heightM) * 3, Math.max(10, view.w * k)) // 最小看 10 米宽，最大看画布的 3 倍
  const f = w / view.w // 实际缩放比（被上下限截过）
  view.cx = x + (view.cx - x) * f // 不动点公式
  view.cy = y + (view.cy - y) * f // 不动点公式
  view.w = w // 新的视口宽度
}

// 网格线: 放大时 10 米一格，缩小时 50 米一格；只画画布范围内
const gridStep = computed(() => (view.w < 300 ? 10 : 50)) // 放大时细格，缩小时粗格
const gridLines = computed(() => {
  const s = gridStep.value, W = d.value.widthM / 2, H = d.value.heightM / 2, out = [] // 格子边长、画布半宽半高、线段列表
  for (let x = Math.ceil(-W / s) * s; x <= W; x += s) out.push([x, -H, x, H]) // 竖线
  for (let y = Math.ceil(-H / s) * s; y <= H; y += s) out.push([-W, y, W, y]) // 横线
  return out // 每条线 [x1, y1, x2, y2]
})

// ---------------------------------------------------------------------------
// 工具与交互
// ---------------------------------------------------------------------------
const TOOLS = [ // 左侧工具栏；key 是快捷键，tip 是状态栏提示
  { id: 'select', t: '选择', key: 'v', tip: '点选元素改属性；拖顶点改形状；拖空白处平移' },
  { id: 'road', t: '道路', key: 'r', tip: '沿中心线点几下，双击或回车结束；端点会吸到已有道路上；按住 Shift 取 45° 方向' },
  { id: 'building', t: '建筑', key: 'b', tip: '点出轮廓，双击或回车闭合；按住 Shift 取 45° 方向' },
  { id: 'area', t: '区域', key: 'a', tip: '绿化带 / 公园 / 水体 / 广场 / 停车场，点出轮廓后双击闭合' },
  { id: 'door', t: '店门', key: 'd', tip: '点在楼边上，自动贴到最近的外墙' },
  { id: 'portal', t: '出入口', key: 'p', tip: '人流从这里进出场景，点在人行区域（不标就自动放在路口和图边）' },
] // 工具表结束
const tool = ref('select') // 当前工具
// 新画元素的默认属性（右侧面板里改）
const defaults = reactive({ lanes: 1, oneway: false, elevated: false, kind: 'shop', floors: 2, areaKind: 'green' }) // 单行按画的方向；层数跟着类型的默认值
const drawing = ref(null) // 正在画的折线 / 多边形的点列（还没提交）
const cursor = ref(null) // 鼠标位置（场景米，已吸附）
const snapHit = ref(null) // 当前吸附到的点（画路时显示一个圈）
const sel = ref(null) // 选中的元素 {type, index}
const hint = ref('') // 状态栏的操作提示
const selItem = computed(() => (sel.value ? d.value[sel.value.type][sel.value.index] : null)) // 选中的元素本身

/** 切换工具: 丢掉画了一半的东西 */
function setTool(t) {
  tool.value = t // 切换
  drawing.value = null // 丢掉画了一半的点
  snapHit.value = null // 清掉吸附圈
  if (t !== 'select') sel.value = null // 换成画图工具时取消选择
  hint.value = TOOLS.find((x) => x.id === t).tip // 状态栏显示这个工具的用法
}

/** 画线 / 画面时鼠标所在位置 → 吸附后的点（道路吸已有道路；Shift 取 45°） */
function placePoint(p, e) {
  snapHit.value = null // 先清掉上一次的吸附
  if (tool.value === 'road') { // 只有画路时吸附已有道路
    const s = E.snapToRoads(d.value, p, 12 * px.value) // 12 个屏幕像素内吸附
    if (s) { // 吸到了
      snapHit.value = s.p // 显示吸附圈
      return s.p // 用吸附后的点
    }
  }
  const pts = drawing.value // 已经点下的点
  if (e.shiftKey && pts?.length) return E.snapAngle(pts[pts.length - 1], p) // 取 45° 整数倍方向
  return p // 不吸附
}

let drag = null // 当前拖动: {kind: 'pan' | 'vertex', ...}

function onDown(e) {
  if (e.button === 1 || (e.button === 0 && e.altKey)) return startPan(e) // 中键 / Alt+左键: 任何工具下都能平移
  if (e.button !== 0) return // 只处理左键
  const p = toScene(e) // 按下的位置（场景米）
  if (tool.value === 'select') { // 选择工具
    // 先看是不是按在选中元素的顶点上: 拖动改形状
    const v = vertexAt(p) // 按在选中元素的顶点上？
    if (v) { // 是: 开始拖顶点
      snapshot() // 拖之前存快照，一次拖动算一步撤销
      drag = { kind: 'vertex', ...v } // 记住拖的是第几个点
      svg.value.setPointerCapture(e.pointerId) // 鼠标拖出画布也继续收到事件
      return // 不再选别的元素
    }
    const hit = E.hitTest(d.value, p, 8 * px.value) // 点到了什么
    sel.value = hit // 选中它（没点到就取消选择）
    if (!hit) startPan(e) // 点空白处: 平移
    return // 选择工具处理完
  }
  if (tool.value === 'door') return addDoor(p) // 店门: 贴墙
  if (tool.value === 'portal') { // 出入口: 点哪放哪
    snapshot() // 改之前存快照
    d.value.portals.push({ pos: p.map(r2) }) // 坐标保留到厘米
    return // 出入口处理完
  }
  // 画线 / 画面: 每点一下加一个点
  const q = placePoint(p, e).map(r2) // 吸附后的点
  if (!drawing.value) drawing.value = [q] // 第一下: 开始一条新的线
  else { // 后面几下: 往上加点
    const last = drawing.value[drawing.value.length - 1] // 上一个点
    if (Math.hypot(last[0] - q[0], last[1] - q[1]) < 0.3) return // 双击的第二下会落在同一点，不重复加
    drawing.value = [...drawing.value, q] // 加点（整体替换数组，Vue 才能察觉）
    // 道路吸到别的路上: 自动结束（接上了就是一个路口）
    if (tool.value === 'road' && snapHit.value && drawing.value.length >= 2) finishDrawing() // 接到别的路上就是一个路口
  }
}

/** 开始平移: 记下起点，move 时反向移动视口 */
function startPan(e) {
  drag = { kind: 'pan', x: e.clientX, y: e.clientY } // 记下起点
  svg.value.setPointerCapture(e.pointerId) // 鼠标拖出画布也继续收到事件
}

function onMove(e) {
  const p = toScene(e) // 鼠标位置（场景米）
  if (drag?.kind === 'pan') { // 平移中
    view.cx -= (e.clientX - drag.x) * px.value // 往右拖 = 视口往左移
    view.cy -= (e.clientY - drag.y) * px.value // 往下拖 = 视口往上移
    drag.x = e.clientX // 更新上一次的位置
    drag.y = e.clientY // 更新上一次的位置
    return // 平移不更新光标
  }
  if (drag?.kind === 'vertex') { // 拖顶点中
    // 拖路的顶点也吸附到别的路（能把路接上）；拖楼 / 区域的顶点不吸附
    const s = sel.value.type === 'roads' ? E.snapToRoads(d.value, p, 12 * px.value, sel.value.index) : null
    const q = (s ? s.p : p).map(r2) // 吸附后的位置，保留到厘米
    const it = d.value[sel.value.type][sel.value.index] // 被拖的元素
    const key = sel.value.type === 'roads' ? 'points' : sel.value.type === 'doors' || sel.value.type === 'portals' ? null : 'polygon' // 路的点叫 points，楼和区域叫 polygon，点状元素只有 pos
    if (key) it[key][drag.k] = q // 改这个顶点
    else it.pos = q // 点状元素整个挪
    return // 拖顶点不更新光标
  }
  cursor.value = tool.value === 'road' || tool.value === 'building' || tool.value === 'area' ? placePoint(p, e) : p // 画线时光标也吸附，最后一段预览才准
}

function onUp(e) {
  if (drag) svg.value.releasePointerCapture?.(e.pointerId) // 释放指针捕获
  // 拖店门: 松手时重新贴到墙上
  if (drag?.kind === 'vertex' && sel.value?.type === 'doors') { // 拖的是店门
    const it = d.value.doors[sel.value.index] // 被拖的店门
    const w = wallNear(it.pos) // 最近的外墙
    if (w) it.pos = w.pos // 贴上去；离楼太远就留在原地
  }
  if (drag) dirty.value++ // 拖完触发一次自动保存
  drag = null // 拖动结束
}

/** 选中元素的哪个顶点在鼠标下（8 像素内）；店门 / 出入口整个点就是「顶点」 */
function vertexAt(p) {
  if (!selItem.value) return null // 没选中东西
  const pts = selItem.value.points || selItem.value.polygon || [selItem.value.pos] // 线、面的顶点，或点状元素本身
  const k = pts.findIndex((v) => Math.hypot(v[0] - p[0], v[1] - p[1]) <= 8 * px.value) // 8 个屏幕像素内
  return k >= 0 ? { k } : null // 返回顶点下标
}

/** 结束当前折线 / 多边形，提交成一个元素 */
function finishDrawing() {
  const pts = drawing.value // 画好的点
  drawing.value = null // 清掉正在画的
  snapHit.value = null // 清掉吸附圈
  if (!pts) return // 没在画
  const need = tool.value === 'road' ? 2 : 3 // 路至少 2 个点，面至少 3 个
  if (pts.length < need) return (hint.value = tool.value === 'road' ? '一条路至少 2 个点' : '至少 3 个点才能围成一块') // 点不够: 提示，丢掉
  snapshot() // 提交前存快照
  if (tool.value === 'road') { // 路: 用当前默认属性
    d.value.roads.push({ points: pts, lanes: defaults.lanes, oneway: defaults.oneway, elevated: defaults.elevated }) // 加一条路
    sel.value = { type: 'roads', index: d.value.roads.length - 1 } // 画完自动选中，右侧面板直接能改
  } else if (tool.value === 'building') { // 楼
    d.value.buildings.push({ polygon: pts, kind: defaults.kind, floors: defaults.floors }) // 加一栋楼
    sel.value = { type: 'buildings', index: d.value.buildings.length - 1 } // 选中它
  } else { // 区域
    d.value.areas.push({ polygon: pts, kind: defaults.areaKind }) // 加一块区域
    sel.value = { type: 'areas', index: d.value.areas.length - 1 } // 选中它
  }
}

/** 离 p 最近的楼的外墙点（15 米内，和 map2scene 吸附店门的范围一致） */
function wallNear(p) {
  let best = null // 目前最近的外墙点
  for (const b of d.value.buildings) { // 逐栋楼找
    const s = snapToWall(b.polygon, p[0], p[1]) // 这栋楼外墙上的最近点
    if (s && s.dist <= 15 && (!best || s.dist < best.dist)) best = s // 15 米内且更近
  }
  return best // 没有就是 null
}

/** 店门: 贴到最近的外墙上 */
function addDoor(p) {
  const w = wallNear(p) // 最近的外墙点
  if (!w) return (hint.value = '店门要点在楼边上（15 米内）') // 离楼太远
  snapshot() // 改之前存快照
  d.value.doors.push({ pos: w.pos }) // 店门放在墙上
}

/** 删除选中的元素 */
function removeSel() {
  if (!sel.value) return // 没选中东西
  snapshot() // 删之前存快照
  d.value[sel.value.type].splice(sel.value.index, 1) // 从对应的列表里删掉
  sel.value = null // 取消选择
}

/** 属性改动前存快照（面板里的输入框 focus 时调用，一次编辑算一步撤销） */
const beforeEdit = () => snapshot() // 面板输入框获得焦点时存快照

/** 改路的车道数 / 单行: 路宽回到「按车道数自动算」 */
function setRoad(key, v) {
  snapshot() // 改之前存快照
  selItem.value[key] = v // 车道数或单行
  selItem.value.width = null // 路宽回到按车道数自动算
}

/** 反转路的方向（单行路行驶方向跟着反） */
function reverseRoad() {
  snapshot() // 改之前存快照
  selItem.value.points.reverse() // 点序倒过来，行驶方向跟着反
}

/** 键盘: 工具快捷键、回车结束、Esc 取消、退格删最后一个点、Delete 删除、Ctrl+Z / Y */
function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return // 在输入框里打字不触发
  const k = e.key.toLowerCase() // 小写，大小写锁定时也能用快捷键
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo() }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); return redo() }
  if (k === 'enter') return finishDrawing() // 结束正在画的线 / 面
  if (k === 'escape') { drawing.value = null; sel.value = null; return }
  if (k === 'backspace' && drawing.value) { drawing.value = drawing.value.slice(0, -1); if (!drawing.value.length) drawing.value = null; return }
  if ((k === 'delete' || k === 'backspace') && sel.value) return removeSel()
  const t = TOOLS.find((x) => x.key === k) // 工具快捷键
  if (t && !e.ctrlKey && !e.metaKey) setTool(t.id) // Ctrl 组合键留给浏览器
}

// ---------------------------------------------------------------------------
// 新建 / 打开 / 底图 / 生成
// ---------------------------------------------------------------------------
const newSize = reactive({ w: 400, h: 300 }) // 新建画布的宽高（米）
const scenes = ref([]) // 可以打开的场景（内置 + 已导入）
const bgOpacity = ref(0.8) // 底图不透明度
const building = ref(false) // 生成中
const result = ref(null) // 生成结果 {scene, summary}
const error = ref('') // 生成失败或打不开场景时的提示
const probs = computed(() => E.problems(d.value)) // 生成前的问题清单
const st = computed(() => E.stats(d.value)) // 状态栏统计

/** 新建空白画布 */
function newDrawing() {
  snapshot() // 新建前存快照，可以撤销回去
  d.value = E.emptyDrawing(newSize.w, newSize.h) // 按填的宽高新建
  sel.value = null // 取消选择
  fitAll() // 整张画布装进屏幕
}

/** 打开已有场景: 优先读编辑器自己存的矢量图（<名字>_drawing.json，和上次画的一模一样），没有就把 scene.json 拆成矢量图 */
async function openScene(id) {
  if (!id) return // 下拉框的「打开场景…」占位项
  error.value = '' // 清掉上次的错误
  const base = id.startsWith('imported/') ? id.slice(9) : id // 去掉 imported/ 前缀的场景名
  try {
    const dr = id.startsWith('imported/') ? await fetch(`/scenes/imported/${base}_drawing.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null // 编辑器生成过的场景有这份矢量图
    let next // 要载入的矢量图
    if (dr) { // 有矢量图: 原样载入
      next = dr // 上次画的，一模一样
      name.value = base // 编辑器生成的场景: 改完覆盖同名场景
    } else { // 没有: 从场景拆
      const r = await fetch(`/scenes/${id}.json`) // 读场景文件
      if (!r.ok) throw new Error(r.status) // 404 等
      next = E.sceneToDrawing(await r.json()) // 路、楼、区域拆成可编辑元素
      name.value = `${base}-edit` // 别的来源的场景: 另存一个名字，不覆盖原场景
      // 内置场景的底图（如果有）在上一层目录；导入场景就在 imported/
      bgBase.value = id.startsWith('imported/') ? '/scenes/imported/' : '/scenes/'
    }
    snapshot() // 打开前存快照，可以撤销回去
    d.value = { ...E.emptyDrawing(), ...next } // 缺的字段用空白补上
    sel.value = null // 取消选择
    fitAll() // 整张画布装进屏幕
  } catch (e) {
    error.value = `打不开场景 ${id}（${e.message}）` // 显示在右侧面板
  }
}

/** 选一张本地图片当底图（铺满画布；生成时一起传给服务器，成为场景的卫星底图） */
function pickBackground(e) {
  const f = e.target.files[0] // 选中的文件
  if (!f) return // 取消了选择
  const rd = new FileReader() // 读成 data URL，既能显示又能上传
  rd.onload = () => {
    snapshot() // 换底图前存快照
    d.value.background = { dataUrl: rd.result } // 底图随矢量图一起上传
    // 画布宽高比跟着图片走（宽度不变），底图才不会被拉伸
    const img = new Image() // 读图片尺寸
    img.onload = () => { d.value.heightM = Math.round((d.value.widthM * img.height) / img.width); fitAll() } // 按图片宽高比调整画布高度
    img.src = rd.result // 开始加载
  }
  rd.readAsDataURL(f) // 开始读文件
}

/** 底图的显示地址: 上传的直接用 dataUrl；已有场景的底图按场景目录解析 */
const bgHref = computed(() => {
  const b = d.value.background // 当前底图
  if (!b) return '' // 没有底图
  return b.dataUrl || bgBase.value + b.url // 上传的直接显示，已有的按目录解析
})

/** 生成场景: POST 矢量图，服务器跑 map2scene，完成后给出打开链接 */
async function generate() {
  error.value = '' // 清掉上次的错误
  result.value = null // 清掉上次的结果
  if (probs.value.length) return (error.value = probs.value.join('；')) // 前端先检查一遍
  building.value = true // 按钮显示生成中
  try {
    const r = await fetch('/api/draw/build?name=' + encodeURIComponent(name.value), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d.value) }) // 整张矢量图作为请求体
    const j = await r.json().catch(() => ({ error: `导入服务没响应（${r.status}）。先运行: python tools/sat_server.py` })) // 代理 502 等返回的不是 JSON
    if (j.error) throw new Error(j.error) // 后端的中文错误提示
    result.value = j // 显示打开仿真的链接
    // 上传过的底图服务器已经存成文件，以后按文件名引用（本机存储也不再塞大 dataUrl）
    if (d.value.background?.dataUrl) { d.value.background = { url: `${name.value}_bg.${/image\/png/.test(d.value.background.dataUrl) ? 'png' : /image\/webp/.test(d.value.background.dataUrl) ? 'webp' : 'jpg'}` }; bgBase.value = '/scenes/imported/' }
    dirty.value++ // 触发自动保存
  } catch (e) {
    error.value = e.message.includes('Failed to fetch') ? '连不上导入服务。先在项目目录运行: python tools/sat_server.py' : e.message // 连不上时提示去开服务
  } finally {
    building.value = false // 按钮恢复
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
let ro = null // 尺寸监听器，卸载时断开
onMounted(async () => {
  ro = new ResizeObserver(() => { const r = svg.value.getBoundingClientRect(); size.w = r.width || 1; size.h = r.height || 1 }) // 窗口变化时更新 SVG 尺寸
  ro.observe(svg.value) // 开始监听
  const r = svg.value.getBoundingClientRect() // 先取一次尺寸，fitAll 要用
  size.w = r.width || 1 // 宽
  size.h = r.height || 1 // 高
  window.addEventListener('keydown', onKey) // 快捷键
  // 场景列表: 内置两个 + 已导入的（读静态索引，导入服务没开也能列）
  const imported = await fetch('/scenes/imported/index.json').then((x) => (x.ok ? x.json() : [])).catch(() => []) // 已导入的场景列表
  scenes.value = [{ id: 'district', name: '城区（内置）' }, { id: 'demo', name: '街区（内置）' }, ...imported.map((s) => ({ id: s.id, name: s.name }))] // 内置两个在前
  if (fromScene) await openScene(fromScene) // 地址栏带了场景: 打开它
  else { // 空白打开
    // 空白打开: 有本机自动保存的就接着画
    try {
      const saved = localStorage.getItem(storeKey()) // 本机自动保存的
      if (saved) d.value = { ...E.emptyDrawing(), ...JSON.parse(saved) } // 有就接着画
    } catch {
      /* 本机存储不可用 */
    }
    fitAll() // 整张画布装进屏幕
  }
  setTool('select') // 默认选择工具
})
onBeforeUnmount(() => { ro?.disconnect(); window.removeEventListener('keydown', onKey) }) // 离开页面时清理

// 显示用的小工具
const r2 = (v) => Math.round(v * 100) / 100 // 坐标保留到厘米
const P = (pts) => pts.map((p) => p[0] + ',' + p[1]).join(' ') // 点列 → SVG points
const kindColor = (k) => E.BUILDING_KINDS.find((x) => x.id === k)?.color || '#999' // 建筑类型的显示颜色
const areaColor = (k) => E.AREA_KINDS.find((x) => x.id === k)?.color || '#999' // 区域类型的显示颜色
/** 路中间的标注文字: 双向「2+2」、单行「→3」 */
const laneLabel = (r) => (r.oneway ? `单行 ${r.lanes || '?'}` : `${r.lanes || '?'}+${r.lanes || '?'}`) // 双向写 2+2，单行写单行 3
/** 折线中间那一段的中点和方向（放车道标注、单行箭头） */
function midOf(pts) {
  const k = Math.max(0, Math.floor((pts.length - 1) / 2)) // 中间那一段的起点下标
  const a = pts[k], b = pts[Math.min(pts.length - 1, k + 1)] // 那一段的两端
  return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI } // 中点和方向角（度）
}
const isSel = (type, i) => sel.value && sel.value.type === type && sel.value.index === i // 这个元素是否选中
</script>

<template>
  <div class="page">
    <!-- 顶栏: 场景名、新建、打开、底图、撤销重做、生成 -->
    <div class="top">
      <b>场景编辑器</b>
      <!-- 场景名: 生成 imported/<名字>，同名覆盖 -->
      <label>场景名 <input v-model="name" class="name" /></label>
      <!-- 新建空白画布 -->
      <span class="grp">新建 <input v-model.number="newSize.w" type="number" min="20" max="3000" class="num" />×<input v-model.number="newSize.h" type="number" min="20" max="3000" class="num" /> 米 <button @click="newDrawing">新建</button></span>
      <!-- 在已有场景上改 -->
      <select @change="openScene($event.target.value); $event.target.value = ''">
        <option value="">打开场景…</option>
        <option v-for="s in scenes" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <!-- 底图: 本地卫星图 / 截图，铺满画布 -->
      <label class="file">底图 <input type="file" accept="image/png,image/jpeg,image/webp" @change="pickBackground" /></label>
      <label v-if="d.background">不透明度 <input v-model.number="bgOpacity" type="range" min="0" max="1" step="0.05" /></label>
      <button :disabled="!d.background" @click="snapshot(); d.background = null">去掉底图</button>
      <!-- 撤销 / 重做 -->
      <button title="Ctrl+Z" @click="undo">撤销</button>
      <button title="Ctrl+Y" @click="redo">重做</button>
      <button @click="fitAll">全图</button>
      <!-- 生成并在仿真里打开 -->
      <button class="go" :disabled="building" @click="generate">{{ building ? '生成中…' : '生成场景' }}</button>
      <a v-if="result" class="open" :href="'/?scene=' + result.scene" target="_blank">打开仿真 ›</a>
      <a class="back" href="/">‹ 回仿真</a>
    </div>

    <!-- 左侧工具栏 -->
    <div class="tools">
      <button v-for="t in TOOLS" :key="t.id" :class="{ on: tool === t.id }" :title="t.tip + '（快捷键 ' + t.key.toUpperCase() + '）'" @click="setTool(t.id)">
        {{ t.t }}<small>{{ t.key.toUpperCase() }}</small>
      </button>
    </div>

    <!-- 画布 -->
    <svg ref="svg" class="map" :viewBox="viewBox" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @dblclick.prevent="finishDrawing" @wheel.prevent="onWheel" @contextmenu.prevent>
      <!-- 画布范围: 白底 + 边框 -->
      <rect :x="-d.widthM / 2" :y="-d.heightM / 2" :width="d.widthM" :height="d.heightM" class="sheet" :stroke-width="1.5 * px" />
      <!-- 底图 -->
      <image v-if="bgHref" :href="bgHref" :x="-d.widthM / 2" :y="-d.heightM / 2" :width="d.widthM" :height="d.heightM" preserveAspectRatio="none" :opacity="bgOpacity" />
      <!-- 网格 -->
      <line v-for="(g, i) in gridLines" :key="'g' + i" :x1="g[0]" :y1="g[1]" :x2="g[2]" :y2="g[3]" class="grid" :stroke-width="px" />
      <!-- 区域 -->
      <polygon v-for="(a, i) in d.areas" :key="'a' + i" :points="P(a.polygon)" :fill="areaColor(a.kind)" class="area" :class="{ sel: isSel('areas', i) }" :stroke-width="(isSel('areas', i) ? 3 : 1) * px" />
      <!-- 地面道路（先画）再高架: 路面灰色粗线，宽度 = 真实路宽 -->
      <template v-for="elev in [false, true]" :key="'e' + elev">
        <g v-for="(r, i) in d.roads" :key="'r' + i">
          <template v-if="!!r.elevated === elev">
            <polyline :points="P(r.points)" class="road" :class="{ elevated: r.elevated, sel: isSel('roads', i) }" :stroke-width="E.roadWidth(r)" />
            <!-- 双向路画黄色中线，单行路画白色中线 -->
            <polyline :points="P(r.points)" :class="r.oneway ? 'mid-one' : 'mid-two'" :stroke-width="1.2 * px" :stroke-dasharray="`${6 * px} ${4 * px}`" />
            <!-- 车道数标注 + 单行箭头（放在折线中间那一段） -->
            <g :transform="`translate(${midOf(r.points).x} ${midOf(r.points).y}) rotate(${midOf(r.points).ang})`">
              <path v-if="r.oneway" :d="`M ${-7 * px} ${-4 * px} L ${3 * px} 0 L ${-7 * px} ${4 * px} Z`" class="arrow" />
              <text :y="-E.roadWidth(r) / 2 - 3 * px" :font-size="11 * px" class="lab">{{ laneLabel(r) }}{{ r.elevated ? ' 高架' : '' }}</text>
            </g>
          </template>
        </g>
      </template>
      <!-- 建筑: 按类型着色，中间写层数 -->
      <g v-for="(b, i) in d.buildings" :key="'b' + i">
        <polygon :points="P(b.polygon)" :fill="kindColor(b.kind)" class="bld" :class="{ sel: isSel('buildings', i) }" :stroke-width="(isSel('buildings', i) ? 3 : 1) * px" />
        <text :x="E.centroid(b.polygon)[0]" :y="E.centroid(b.polygon)[1]" :font-size="11 * px" class="lab mid">{{ b.floors || '' }}F</text>
      </g>
      <!-- 店门（黄）/ 出入口（青） -->
      <circle v-for="(p, i) in d.doors" :key="'d' + i" :cx="p.pos[0]" :cy="p.pos[1]" :r="(isSel('doors', i) ? 6 : 4.5) * px" class="door" :stroke-width="1.5 * px" />
      <circle v-for="(p, i) in d.portals" :key="'p' + i" :cx="p.pos[0]" :cy="p.pos[1]" :r="(isSel('portals', i) ? 7 : 5.5) * px" class="portal" :stroke-width="1.5 * px" />
      <!-- 选中元素的顶点把手（拖动改形状） -->
      <template v-if="selItem && (selItem.points || selItem.polygon)">
        <circle v-for="(v, k) in selItem.points || selItem.polygon" :key="'h' + k" :cx="v[0]" :cy="v[1]" :r="4.5 * px" class="handle" :stroke-width="1.5 * px" />
      </template>
      <!-- 正在画的线 / 面: 已点的点 + 跟着鼠标的最后一段 -->
      <template v-if="drawing">
        <polyline :points="P(cursor ? [...drawing, cursor] : drawing)" class="drawing" :stroke-width="tool === 'road' ? E.roadWidth({ lanes: defaults.lanes, oneway: defaults.oneway }) : 2 * px" />
        <circle v-for="(v, k) in drawing" :key="'dv' + k" :cx="v[0]" :cy="v[1]" :r="3.5 * px" class="handle" :stroke-width="px" />
      </template>
      <!-- 吸附提示圈 -->
      <circle v-if="snapHit" :cx="snapHit[0]" :cy="snapHit[1]" :r="8 * px" class="snap" :stroke-width="2 * px" />
    </svg>

    <!-- 右侧属性面板: 选中元素的属性，或当前工具的默认属性 -->
    <div class="panel">
      <!-- 选中了路 -->
      <template v-if="sel && sel.type === 'roads'">
        <b>道路</b>
        <label>每方向车道 <select :value="selItem.lanes" @change="setRoad('lanes', +$event.target.value)"><option v-for="n in 4" :key="n" :value="n">{{ n }}</option></select></label>
        <label><input type="checkbox" :checked="selItem.oneway" @change="setRoad('oneway', $event.target.checked)" /> 单行（按画的方向）</label>
        <button v-if="selItem.oneway" @click="reverseRoad">反转方向</button>
        <label><input type="checkbox" :checked="selItem.elevated" @change="snapshot(); selItem.elevated = $event.target.checked" /> 高架（两端要通到画布边）</label>
        <label>路宽 <input :value="E.roadWidth(selItem)" type="number" min="3" step="0.5" class="num" @focus="beforeEdit" @change="selItem.width = +$event.target.value || null" /> 米</label>
      </template>
      <!-- 选中了楼 -->
      <template v-else-if="sel && sel.type === 'buildings'">
        <b>建筑</b>
        <label>类型 <select v-model="selItem.kind" @focus="beforeEdit"><option v-for="k in E.BUILDING_KINDS" :key="k.id" :value="k.id">{{ k.t }}</option></select></label>
        <label>层数 <input v-model.number="selItem.floors" type="number" min="1" max="100" class="num" @focus="beforeEdit" /></label>
      </template>
      <!-- 选中了区域 -->
      <template v-else-if="sel && sel.type === 'areas'">
        <b>区域</b>
        <label>类型 <select v-model="selItem.kind" @focus="beforeEdit"><option v-for="k in E.AREA_KINDS" :key="k.id" :value="k.id">{{ k.t }}</option></select></label>
      </template>
      <!-- 选中了点 -->
      <template v-else-if="sel">
        <b>{{ sel.type === 'doors' ? '店门' : '出入口' }}</b>
        <span class="sub">拖动可以移动</span>
      </template>
      <!-- 没选中: 当前工具的默认属性 -->
      <template v-else-if="tool === 'road'">
        <b>新画的路</b>
        <label>每方向车道 <select v-model.number="defaults.lanes"><option v-for="n in 4" :key="n" :value="n">{{ n }}</option></select></label>
        <label><input v-model="defaults.oneway" type="checkbox" /> 单行（按画的方向）</label>
        <label><input v-model="defaults.elevated" type="checkbox" /> 高架</label>
        <span class="sub">路宽 {{ E.roadWidth({ lanes: defaults.lanes, oneway: defaults.oneway }) }} 米</span>
      </template>
      <template v-else-if="tool === 'building'">
        <b>新画的楼</b>
        <label>类型 <select v-model="defaults.kind" @change="defaults.floors = E.BUILDING_KINDS.find((k) => k.id === defaults.kind).floors"><option v-for="k in E.BUILDING_KINDS" :key="k.id" :value="k.id">{{ k.t }}</option></select></label>
        <label>层数 <input v-model.number="defaults.floors" type="number" min="1" max="100" class="num" /></label>
      </template>
      <template v-else-if="tool === 'area'">
        <b>新画的区域</b>
        <label>类型 <select v-model="defaults.areaKind"><option v-for="k in E.AREA_KINDS" :key="k.id" :value="k.id">{{ k.t }}</option></select></label>
      </template>
      <template v-else>
        <b>操作</b>
        <span class="sub">滚轮缩放；拖空白处、中键或 Alt+拖动平移；Delete 删除；Ctrl+Z 撤销</span>
      </template>
      <button v-if="sel" class="danger" @click="removeSel">删除</button>
      <!-- 生成结果 / 错误 -->
      <p v-if="result" class="ok">已生成 {{ result.scene }}: {{ result.summary.buildings }} 栋楼、{{ result.summary.lanes }} 段车道，{{ result.summary.seconds }} 秒</p>
      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <!-- 底部状态栏: 提示 + 统计 + 鼠标坐标 -->
    <div class="status">
      <span>{{ hint }}</span>
      <span class="right">路 {{ st.roads }} 条（{{ st.roadKm }} km）· 楼 {{ st.buildings }} · 区域 {{ st.areas }} · 店门 {{ st.doors }} · 出入口 {{ st.portals }}<template v-if="cursor"> · ({{ cursor[0].toFixed(1) }}, {{ cursor[1].toFixed(1) }}) m</template> · 网格 {{ gridStep }} m</span>
    </div>
  </div>
</template>

<style scoped>
/* 整页布局: 顶栏 / 左工具栏 / 画布 / 右面板 / 状态栏 */
.page { position: fixed; inset: 0; display: grid; grid-template: 'top top top' auto 'tools map panel' 1fr 'status status status' auto / 64px 1fr 220px; font: 13px/1.45 system-ui, 'Microsoft YaHei', sans-serif; color: #1e293b; background: #cbd2dc; }
.top { grid-area: top; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 10px; background: #fff; border-bottom: 1px solid #cbd5e1; }
.tools { grid-area: tools; display: flex; flex-direction: column; gap: 4px; padding: 6px; background: #f8fafc; border-right: 1px solid #cbd5e1; }
.map { grid-area: map; width: 100%; height: 100%; display: block; touch-action: none; cursor: crosshair; }
.panel { grid-area: panel; display: flex; flex-direction: column; gap: 8px; padding: 10px; background: #fff; border-left: 1px solid #cbd5e1; overflow-y: auto; }
.status { grid-area: status; display: flex; gap: 12px; padding: 4px 10px; background: #f1f5f9; border-top: 1px solid #cbd5e1; color: #475569; font-size: 12px; }
.status .right { margin-left: auto; }
/* 按钮 / 输入框 */
button { border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; padding: 3px 10px; font: inherit; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.go { background: #1e293b; color: #fff; border-color: #1e293b; }
button.danger { color: #dc2626; }
.tools button { display: flex; flex-direction: column; align-items: center; padding: 6px 0; }
.tools button.on { background: #1e293b; color: #fff; border-color: #1e293b; }
.tools small { opacity: 0.6; font-size: 10px; }
input, select { font: inherit; padding: 2px 5px; border: 1px solid #cbd5e1; border-radius: 5px; }
.num { width: 64px; }
.name { width: 120px; }
.grp { display: inline-flex; align-items: center; gap: 4px; }
.file input { width: 180px; }
.open { color: #2563eb; font-weight: 600; }
.back { margin-left: auto; color: #475569; text-decoration: none; }
.panel label { display: flex; align-items: center; gap: 6px; }
.sub { color: #64748b; font-size: 12px; }
.ok { color: #15803d; }
.err { color: #dc2626; white-space: pre-wrap; }
/* 画布元素 */
.sheet { fill: #eef1f5; stroke: #64748b; }
.grid { stroke: rgba(15, 23, 42, 0.08); }
.area { fill-opacity: 0.45; stroke: #334155; }
.road { fill: none; stroke: #6b7280; stroke-linecap: round; stroke-linejoin: round; opacity: 0.92; }
.road.elevated { stroke: #be185d; opacity: 0.75; }
.road.sel { stroke: #2563eb; }
.mid-two { fill: none; stroke: #facc15; }
.mid-one { fill: none; stroke: #fff; }
.arrow { fill: #fff; }
.bld { fill-opacity: 0.55; stroke: #1e293b; }
.bld.sel, .area.sel { stroke: #2563eb; }
.lab { fill: #0f172a; paint-order: stroke; stroke: #fff; stroke-width: 0.25em; text-anchor: middle; pointer-events: none; }
.lab.mid { dominant-baseline: middle; }
.door { fill: #fde047; stroke: #854d0e; }
.portal { fill: #22d3ee; stroke: #155e75; }
.handle { fill: #fff; stroke: #2563eb; }
.drawing { fill: none; stroke: rgba(37, 99, 235, 0.5); stroke-linecap: round; stroke-linejoin: round; }
.snap { fill: none; stroke: #16a34a; }
</style>
