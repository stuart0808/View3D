<script setup>
// 演示壳。真正的产品只需要 <CityScene>；这个文件里其余都是调试条:
//   左下: 场景切换、仿真时钟 + 倍速、跳时间按钮、热力开关、高峰人数、实时计数
//   左上: 各人群在场人数、住户去向、场馆活动状态
//   右下: 视角按钮；底部中央: 室内视图切换（点到楼之后出现）
import { computed, ref } from 'vue' // 这里只用 ref；Three.js 对象不进响应式
import CityScene from './components/CityScene.vue'
import ImportPanel from './components/ImportPanel.vue'

// 角落里这一小条只是调试用的开关，正式接入时删掉即可，CityScene 本身不带任何 UI。
// ?scene=xxx 可切换 public/scenes/xxx.json
// 默认打开城区（环形高架、地铁、铁路、场馆、人群作息都在这个场景里）；街区是早期的小场景，没有这些
const sceneName = new URLSearchParams(location.search).get('scene') || 'district' // 当前场景名
const SCENES = [{ id: 'district', t: '城区' }, { id: 'demo', t: '街区' }] // 可选场景（public/scenes/*.json）
const gotoScene = (id) => (location.search = '?scene=' + id) // 改 URL 整页重载，最省事
const heat = ref(true) // 热力图开关
const base = ref(600) // 高峰人数（传给 population）
// 人数、车流、昼夜都由仿真时钟驱动（src/city/clock.js）。这里只是把时钟显示出来，给几个「跳到某个时刻」的演示按钮
const rate = ref(10) // 仿真倍速，0 = 暂停
const RATES = [{ v: 0, t: '暂停' }, { v: 1, t: '1×' }, { v: 10, t: '10×' }, { v: 30, t: '30×' }, { v: 60, t: '60×' }, { v: 120, t: '120×' }] // 倍速档位
// 跳时间按钮: 拿到 CityScene 暴露的时钟直接操作；「下一场活动」走引擎（要查需求模型的排期）
const JUMPS = [
  { t: '早高峰', f: (c) => c.jumpToHour(8) }, // 8 点: 上班族进核心区、车流最多
  { t: '午间', f: (c) => c.jumpToHour(12.5) }, // 午饭: 写字楼的人出来逛店
  { t: '晚高峰', f: (c) => c.jumpToHour(18) }, // 下班 + 场馆进场
  { t: '夜晚', f: (c) => c.jumpToHour(21.5) }, // 路灯、亮窗
  { t: '下个周末', f: (c) => c.jumpToDayType('weekend', 15) }, // 周末下午 3 点，人最多
  { t: '下个节假日', f: (c) => c.jumpToDayType('holiday', 15) }, // 节假日: 访客更多，地铁按节假日时刻表
  { t: '下一场活动', f: () => window.__city.jumpToNextEvent() }, // 体育场 / 剧院开场前一小时
]
const setRate = (v) => (rate.value = v) // 倍速按钮
const stats = ref(null) // 引擎每秒 emit 的统计（时钟、人数、车数、列车、人群、活动）
const city = ref(null) // CityScene 组件引用
// 点到一栋楼 → 进室内视图；有多种视图（商场 / 地下车库）时用底部的小条切换
const picked = ref(null) // 引擎给的 buildingInfo；null = 没在看室内
const view = ref('') // 当前室内视图类型: mall | garage
const VIEW_LABEL = { mall: '商场', garage: '地下车库' } // 室内视图的中文名
/** 引擎点选回调: 这栋楼有可看的室内视图就进第一个 */
function onSelect(info) {
  if (!info.views.length) return // 住宅 / 写字楼没有室内视图
  picked.value = info
  enter(info.views[0]) // 默认进第一个（商场一层）
}
/** 切换到某种室内视图 */
function enter(kind) {
  view.value = kind
  city.value.showInterior(picked.value.id, kind) // 引擎隐藏楼体、建室内、推镜头
}
/** 退出室内视图 */
function leave() {
  picked.value = null
  city.value.hideInterior() // 拆掉室内、楼体恢复、镜头飞回
}
window.addEventListener('keydown', (e) => e.key === 'Escape' && picked.value && leave()) // Esc 退出室内

// 视角按钮（鼠标: 左键旋转 / 右键平移 / 滚轮缩放；键盘: WASD 平移、Q/E 旋转、R/F 俯仰、+/- 缩放、Home 复位）
const NAV = [
  { t: '⟲', tip: '向左旋转 (Q)', f: () => city.value.orbit(-Math.PI / 8) }, // 每次转 22.5°
  { t: '⟳', tip: '向右旋转 (E)', f: () => city.value.orbit(Math.PI / 8) }, // 反方向
  { t: '▲', tip: '抬高视角 (R)', f: () => city.value.orbit(0, Math.PI / 18) }, // 每次抬 10°
  { t: '▼', tip: '压低视角 (F)', f: () => city.value.orbit(0, -Math.PI / 18) }, // 最低 5°（引擎里夹住）
  { t: '+', tip: '放大 (+)', f: () => city.value.zoomBy(1.35) }, // 每次 ×1.35
  { t: '−', tip: '缩小 (-)', f: () => city.value.zoomBy(1 / 1.35) }, // 放大的倒数
  { t: '⌂', tip: '复位 (Home)', f: () => city.value.resetView() }, // 回到载入时的视角
]
// 方便在控制台调试: __city.setAttraction({ b1: 5 }) 之类
const hasImagery = ref(false) // 当前场景有没有卫星底图（导入的场景才有）
const imagery = ref(true) // 卫星底图开关
/** 场景加载完: 引擎挂到 window 上方便控制台调试；有卫星底图就按开关状态显示 */
const onReady = (engine) => {
  window.__city = engine
  hasImagery.value = engine.hasImagery
  engine.setImagery(imagery.value) // 切场景时保持上一个场景的底图开关
}
// 底图开关: 记住状态 + 通知引擎（引擎隐藏 / 显示程序生成的路面、铺装、区域、标线）
const setImagery = (v) => { imagery.value = v; window.__city?.setImagery(v) }

// 导入的卫星图场景: 列表来自 public/scenes/imported/index.json（导入服务每次处理完都会重写）
const importing = ref(false) // 导入面板开着没有
const imported = ref([]) // [{id: 'imported/<名字>', name, created, summary}]
// 读静态索引而不是 /api/scenes: 导入服务没开时也能看以前导入的场景；没导入过（404）就是空列表
fetch('/scenes/imported/index.json').then((r) => (r.ok ? r.json() : [])).then((l) => (imported.value = l)).catch(() => {})
const onImported = (j) => setTimeout(() => gotoScene(j.scene), 600) // 处理完: 稍等让用户看到 100%，再切过去
</script>

<template>
  <!-- 场景本体: 场景 json 路径 + 人数 / 倍速 / 热力，事件回调见 script -->
  <CityScene
    ref="city"
    :src="`/scenes/${sceneName}.json`"
    :population="base"
    :rate="rate"
    :heat="heat"
    @stats="stats = $event"
    @ready="onReady"
    @select="onSelect"
  />
  <!-- 左下调试条: 场景切换 / 导入 / 底图 → 时钟与倍速 → 跳时间 → 热力 / 人数 → 实时计数 -->
  <div class="debug-bar">
    <!-- 内置场景 -->
    <button v-for="sc in SCENES" :key="sc.id" :class="{ on: sceneName === sc.id }" @click="gotoScene(sc.id)">{{ sc.t }}</button>
    <!-- 导入过的卫星图场景（有才显示） -->
    <select v-if="imported.length" :value="sceneName.startsWith('imported/') ? sceneName : ''" @change="gotoScene($event.target.value)">
      <option value="" disabled>已导入…</option>
      <option v-for="sc in imported" :key="sc.id" :value="sc.id">{{ sc.name }}</option>
    </select>
    <!-- 打开 / 关上导入面板 -->
    <button @click="importing = !importing">导入卫星图</button>
    <!-- 卫星底图开关: 只有导入的场景有底图 -->
    <label v-if="hasImagery"><input :checked="imagery" type="checkbox" @change="setImagery($event.target.checked)" /> 卫星底图</label>
    <!-- 仿真时钟: 日期 · 日子类型 · 时刻 -->
    <span v-if="stats" class="clock">{{ stats.clock.date }} · <b>{{ stats.clock.dayType }}</b> · {{ stats.clock.time }}</span>
    <!-- 倍速档位 -->
    <button v-for="r in RATES" :key="r.v" :class="{ on: rate === r.v }" @click="setRate(r.v)">{{ r.t }}</button>
    <!-- 跳时间 -->
    <button v-for="j in JUMPS" :key="j.t" @click="j.f(city.clock())">{{ j.t }}</button>
    <!-- 屋顶热力图 / 高峰人数 -->
    <label><input v-model="heat" type="checkbox" /> 热力</label>
    <label>高峰人数 <input v-model.number="base" type="range" min="0" max="2000" step="50" /> {{ base }}</label>
    <!-- 实时计数: 街上 / 店内 / 车 / 列车 -->
    <span v-if="stats" class="stat">街上 {{ stats.walking }} · 店内 {{ stats.inside }} · 车 {{ stats.cars }}<template v-if="stats.transit"> · 列车 {{ Object.values(stats.transit.trains).reduce((a, b) => a + b, 0) }}（{{ stats.transit.timetable === 'workday' ? '工作日' : '节假日' }}时刻表）</template></span>
  </div>
  <!-- 左上信息条: 各人群在场人数、住户去向、场馆活动 -->
  <div v-if="stats && (stats.groups || stats.events.length)" class="debug-bar info-bar">
    <!-- 上班族 / 老年人 / 青年 / 访客 -->
    <span v-for="g in stats.groups || []" :key="g.id" class="stat">{{ g.label }} {{ g.active }}</span>
    <!-- 住户: 在家 / 在核心区活动 / 外出 -->
    <span v-if="stats.residents" class="stat">· 住户 在家 {{ stats.residents.home }} / 在核心区活动 {{ stats.residents.out }} / 外出 {{ stats.residents.away }}</span>
    <!-- 场馆活动: 时间、名称、阶段、人数 -->
    <span v-for="ev in stats.events" :key="ev.start + ev.venue" class="stat">
      · {{ ev.venueName }} {{ ev.time }} {{ ev.title }}（{{ { scheduled: '未开始', ingress: '进场中', live: '进行中', egress: '散场中' }[ev.phase] }}，约 {{ ev.realAttendance }} 人）
    </span>
  </div>
  <!-- 右下视角按钮 -->
  <div class="debug-bar nav-bar">
    <!-- 旋转 / 俯仰 / 缩放 / 复位 -->
    <button v-for="n in NAV" :key="n.t" :title="n.tip" @click="n.f">{{ n.t }}</button>
  </div>
  <!-- 底部中央: 室内视图切换（点到楼之后出现） -->
  <div v-if="picked" class="debug-bar interior-bar">
    <!-- 当前楼、可切换的视图、车库占用、退出 -->
    <span>{{ picked.id }}</span>
    <button v-for="k in picked.views" :key="k" :class="{ on: view === k }" @click="enter(k)">{{ VIEW_LABEL[k] }}</button>
    <span v-if="view === 'garage' && picked.garage" class="stat">车位 {{ picked.garage.occupied }}/{{ picked.garage.capacity }}</span>
    <button @click="leave">退出 (Esc)</button>
  </div>
  <!-- 导入卫星图面板: 处理完自动切到新场景 -->
  <ImportPanel v-if="importing" @close="importing = false" @done="onImported" />
</template>

<style scoped>
/* 半透明毛玻璃小条，固定在角落；四条 bar 共用这套样式，各自只覆盖位置 */
.debug-bar {
  flex-wrap: wrap; /* 按钮多，窄屏折行 */
  max-width: calc(100vw - 340px); /* 右边给视角按钮留地方 */
  position: fixed; /* 固定在视口，不随场景动 */
  left: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font: 12px/1.4 system-ui, 'Microsoft YaHei', sans-serif;
  color: #334155;
  background: rgba(255, 255, 255, 0.55); /* 半透明，不挡场景 */
  backdrop-filter: blur(8px); /* 毛玻璃 */
  border-radius: 8px;
  user-select: none; /* 连点按钮时别选中文字 */
}
/* 左上: 人群 / 住户 / 活动 */
.info-bar {
  bottom: auto; /* 取消 .debug-bar 的贴底 */
  top: 12px;
  max-width: calc(100vw - 24px); /* 顶部没有视角按钮，可以占满 */
}
/* 右下: 视角按钮 */
.nav-bar {
  left: auto; /* 取消贴左，改贴右 */
  right: 12px;
  gap: 2px; /* 按钮挨紧一点 */
}
/* 视角按钮是单个符号，给个最小宽度好点 */
.nav-bar button {
  min-width: 28px;
  font-size: 14px;
}
/* 底部居中: 室内视图切换 */
.interior-bar {
  left: 50%;
  transform: translateX(-50%); /* 水平居中 */
}
/* 调试条里的按钮: 无边框透明底，像工具栏 */
.debug-bar button {
  border: 0;
  padding: 3px 10px;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
/* 选中的按钮（当前场景 / 倍速）: 深色实心 */
.debug-bar button.on {
  background: #334155;
  color: #fff;
}
/* 复选框 / 滑条和文字横排 */
.debug-bar label {
  display: flex;
  align-items: center;
  gap: 4px;
}
/* 已导入场景的下拉框 */
.debug-bar select {
  font: inherit;
  border: 0;
  border-radius: 6px;
  padding: 2px 4px;
  background: rgba(255, 255, 255, 0.7);
}
/* 高峰人数滑条 */
.debug-bar input[type='range'] {
  width: 110px;
}
/* 时钟: 等宽数字，时间跳动时宽度不变 */
.clock {
  font-variant-numeric: tabular-nums;
  min-width: 190px;
}
/* 计数类的文字淡一点 */
.stat {
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
</style>
