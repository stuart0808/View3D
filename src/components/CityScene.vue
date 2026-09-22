<script setup>
// 场景组件: 一个占满容器的 div，里面跑 CityEngine（src/city/CityEngine.js）。
// 组件只做三件事: 把 props 转成引擎调用、每秒把引擎统计 emit 出去、把相机 / 室内视图的方法暴露给父组件。
// 事件: ready(engine) 场景加载完；error(e)；stats(s) 每秒一次；select(info) 点到了一栋楼。
//
// Three.js 对象一律不放进 Vue 的响应式系统（不要 ref/reactive 包它们），否则 Proxy 会拖垮性能。
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { CityEngine } from '../city/CityEngine.js'

// 全部 props 都是「声明式」的: 改了就同步到引擎（见下面的 watch）
const props = defineProps({
  /** scene.json 的地址；与 scene 二选一（scene 优先） */
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
const emit = defineEmits(['ready', 'error', 'stats', 'select']) // 见文件头

const host = ref(null) // 挂载点
let engine = null // 引擎实例（普通变量，不响应式）
let statsTimer = 0

/** 按 props 重新加载场景: scene 对象优先，其次 src 地址；加载完套上吸引力并通知父组件 */
async function reload() {
  if (!engine) return
  try {
    if (props.scene) engine.load(props.scene) // 同步
    else if (props.src) await engine.loadUrl(props.src) // fetch + load
    else return // 两个都没给: 空场景
    if (props.attraction) engine.setAttraction(props.attraction) // 场景加载后才有人群，吸引力要在这之后套
    emit('ready', engine) // 父组件拿到引擎（调试用）
  } catch (e) {
    console.error(e) // 控制台也留一份，方便调试
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
  reload() // 异步，不等
  statsTimer = window.setInterval(() => { // 每秒一次统计，够界面刷新用，又不会拖慢渲染
    const s = engine?.stats()
    if (s) emit('stats', s)
  }, 1000)
})

onBeforeUnmount(() => { // 释放 WebGL 资源和定时器
  clearInterval(statsTimer)
  engine?.dispose() // 停帧循环、拆场景、摘 canvas
  engine = null // 之后的 watch 回调都会因为 engine 为空而跳过
})

// props 变化 → 引擎调用
watch(() => [props.src, props.scene], reload) // 换场景
watch(() => props.population, (v) => engine?.setPopulation(v)) // 其余都是即时生效的参数
watch(() => props.dwellScale, (v) => engine?.setDwellScale(v))
watch(() => props.heat, (v) => engine?.setHeatVisible(v))
watch(() => props.rate, (v) => engine?.setRate(v))
watch(() => props.attraction, (v) => v && engine?.setAttraction(v), { deep: true }) // 对象内部改了也要触发

// 父组件通过 ref 调用: 拿引擎、时钟，开关室内视图，相机旋转 / 平移 / 缩放 / 复位
defineExpose({
  getEngine: () => engine, // 需要更多控制时直接拿引擎
  clock: () => engine?.clock, // 仿真时钟: jumpToHour / jumpToDayType / setRate
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
/* 容器占满父元素；引擎用 ResizeObserver 跟随它的尺寸。overflow hidden 防止 canvas 撑出滚动条 */
.city-scene {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
