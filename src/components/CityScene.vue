<script setup>
// 场景组件: 一个占满容器的 div，里面跑 CityEngine（src/city/CityEngine.js）。
// 组件只做三件事: 把 props 转成引擎调用、每秒把引擎统计 emit 出去、把相机 / 室内视图的方法暴露给父组件。
// 事件: ready(engine) 场景加载完；error(e)；stats(s) 每秒一次；select(info) 点到了一栋楼。
//
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
  /** 是否显示屋顶热力图 */
  heat: { type: Boolean, default: true },
  /** 仿真速度（倍）: 人、车、红绿灯、时刻表全部按它推进。0 = 暂停 */
  rate: { type: Number, default: 10 },
  /** 小人显示放大倍数 */
  peopleScale: { type: Number, default: 1.5 },
  /** 覆盖 DEFAULT_STYLE 的配色项 */
  styleOverrides: { type: Object, default: null },
})
const emit = defineEmits(['ready', 'error', 'stats', 'select'])

const host = ref(null) // 挂载点
let engine = null // 引擎实例（普通变量，不响应式）
let statsTimer = 0

/** 按 props 重新加载场景: scene 对象优先，其次 src 地址；加载完套上吸引力并通知父组件 */
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
  // 建引擎、套初始参数、加载场景、开统计定时器
  engine = new CityEngine(host.value, {
    clock: { rate: props.rate || 1 }, peopleScale: props.peopleScale, style: props.styleOverrides || {},
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

onBeforeUnmount(() => { // 释放 WebGL 资源和定时器
  clearInterval(statsTimer)
  engine?.dispose()
  engine = null
})

// props 变化 → 引擎调用
watch(() => [props.src, props.scene], reload)
watch(() => props.population, (v) => engine?.setPopulation(v))
watch(() => props.dwellScale, (v) => engine?.setDwellScale(v))
watch(() => props.heat, (v) => engine?.setHeatVisible(v))
watch(() => props.rate, (v) => engine?.setRate(v))
watch(() => props.attraction, (v) => v && engine?.setAttraction(v), { deep: true })

// 父组件通过 ref 调用: 拿引擎、时钟，开关室内视图，相机旋转 / 平移 / 缩放 / 复位
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
