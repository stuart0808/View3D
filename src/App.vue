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
// 方便在控制台调试: __city.setAttraction({ b1: 5 }) 之类
const onReady = (engine) => (window.__city = engine)
</script>

<template>
  <CityScene
    :src="`/scenes/${sceneName}.json`"
    :population="population"
    :dwell-scale="dwell"
    :heat="heat"
    @stats="stats = $event"
    @ready="onReady"
  />
  <div class="debug-bar">
    <button v-for="(m, key) in MODES" :key="key" :class="{ on: mode === key }" @click="mode = key">{{ m.label }}</button>
    <label><input v-model="heat" type="checkbox" /> 热力</label>
    <label>人数 <input v-model.number="base" type="range" min="0" max="2000" step="50" /> {{ population }}</label>
    <span v-if="stats" class="stat">街上 {{ stats.walking }} · 店内 {{ stats.inside }}</span>
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
