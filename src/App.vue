<script setup>
import { computed, ref } from 'vue'
import CityScene from './components/CityScene.vue'

// 角落里这一小条只是调试用的开关，正式接入时删掉即可，CityScene 本身不带任何 UI。
// ?scene=xxx 可切换 public/scenes/xxx.json
const sceneName = new URLSearchParams(location.search).get('scene') || 'demo'
const mode = ref('weekday')
const heat = ref(true)
const base = ref(600)

const MODES = {
  weekday: { label: '工作日', population: 1, dwell: 1 },
  weekend: { label: '周末', population: 1.8, dwell: 1.3 },
}
const population = computed(() => Math.round(base.value * MODES[mode.value].population))
const dwell = computed(() => MODES[mode.value].dwell)
const stats = ref(null)
const city = ref(null)
// 点到一栋楼 → 进室内视图；有多种视图（商场 / 地下车库）时用底部的小条切换
const picked = ref(null)
const view = ref('')
const VIEW_LABEL = { mall: '商场', garage: '地下车库' }
function onSelect(info) {
  if (!info.views.length) return
  picked.value = info
  enter(info.views[0])
}
function enter(kind) {
  view.value = kind
  city.value.showInterior(picked.value.id, kind)
}
function leave() {
  picked.value = null
  city.value.hideInterior()
}
window.addEventListener('keydown', (e) => e.key === 'Escape' && picked.value && leave())

// 视角按钮（鼠标: 左键旋转 / 右键平移 / 滚轮缩放；键盘: WASD 平移、Q/E 旋转、R/F 俯仰、+/- 缩放、Home 复位）
const NAV = [
  { t: '⟲', tip: '向左旋转 (Q)', f: () => city.value.orbit(-Math.PI / 8) },
  { t: '⟳', tip: '向右旋转 (E)', f: () => city.value.orbit(Math.PI / 8) },
  { t: '▲', tip: '抬高视角 (R)', f: () => city.value.orbit(0, Math.PI / 18) },
  { t: '▼', tip: '压低视角 (F)', f: () => city.value.orbit(0, -Math.PI / 18) },
  { t: '+', tip: '放大 (+)', f: () => city.value.zoomBy(1.35) },
  { t: '−', tip: '缩小 (-)', f: () => city.value.zoomBy(1 / 1.35) },
  { t: '⌂', tip: '复位 (Home)', f: () => city.value.resetView() },
]
// 方便在控制台调试: __city.setAttraction({ b1: 5 }) 之类
const onReady = (engine) => (window.__city = engine)
</script>

<template>
  <CityScene
    ref="city"
    :src="`/scenes/${sceneName}.json`"
    :population="population"
    :dwell-scale="dwell"
    :heat="heat"
    @stats="stats = $event"
    @ready="onReady"
    @select="onSelect"
  />
  <div class="debug-bar">
    <button v-for="(m, key) in MODES" :key="key" :class="{ on: mode === key }" @click="mode = key">{{ m.label }}</button>
    <label><input v-model="heat" type="checkbox" /> 热力</label>
    <label>人数 <input v-model.number="base" type="range" min="0" max="2000" step="50" /> {{ population }}</label>
    <span v-if="stats" class="stat">街上 {{ stats.walking }} · 店内 {{ stats.inside }}</span>
  </div>
  <div class="debug-bar nav-bar">
    <button v-for="n in NAV" :key="n.t" :title="n.tip" @click="n.f">{{ n.t }}</button>
  </div>
  <div v-if="picked" class="debug-bar interior-bar">
    <span>{{ picked.id }}</span>
    <button v-for="k in picked.views" :key="k" :class="{ on: view === k }" @click="enter(k)">{{ VIEW_LABEL[k] }}</button>
    <span v-if="view === 'garage' && picked.garage" class="stat">车位 {{ picked.garage.occupied }}/{{ picked.garage.capacity }}</span>
    <button @click="leave">退出 (Esc)</button>
  </div>
</template>

<style scoped>
.debug-bar {
  position: fixed;
  left: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font: 12px/1.4 system-ui, 'Microsoft YaHei', sans-serif;
  color: #334155;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(8px);
  border-radius: 8px;
  user-select: none;
}
.nav-bar {
  left: auto;
  right: 12px;
  gap: 2px;
}
.nav-bar button {
  min-width: 28px;
  font-size: 14px;
}
.interior-bar {
  left: 50%;
  transform: translateX(-50%);
}
.debug-bar button {
  border: 0;
  padding: 3px 10px;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.debug-bar button.on {
  background: #334155;
  color: #fff;
}
.debug-bar label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.debug-bar input[type='range'] {
  width: 110px;
}
.stat {
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
</style>
