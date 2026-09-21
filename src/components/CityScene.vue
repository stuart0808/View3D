<script setup>
// Three.js 对象一律不放进 Vue 的响应式系统（不要 ref/reactive 包它们），否则 Proxy 会拖垮性能。
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { CityEngine } from '../city/CityEngine.js'

const props = defineProps({
  /** scene.json 的地址；与 scene 二选一 */
  src: { type: String, default: '' },
  /** 直接传入已解析的场景对象 */
  scene: { type: Object, default: null },
  /** 一天里高峰时刻的同时在场人数（实际人数随仿真时钟的日曲线变化） */
  population: { type: Number, default: 600 },
  /** 店内停留时长倍率 */
  dwellScale: { type: Number, default: 1 },
  /** { 建筑id: 吸引力 }，接后端的客流/消费测算结果 */
  attraction: { type: Object, default: null },
  heat: { type: Boolean, default: true },
  timeScale: { type: Number, default: 2 },
  peopleScale: { type: Number, default: 1.5 },
  styleOverrides: { type: Object, default: null },
})
const emit = defineEmits(['ready', 'error', 'stats', 'select'])

const host = ref(null)
let engine = null
let statsTimer = 0

async function reload() {
  if (!engine) return
  try {
    if (props.scene) engine.load(props.scene)
    else if (props.src) await engine.loadUrl(props.src)
    else return
    if (props.attraction) engine.setAttraction(props.attraction)
    emit('ready', engine)
  } catch (e) {
    console.error(e)
    emit('error', e)
  }
}

onMounted(() => {
  engine = new CityEngine(host.value, {
    timeScale: props.timeScale, peopleScale: props.peopleScale, style: props.styleOverrides || {},
    // 点到一栋楼: 交给外面决定看哪个室内视图；外面不处理（没监听 select）时引擎会直接进第一个可用视图
    onSelect: (info) => emit('select', info),
  })
  engine.setPopulation(props.population)
  engine.setDwellScale(props.dwellScale)
  engine.setHeatVisible(props.heat)
  reload()
  statsTimer = window.setInterval(() => {
    const s = engine?.stats()
    if (s) emit('stats', s)
  }, 1000)
})

onBeforeUnmount(() => {
  clearInterval(statsTimer)
  engine?.dispose()
  engine = null
})

watch(() => [props.src, props.scene], reload)
watch(() => props.population, (v) => engine?.setPopulation(v))
watch(() => props.dwellScale, (v) => engine?.setDwellScale(v))
watch(() => props.heat, (v) => engine?.setHeatVisible(v))
watch(() => props.timeScale, (v) => engine?.setTimeScale(v))
watch(() => props.attraction, (v) => v && engine?.setAttraction(v), { deep: true })

defineExpose({
  getEngine: () => engine,
  clock: () => engine?.clock,
  showInterior: (id, kind) => engine?.showInterior(id, kind),
  orbit: (dAz, dEl) => engine?.orbit(dAz, dEl),
  pan: (r, u) => engine?.pan(r, u),
  zoomBy: (f) => engine?.zoomBy(f),
  resetView: () => engine?.resetView(),
  hideInterior: () => engine?.hideInterior(),
})
</script>

<template>
  <div ref="host" class="city-scene"></div>
</template>

<style scoped>
.city-scene {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
