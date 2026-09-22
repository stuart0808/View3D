<script setup>
// 实地标注工具（手机网页）: 甲方的考察人员拿着手机在现场，对着卫星图 / 楼轮廓标出每家商户的门口和临街范围。
//   地图     SVG 画卫星底图、楼轮廓、50 米网格、已标商户；单指拖动、双指 / 滚轮缩放、轻点选择
//   网格     每格一个编号（A01…），屏幕中心十字所在的格子可以改状态（未查 / 进行中 / 已完成 / 待复核），用来分工和记进度
//   标商户   点楼 → 新增商户 → 点外墙标门口（自动吸附到墙上、算出朝外方向，可标多扇）→ 可选在墙上点两下标临街范围 → 填店名业态等
//   定位     场景有经纬度时，手机定位显示「我在这里」（只用来找位置，精确位置靠在图上点）
//   存储     每次改动先存手机本地（没网也不丢），「同步」时传给导入服务合并（几台手机各标各的）
//   输出     导出 GeoJSON / CSV 给甲方；「写回仿真」生成带实测门口的新场景，人流按真实商户分布走
// 所有几何 / 换算 / 数据操作在 model.js 里（有单元测试），这里只管交互和显示。
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue' // Vue 组合式 API
import * as M from './model.js' // 网格 / 坐标 / 吸附 / 数据 / 导出的纯函数

// ---------------------------------------------------------------------------
// 场景与标注数据
// ---------------------------------------------------------------------------
const sceneId = new URLSearchParams(location.search).get('scene') || 'district' // 和三维页同一套场景 id
const sceneUrl = new URL(`/scenes/${sceneId}.json`, location.href) // 底图地址相对它解析
const scene = ref(null) // scene.json 内容
const loadError = ref('') // 读场景失败时的提示
const grid = computed(() => (scene.value ? M.makeGrid(scene.value.bounds, 50) : null)) // 50 米网格
const geo = computed(() => (scene.value ? M.makeGeo(scene.value.origin) : null)) // 没有地理位置时为 null
// 标注数据按「原始场景」存: 在写回后的场景（-surveyed）上继续标，还是同一份
const surveyKey = computed(() => scene.value?.surveyOf || sceneId) // 写回后的场景带 surveyOf，指回原场景
const survey = ref(M.emptySurvey(sceneId)) // 先放一份空白的，onMounted 里换成本机存的
const surveyor = ref(readLocal('view3d-surveyor') || '') // 标注人姓名 / 代号，记进每条修改
const byId = computed(() => new Map((scene.value?.buildings || []).map((b) => [b.id, b]))) // 楼 id → 楼

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

const storeKey = () => `view3d-survey:${surveyKey.value}` // 本地存储的键
// 每次数据变化就存本地；标注人姓名也存，下次不用再填
watch(survey, (v) => writeLocal(storeKey(), JSON.stringify(v)), { deep: false }) // survey 每次都整体替换，不需要深度监听
watch(surveyor, (v) => writeLocal('view3d-surveyor', v)) // 下次打开不用再填名字

// ---------------------------------------------------------------------------
// 同步（导入服务 tools/sat_server.py 的 /api/survey）
// ---------------------------------------------------------------------------
const sync = reactive({ state: 'idle', at: 0, msg: '' }) // state: idle | busy | ok | fail；at = 上次成功同步的时间
// 上次同步以后本机改了几处（日志里比上次同步新的条数）
const pending = computed(() => survey.value.log.filter((e) => e.t > sync.at).length) // 按钮上显示的数字

/** 上传本机数据，服务器合并后把完整数据发回来，用它替换本机的（这样也拿到了别人标的） */
async function doSync() {
  sync.state = 'busy' // 按钮置灰，防止连点
  try {
    const r = await fetch('/api/survey?scene=' + encodeURIComponent(surveyKey.value), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(survey.value),
    })
    const j = await r.json() // 服务器合并后的完整数据
    if (!r.ok || j.error) throw new Error(j.error || r.status) // HTTP 错误或服务端校验不过
    survey.value = j // 用合并结果替换本机的，别人标的也有了
    sync.state = 'ok' // 按钮显示「已同步」
    sync.at = Date.now() // 之后的修改才算「未同步」
    sync.msg = '' // 清掉上次的错误提示
  } catch (e) {
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
// 地图视图: 视口中心 (cx, cy) + 视口宽度 w（米）；SVG 的 viewBox 由它和屏幕宽高比算出
// ---------------------------------------------------------------------------
const svg = ref(null) // 地图 SVG 元素
const size = reactive({ w: 1, h: 1 }) // SVG 元素的像素尺寸
const view = reactive({ cx: 0, cy: 0, w: 300 }) // 初始值只是占位，读到场景后 fitAll
const viewH = computed(() => (view.w * size.h) / size.w) // 视口高度（米），保持像素是正方形
const viewBox = computed(() => `${view.cx - view.w / 2} ${view.cy - viewH.value / 2} ${view.w} ${viewH.value}`) // x y 宽 高（米）
const px = computed(() => view.w / size.w) // 一个屏幕像素是多少米: 线宽、字号、点的大小都按它换算，缩放时屏幕上大小不变
const centerCell = computed(() => (grid.value ? M.cellAt(grid.value, view.cx, view.cy) : null)) // 屏幕中心十字所在的格子

/** 屏幕像素坐标 → 场景米 */
function toScene(clientX, clientY) {
  const r = svg.value.getBoundingClientRect() // SVG 在页面上的位置和大小
  return [view.cx + ((clientX - r.left) / r.width - 0.5) * view.w, view.cy + ((clientY - r.top) / r.height - 0.5) * viewH.value] // 按比例从视口左上角算过去
}

/** 以屏幕上某点为不动点缩放（k > 1 放大）；限制在 20 米 ~ 场景宽度 × 2 */
function zoomAt(clientX, clientY, k) {
  const [x, y] = toScene(clientX, clientY) // 手指下面的场景点，缩放前后保持不动
  const maxW = scene.value ? (scene.value.bounds.maxX - scene.value.bounds.minX) * 2 : 5000 // 最多缩到能看见两倍场景宽
  const w = Math.min(maxW, Math.max(20, view.w / k)) // 最近看到 20 米宽（能分清门口）
  const f = w / view.w // 实际缩放比（被上下限截过）
  // 不动点公式: 新中心 = 手指位置 + (旧中心 - 手指位置) × 缩放比
  view.cx = x + (view.cx - x) * f
  view.cy = y + (view.cy - y) * f
  view.w = w // 新的视口宽度
}

/** 缩放到整个场景 */
function fitAll() {
  const b = scene.value.bounds // 场景范围（米）
  view.cx = (b.minX + b.maxX) / 2 // 视口中心放到场景中心
  view.cy = (b.minY + b.maxY) / 2 // 视口中心放到场景中心
  // 宽、高两个方向都要装得下
  view.w = Math.max(b.maxX - b.minX, ((b.maxY - b.minY) * size.w) / size.h) * 1.05 // 留 5% 边
}

// 手势: 记住每个按下的指针；一个指针 = 拖动，两个 = 双指缩放；位移很小的一次按下抬起 = 轻点
const pointers = new Map() // pointerId → {x, y}
let gesture = null // {x0, y0, t0, moved, dist}

function onDown(e) {
  svg.value.setPointerCapture(e.pointerId) // 手指移出 SVG 也继续收到 move / up
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }) // 记下起点，move 时算位移
  if (pointers.size === 1) gesture = { x0: e.clientX, y0: e.clientY, t0: Date.now(), moved: false } // 第一根手指: 可能是轻点，也可能是拖动
  else if (gesture) gesture.moved = true // 第二根手指按下: 这次不算轻点
}

function onMove(e) {
  const p = pointers.get(e.pointerId) // 这根手指上一次的位置
  if (!p) return // 没按下就移动（鼠标悬停）: 不管
  const pts = [...pointers.values()] // 当前按着的所有手指
  if (pointers.size === 1) {
    // 拖动: 屏幕位移换成米，反向移动视口中心
    view.cx -= (e.clientX - p.x) * px.value // 往右拖 = 视口往左移
    view.cy -= (e.clientY - p.y) * px.value // 往下拖 = 视口往上移
  } else if (pointers.size === 2) {
    // 双指: 按两指距离的变化缩放，以两指中点为不动点
    const other = pts.find((q) => q !== p) // 另一根手指
    const d0 = Math.hypot(p.x - other.x, p.y - other.y), d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y) // 两指上一次和这一次的距离
    if (d0 > 0) zoomAt((e.clientX + other.x) / 2, (e.clientY + other.y) / 2, d1 / d0) // 距离变大 = 放大
  }
  p.x = e.clientX // 更新这根手指的位置
  p.y = e.clientY // 更新这根手指的位置
  // 超过 8 像素就算拖动，不再当轻点
  if (gesture && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 8) gesture.moved = true
}

function onUp(e) {
  pointers.delete(e.pointerId) // 这根手指抬起了
  // 按下到抬起没怎么动、也不太久（< 600ms，长按留给以后）: 当成一次轻点
  if (pointers.size === 0 && gesture && !gesture.moved && Date.now() - gesture.t0 < 600) onTap(...toScene(e.clientX, e.clientY))
  if (pointers.size === 0) gesture = null // 全部抬起，手势结束
}

/** 滚轮缩放（电脑上调试 / 平板接键盘时用） */
function onWheel(e) {
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)) // 往上滚 = 放大；0.0015 让一格滚轮约缩放 15%
}

// ---------------------------------------------------------------------------
// 选择与编辑
// ---------------------------------------------------------------------------
const selected = ref(null) // 选中的楼
const draft = ref(null) // 正在编辑的商户（副本，保存时才写进 survey）
const mode = ref('browse') // browse 选楼 | door 点墙标门口 | front 点墙标临街范围的两端
const frontStart = ref(null) // 标临街范围时第一下点在墙上的位置（snapToWall 的结果）
const hint = ref('') // 屏幕上方的操作提示
const selShops = computed(() => (selected.value ? M.shopsOf(survey.value, selected.value.id) : [])) // 选中楼上的商户
const autoDoors = computed(() => (selected.value ? (scene.value.doors || []).filter((d) => d.building === selected.value.id) : [])) // 场景自动生成的门（参考）

/** 地图上轻点一下（场景坐标） */
function onTap(x, y) {
  if (mode.value === 'door' || mode.value === 'front') return tapWall(x, y) // 标门口 / 临街范围时，点击都交给吸附处理
  if (draft.value) return // 编辑中点地图不换楼 / 不换店，免得误触丢了正在填的内容
  // 先看是不是点到了某家店的门口（半径 12 像素内）: 直接编辑那家店
  const r = 12 * px.value // 12 个屏幕像素换成米
  const hitShop = M.liveShops(survey.value).find((s) => (s.doors || []).some((d) => Math.hypot(d.pos[0] - x, d.pos[1] - y) < r)) // 点到了哪家店的门口
  if (hitShop) return editShop(hitShop) // 点门口 = 编辑那家店
  selected.value = M.buildingAt(scene.value.buildings, x, y) // 点空白处 = 取消选择
}

/** 标门口 / 临街范围模式下点墙: 吸附到选中楼的外墙上，离墙太远（> 25 像素且 > 3 米）不算 */
function tapWall(x, y) {
  const poly = selected.value.polygon // 选中楼的外轮廓
  const sn = M.snapToWall(poly, x, y) // 吸到最近的墙上
  if (!sn || (sn.dist > 25 * px.value && sn.dist > 3)) return (hint.value = '点得离这栋楼的外墙近一点') // 太远就当误触
  if (mode.value === 'door') { // 标门口: 可以连续点多扇
    draft.value.doors = [...draft.value.doors, { pos: sn.pos, normal: sn.normal }] // 追加一扇门（整体替换数组，Vue 才能察觉）
    hint.value = `已标 ${draft.value.doors.length} 扇门，可以继续点；标完点「完成」`
  } else if (!frontStart.value) { // 临街范围的第一端
    frontStart.value = sn // 记下来等第二下
    hint.value = '再点临街范围的另一端'
  } else {
    // 两端都有了: 沿外墙取较短的一段（途经拐角）
    const seg = M.wallSegment(poly, frontStart.value.s, sn.s) // 沿外墙走较短方向，拐角带上
    draft.value.frontage = seg.path // 临街线的点列
    draft.value.frontageLen = seg.length // 临街长度（米），导出 CSV 用
    frontStart.value = null // 清掉第一端
    mode.value = 'browse' // 标完回到普通模式
    hint.value = `临街范围 ${seg.length} 米`
  }
}

/** 在选中的楼上新增一家商户 */
function newShop() {
  draft.value = { id: M.newShopId(), building: selected.value.id, name: '', category: 'retail', floor: '1', hours: '', note: '', doors: [], frontage: null, frontageLen: null } // 默认零售、1 层，最常见
  startDoors() // 新店先标门口
}

/** 编辑已有商户（深拷贝一份，取消时不影响原数据） */
function editShop(s) {
  selected.value = byId.value.get(s.building) || selected.value // 从门口点进来时，楼也跟着选中
  draft.value = JSON.parse(JSON.stringify(s)) // 深拷贝: 取消编辑时原数据不变
  mode.value = 'browse' // 编辑表单打开时先不进标注模式
}

/** 进入「标门口」模式 */
function startDoors() {
  mode.value = 'door' // 之后的点击都当成点墙
  hint.value = '点这栋楼的外墙标门口（会自动贴到墙上）'
}

/** 进入「标临街范围」模式 */
function startFront() {
  mode.value = 'front'
  frontStart.value = null // 重新从第一端开始
  hint.value = '在外墙上点临街范围的一端'
}

/** 撤销最后一扇门 */
function undoDoor() {
  draft.value.doors = draft.value.doors.slice(0, -1) // 去掉最后一扇
}

/** 保存: 网格编号取第一扇门所在的格子（没有门就取楼的中心） */
function saveDraft() {
  const d = draft.value // 正在编辑的商户
  const p = d.doors[0]?.pos || M.centroid(selected.value.polygon)
  survey.value = M.upsertShop(survey.value, { ...d, cell: M.cellAt(grid.value, p[0], p[1]) }, surveyor.value) // 写进标注数据（带标注人、时间，记日志）
  closeDraft() // 关表单
}

/** 删除（留墓碑，同步后别的手机上也会消失） */
function deleteDraft() {
  if (survey.value.shops.some((s) => s.id === draft.value.id)) survey.value = M.upsertShop(survey.value, { ...draft.value, deleted: true }, surveyor.value) // 新建还没保存过的直接丢掉，不用留墓碑
  closeDraft() // 关表单
}

/** 关掉编辑表单，回到选楼模式 */
function closeDraft() {
  draft.value = null // 丢掉草稿
  mode.value = 'browse' // 回到选楼模式
  frontStart.value = null // 清掉没标完的临街范围
  hint.value = '' // 清掉提示
}

/** 改屏幕中心那一格的状态 */
function setCell(status) {
  if (centerCell.value) survey.value = M.setCellStatus(survey.value, centerCell.value, status, surveyor.value) // 网格外（十字不在任何格子里）不改
}

// 进度: 已完成的格子数 / 有楼的格子数（空地格子不算），标了几家店
const busyCells = computed(() => {
  if (!grid.value) return new Set() // 场景还没读到
  const s = new Set() // 有楼的格子
  for (const b of scene.value.buildings) s.add(M.cellAt(grid.value, ...M.centroid(b.polygon))) // 按楼的中心算它在哪一格
  s.delete(null) // 网格外的楼不算
  return s
})
const doneCount = computed(() => [...busyCells.value].filter((c) => survey.value.cells[c]?.status === 'done').length) // 有楼且已完成的格子数
const shopCount = computed(() => M.liveShops(survey.value).length) // 没删掉的商户数
const shopBuildings = computed(() => new Set(M.liveShops(survey.value).map((s) => s.building))) // 标过店的楼，画成橙色

// ---------------------------------------------------------------------------
// 定位
// ---------------------------------------------------------------------------
const me = ref(null) // {x, y, acc}（场景米）
let watchId = null // watchPosition 的句柄，关定位时要用
const locating = ref(false) // 定位按钮是否按下

/** 开 / 关定位；第一次拿到位置时把地图移过去 */
function toggleLocate() {
  if (locating.value) {
    navigator.geolocation.clearWatch(watchId) // 停止监听
    locating.value = false // 按钮弹起
    me.value = null // 地图上的蓝点去掉
    return
  }
  if (!navigator.geolocation) return (hint.value = '这个浏览器不支持定位')
  locating.value = true // 按钮按下
  let first = true // 第一次拿到位置时才移动地图，之后只动蓝点
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const [x, y] = geo.value.toScene(p.coords.longitude, p.coords.latitude) // GPS 是 WGS84，换成场景米（GCJ 图会先加偏）
      me.value = { x, y, acc: p.coords.accuracy } // accuracy = 定位精度（米），画成精度圈
      if (first) Object.assign(view, { cx: x, cy: y, w: Math.min(view.w, 150) }) // 移到自己的位置，并放大到街道尺度
      first = false // 之后不再抢着移地图
    },
    // 手机浏览器只在 https（或本机 localhost）下允许定位
    (err) => { hint.value = '定位失败: ' + (err.code === 1 ? '没有权限（手机上需要 https 访问）' : err.message); locating.value = false },
    { enableHighAccuracy: true, maximumAge: 5000 }, // 要高精度 GPS；5 秒内的旧位置可以复用
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
  setTimeout(() => URL.revokeObjectURL(a.href), 1000) // 稍后释放，别马上释放导致下载失败
}
const fileBase = () => surveyKey.value.replace('/', '_') + '-survey' // 下载文件名前缀
const exportGeoJSON = () => download(fileBase() + '.geojson', JSON.stringify(M.toGeoJSON(survey.value, geo.value), null, 1), 'application/geo+json') // 有地理位置时是经纬度
const exportCSV = () => download(fileBase() + '.csv', M.toCSV(survey.value, geo.value), 'text/csv') // Excel 能直接打开

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
let ro = null // 尺寸监听器，卸载时断开
onMounted(async () => {
  // SVG 尺寸跟着窗口变（手机横竖屏切换）
  ro = new ResizeObserver(() => { const r = svg.value.getBoundingClientRect(); size.w = r.width || 1; size.h = r.height || 1 })
  ro.observe(svg.value) // 开始监听
  try {
    const r = await fetch(sceneUrl) // 读场景 JSON
    if (!r.ok) throw new Error(r.status) // 404 等
    scene.value = await r.json() // 楼、门、底图、地理位置都在里面
  } catch (e) {
    loadError.value = `读不到场景 ${sceneId}（${e.message}）` // 页面上显示红色提示
    return
  }
  // 先用本机存的数据（没网也能接着标），再尝试和服务器同步一次
  const local = readLocal(storeKey()) // 本机存的标注
  survey.value = local ? JSON.parse(local) : M.emptySurvey(surveyKey.value) // 没有就从空白开始
  const r = svg.value.getBoundingClientRect() // 读到场景时 SVG 已经有尺寸了，先取一次
  size.w = r.width || 1
  size.h = r.height || 1
  fitAll() // 整个场景装进屏幕
  doSync() // 打开就和服务器同步一次，拿到别人标的
})
onBeforeUnmount(() => { ro?.disconnect(); if (watchId !== null) navigator.geolocation.clearWatch(watchId) }) // 离开页面: 停止监听尺寸和定位

// 显示用的小工具
const poly = (pts) => pts.map((p) => p[0] + ',' + p[1]).join(' ') // 点列 → SVG points 属性
const imageryHref = computed(() => (scene.value?.imagery ? new URL(scene.value.imagery.url, sceneUrl).href : '')) // 底图地址相对场景文件解析
const cellFill = { doing: 'rgba(250,204,21,0.18)', done: 'rgba(34,197,94,0.18)', review: 'rgba(239,68,68,0.2)' } // 格子状态的底色
const statusOf = (id) => survey.value.cells[id]?.status || 'todo' // 格子没记录就是「未查」
</script>

<template>
  <div class="page">
    <!-- 地图: 整屏 SVG；touch-action: none 让浏览器别抢手势 -->
    <svg ref="svg" class="map" :viewBox="viewBox" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel.prevent="onWheel">
      <template v-if="scene">
        <!-- 卫星底图: 原图正中是场景原点，宽高是米 -->
        <image v-if="imageryHref" :href="imageryHref" :x="-scene.imagery.widthM / 2" :y="-scene.imagery.heightM / 2" :width="scene.imagery.widthM" :height="scene.imagery.heightM" preserveAspectRatio="none" />
        <!-- 没有底图时画路面，至少看得出街道 -->
        <template v-else>
          <polyline v-for="(l, i) in scene.lanes" :key="'l' + i" :points="poly(l.points)" class="lane" :stroke-width="l.width" />
        </template>
        <!-- 网格: 状态底色 + 细线；编号写在左上角 -->
        <g v-for="c in grid.cells" :key="c.id">
          <rect :x="c.x0" :y="c.y0" :width="grid.size" :height="grid.size" :fill="cellFill[statusOf(c.id)] || 'none'" class="cell" :class="{ cur: c.id === centerCell }" :stroke-width="(c.id === centerCell ? 2.5 : 1) * px" />
          <text :x="c.x0 + 4 * px" :y="c.y0 + 13 * px" :font-size="11 * px" class="cell-label">{{ c.id }}</text>
        </g>
        <!-- 楼: 标过店的橙色，选中的蓝色 -->
        <polygon v-for="b in scene.buildings" :key="b.id" :points="poly(b.polygon)" class="bld" :class="{ has: shopBuildings.has(b.id), sel: selected && selected.id === b.id }" :stroke-width="(selected && selected.id === b.id ? 2.5 : 1) * px" />
        <!-- 选中楼上自动生成的门（灰点，供参考） -->
        <circle v-for="(d, i) in autoDoors" :key="'a' + i" :cx="d.pos[0]" :cy="d.pos[1]" :r="3 * px" class="auto-door" />
        <!-- 已标的商户: 临街范围粗线 + 门口圆点和朝外的短线 -->
        <g v-for="s in M.liveShops(survey)" :key="s.id" :class="{ dim: draft && draft.id === s.id }">
          <polyline v-if="s.frontage" :points="poly(s.frontage)" class="front" :stroke-width="5 * px" />
          <g v-for="(d, i) in s.doors" :key="i">
            <line :x1="d.pos[0]" :y1="d.pos[1]" :x2="d.pos[0] + d.normal[0] * 14 * px" :y2="d.pos[1] + d.normal[1] * 14 * px" class="door-dir" :stroke-width="2 * px" />
            <circle :cx="d.pos[0]" :cy="d.pos[1]" :r="5 * px" class="door" :stroke-width="1.5 * px" />
          </g>
        </g>
        <!-- 正在编辑的商户（绿色） -->
        <g v-if="draft">
          <polyline v-if="draft.frontage" :points="poly(draft.frontage)" class="front draft" :stroke-width="5 * px" />
          <circle v-if="frontStart" :cx="frontStart.pos[0]" :cy="frontStart.pos[1]" :r="5 * px" class="door draft" :stroke-width="1.5 * px" />
          <g v-for="(d, i) in draft.doors" :key="'d' + i">
            <line :x1="d.pos[0]" :y1="d.pos[1]" :x2="d.pos[0] + d.normal[0] * 14 * px" :y2="d.pos[1] + d.normal[1] * 14 * px" class="door-dir draft" :stroke-width="2 * px" />
            <circle :cx="d.pos[0]" :cy="d.pos[1]" :r="6 * px" class="door draft" :stroke-width="1.5 * px" />
          </g>
        </g>
        <!-- 我的位置: 精度圈 + 蓝点 -->
        <g v-if="me">
          <circle :cx="me.x" :cy="me.y" :r="me.acc" class="acc" />
          <circle :cx="me.x" :cy="me.y" :r="6 * px" class="me" :stroke-width="2 * px" />
        </g>
      </template>
    </svg>
    <!-- 屏幕中心十字: 「当前格」就是它所在的格子 -->
    <div class="cross"></div>

    <!-- 顶栏: 场景、进度、同步、定位、导出 -->
    <div class="top">
      <div class="row">
        <!-- 回三维仿真 -->
        <a class="btn" :href="'/?scene=' + sceneId">‹ 仿真</a>
        <b class="title">{{ sceneId }}</b>
        <!-- 进度: 已完成格子 / 有楼的格子，已标商户数 -->
        <span class="stat">格 {{ doneCount }}/{{ busyCells.size }} · 店 {{ shopCount }}</span>
      </div>
      <div class="row">
        <!-- 标注人: 每条修改都会记下来 -->
        <input v-model="surveyor" class="who" placeholder="标注人" />
        <!-- 同步: 显示没同步的修改条数 -->
        <button class="btn" :class="{ warn: sync.state === 'fail' }" :disabled="sync.state === 'busy'" @click="doSync">
          {{ sync.state === 'busy' ? '同步中…' : sync.state === 'fail' ? '重试同步' : pending ? `同步 (${pending})` : sync.state === 'ok' ? '已同步' : '同步' }}
        </button>
        <!-- 定位: 场景没有经纬度时不能用 -->
        <button class="btn" :class="{ on: locating }" :disabled="!geo" :title="geo ? '' : '这个场景没有经纬度'" @click="toggleLocate">定位</button>
        <button class="btn" @click="fitAll">全图</button>
        <button class="btn" @click="exportGeoJSON">GeoJSON</button>
        <button class="btn" @click="exportCSV">CSV</button>
        <button class="btn" @click="applyToSim">写回仿真</button>
      </div>
      <!-- 写回后给出打开新场景的链接；同步 / 写回出错的提示 -->
      <div v-if="applied || sync.msg" class="row msg">
        <a v-if="applied" :href="'/?scene=' + applied">打开 {{ applied }}</a>
        <span v-if="sync.msg" class="err">{{ sync.msg }}</span>
      </div>
    </div>

    <!-- 操作提示 -->
    <div v-if="hint" class="hint" @click="hint = ''">{{ hint }}</div>
    <div v-if="loadError" class="hint err">{{ loadError }}</div>

    <!-- 底部面板: 编辑表单 / 选中楼的商户列表 / 当前格状态，三选一 -->
    <div v-if="scene" class="sheet">
      <!-- 编辑商户 -->
      <template v-if="draft">
        <div class="row"><b>{{ survey.shops.some((s) => s.id === draft.id) ? '编辑商户' : '新增商户' }}</b><span class="sub">楼 {{ draft.building }}</span></div>
        <div class="row">
          <input v-model="draft.name" placeholder="店名" class="grow" />
          <!-- 业态决定写回仿真时的吸引力 -->
          <select v-model="draft.category"><option v-for="c in M.CATEGORIES" :key="c.id" :value="c.id">{{ c.t }}</option></select>
        </div>
        <div class="row">
          <input v-model="draft.floor" placeholder="楼层" class="short" />
          <input v-model="draft.hours" placeholder="营业时间 如 9:00-22:00" class="grow" />
        </div>
        <div class="row"><input v-model="draft.note" placeholder="备注" class="grow" /></div>
        <!-- 门口 / 临街范围: 进入对应模式后在地图上点墙 -->
        <div class="row">
          <button class="btn" :class="{ on: mode === 'door' }" @click="mode === 'door' ? (mode = 'browse', hint = '') : startDoors()">{{ mode === 'door' ? '完成' : '标门口' }} ({{ draft.doors.length }})</button>
          <button class="btn" :disabled="!draft.doors.length" @click="undoDoor">撤销门</button>
          <button class="btn" :class="{ on: mode === 'front' }" @click="startFront">临街范围{{ draft.frontageLen ? ` ${draft.frontageLen}m` : '' }}</button>
        </div>
        <div class="row">
          <button class="btn go" @click="saveDraft">保存</button>
          <button class="btn" @click="closeDraft">取消</button>
          <button class="btn danger" @click="deleteDraft">删除</button>
        </div>
      </template>
      <!-- 选中了楼: 这栋楼上的商户 -->
      <template v-else-if="selected">
        <div class="row">
          <b>楼 {{ selected.id }}</b>
          <span class="sub">{{ M.cellAt(grid, ...M.centroid(selected.polygon)) }} · {{ selected.floors }} 层 · 已标 {{ selShops.length }} 家</span>
          <button class="btn close" @click="selected = null">×</button>
        </div>
        <div v-for="s in selShops" :key="s.id" class="item" @click="editShop(s)">
          <b>{{ s.name || '（未填店名）' }}</b> <span class="sub">{{ M.catName(s.category) }} · {{ s.floor }} 层 · 门 {{ (s.doors || []).length }}</span>
        </div>
        <div class="row"><button class="btn go" @click="newShop">+ 新增商户</button></div>
      </template>
      <!-- 什么都没选: 当前格状态 -->
      <template v-else>
        <div class="row">
          <b>当前格 {{ centerCell || '—' }}</b>
          <span v-if="centerCell && survey.cells[centerCell]" class="sub">{{ survey.cells[centerCell].by }}</span>
        </div>
        <div class="row">
          <button v-for="st in M.CELL_STATUS" :key="st.id" class="btn" :class="{ on: centerCell && statusOf(centerCell) === st.id }" :disabled="!centerCell" @click="setCell(st.id)">{{ st.t }}</button>
        </div>
        <div class="sub">点楼开始标商户；拖动地图让十字对准要改状态的格子</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 整页: 地图铺满，其余浮在上面 */
.page { position: fixed; inset: 0; font: 13px/1.45 system-ui, 'Microsoft YaHei', sans-serif; color: #1e293b; }
/* 地图: 手势全交给自己处理 */
.map { width: 100%; height: 100%; touch-action: none; background: #d7dce3; display: block; }
/* 没有底图时的路面 */
.lane { fill: none; stroke: #eef1f5; stroke-linecap: round; stroke-linejoin: round; }
/* 网格线: 细灰；当前格加粗变深 */
.cell { stroke: rgba(15, 23, 42, 0.35); }
.cell.cur { stroke: #0f172a; }
/* 格子编号: 白字黑描边，在卫星图上也看得清 */
.cell-label { fill: #fff; paint-order: stroke; stroke: rgba(0, 0, 0, 0.6); stroke-width: 0.25em; pointer-events: none; }
/* 楼轮廓: 半透明白；标过店的橙；选中的蓝 */
.bld { fill: rgba(255, 255, 255, 0.18); stroke: rgba(255, 255, 255, 0.9); }
.bld.has { fill: rgba(251, 146, 60, 0.35); stroke: #f97316; }
.bld.sel { fill: rgba(59, 130, 246, 0.3); stroke: #2563eb; }
/* 自动生成的门（参考）: 小灰点 */
.auto-door { fill: #94a3b8; }
/* 已标商户: 临街线橙色，门口白底橙边，朝外短线 */
.front { fill: none; stroke: #f97316; stroke-linecap: round; stroke-linejoin: round; opacity: 0.9; }
.door { fill: #fff; stroke: #ea580c; }
.door-dir { stroke: #ea580c; }
/* 正在编辑的: 绿色 */
.front.draft { stroke: #16a34a; }
.door.draft { stroke: #16a34a; }
.door-dir.draft { stroke: #16a34a; }
/* 编辑中的那家店原来的样子淡掉，避免和草稿重叠看花 */
.dim { opacity: 0.25; }
/* 定位: 半透明精度圈 + 蓝点白边 */
.acc { fill: rgba(59, 130, 246, 0.15); stroke: none; }
.me { fill: #2563eb; stroke: #fff; }
/* 屏幕中心十字 */
.cross { position: fixed; left: 50%; top: 50%; width: 22px; height: 22px; margin: -11px 0 0 -11px; pointer-events: none;
  background: linear-gradient(#0f172a, #0f172a) center / 2px 100% no-repeat, linear-gradient(#0f172a, #0f172a) center / 100% 2px no-repeat; opacity: 0.6; }
/* 顶栏 / 底部面板: 半透明毛玻璃卡片 */
.top, .sheet { position: fixed; left: 8px; right: 8px; background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(8px); border-radius: 10px; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.18); padding: 6px 8px; }
.top { top: calc(8px + env(safe-area-inset-top)); }
/* 底部面板最多占 45% 屏高，商户多了可以滚 */
.sheet { bottom: calc(8px + env(safe-area-inset-bottom)); max-height: 45vh; overflow-y: auto; }
/* 一行: 横排，放不下折行 */
.row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 3px 0; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40vw; }
.stat, .sub { color: #64748b; font-size: 12px; }
.stat { margin-left: auto; }
/* 按钮: 手指好点（至少 32px 高） */
.btn { min-height: 32px; padding: 4px 10px; border: 1px solid #cbd5e1; border-radius: 7px; background: #fff; font: inherit; color: inherit; text-decoration: none; display: inline-flex; align-items: center; }
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
/* 商户列表项 */
.item { padding: 6px 4px; border-bottom: 1px solid #e2e8f0; cursor: pointer; }
/* 操作提示: 顶栏下面一条深色横幅，点一下消失 */
.hint { position: fixed; left: 50%; top: calc(110px + env(safe-area-inset-top)); transform: translateX(-50%); max-width: 90vw; background: rgba(15, 23, 42, 0.85); color: #fff; padding: 6px 12px; border-radius: 16px; }
.msg a { color: #2563eb; }
.err { color: #dc2626; }
.hint.err { color: #fff; background: rgba(220, 38, 38, 0.9); }
</style>
