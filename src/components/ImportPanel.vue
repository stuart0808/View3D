<script setup>
// 「导入卫星图」小面板: 选图 → 填比例尺（或地理位置）→ 上传给 tools/sat_server.py → 轮询进度 → 完成后切到新场景。
// 后端没开时给出启动命令。比例尺三种给法:
//   米/像素     已知分辨率的图
//   网络地图截图 中心经纬度 + 缩放级别（+ 高分屏倍率、坐标系）: 还能顺带从 OpenStreetMap 取道路 / 水系
//   GeoTIFF     自带坐标，什么都不用填
import { computed, ref } from 'vue'

// close: 点了右上角 ×；done(job): 处理完成，父组件据此切到新场景（job.scene = 'imported/<名字>'）
const emit = defineEmits(['close', 'done'])
const file = ref(null) // 选中的图片 File
const name = ref('') // 场景名（文件名去扩展名，非法字符换成 _）
const mode = ref('mpp') // mpp | web | tif
const mpp = ref(0.3) // 米/像素；0.3 是常见高分卫星图的分辨率
// 截图中心的经纬度（默认上海市中心）和地图缩放级别: 18 级在上海约 0.5 m/像素，高分屏截图再减半
const lat = ref(31.23)
const lon = ref(121.47)
const zoom = ref(18)
const hidpi = ref(false) // 高分屏截图: 每个地图像素占 2 个屏幕像素
const datum = ref('wgs84') // 高德 / 腾讯卫星图用 gcj02
const useOsm = ref(true) // 从 OpenStreetMap 取道路 / 水系（只有给了地理位置才有意义）
const refFloors = ref('') // 可选: 这一片的楼大多几层；影子估高按它定整体比例（不填按太阳高度角 50° 估）
const job = ref(null) // 后端返回的进度
const error = ref('')
// 处理中（排队或运行）时按钮置灰，避免重复提交同一张图
const busy = computed(() => job.value && (job.value.state === 'queued' || job.value.state === 'running'))
const pct = computed(() => Math.round((job.value?.progress || 0) * 100)) // 进度条百分比

/** 选文件: 顺便猜场景名、GeoTIFF 自动切到「自带坐标」 */
function pick(e) {
  const f = e.target.files[0]
  if (!f) return // 取消了选择
  file.value = f
  // 场景名会变成文件名和 URL，后端只收字母数字下划线横线: 其他字符（包括中文）都换成 _
  name.value = f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'sat'
  if (/\.tiff?$/i.test(f.name)) mode.value = 'tif'
}

/** 上传 + 轮询 */
async function start() {
  error.value = ''
  if (!file.value) return (error.value = '先选一张卫星图')
  // 参数都放在查询串里，请求体就是图片本身（不用 multipart，后端解析简单）
  const q = new URLSearchParams({ name: name.value, osm: useOsm.value && mode.value !== 'mpp' ? '1' : '0' })
  if (mode.value === 'mpp') q.set('mpp', mpp.value)
  if (+refFloors.value > 0) q.set('ref_floors', refFloors.value) // 空着就不传
  // 截图模式: 后端按 Web 墨卡托把 中心 + 级别 换成每个像素的经纬度
  if (mode.value === 'web') {
    q.set('lat', lat.value); q.set('lon', lon.value); q.set('zoom', zoom.value)
    q.set('scale', hidpi.value ? 2 : 1); q.set('datum', datum.value)
  }
  let r
  // 请求本身失败（连接被拒）说明 sat_server 没开；返回了但不是 JSON（Vite 代理 502 等）也提示去开服务
  try {
    r = await fetch('/api/import?' + q, { method: 'POST', body: file.value, headers: { 'Content-Type': file.value.type || 'application/octet-stream' } })
  } catch (e) {
    return (error.value = '连不上导入服务。先在项目目录运行: python tools/sat_server.py')
  }
  const j = await r.json().catch(() => ({ error: `导入服务没响应（${r.status}）。先运行: python tools/sat_server.py` }))
  if (j.error) return (error.value = j.error)
  job.value = { state: 'queued', progress: 0, stage: '排队' } // 先显示排队，等第一次轮询回来再更新
  poll(j.job)
}

/** 每秒问一次进度，完成后通知父组件切场景 */
function poll(id) {
  const t = setInterval(async () => {
    const j = await fetch('/api/jobs/' + id).then((r) => r.json()).catch(() => null)
    if (!j) return // 偶尔一次请求失败不要紧，下一秒再问
    job.value = j
    if (j.state === 'done') { clearInterval(t); emit('done', j) }
    if (j.state === 'error') { clearInterval(t); error.value = j.error }
  }, 1000)
}
</script>

<template>
  <div class="imp">
    <!-- 标题 + 关闭 -->
    <div class="row head"><b>导入卫星图</b><button @click="emit('close')">×</button></div>
    <!-- 选图: jpg / png 截图，或带坐标的 GeoTIFF -->
    <label class="row"><input type="file" accept="image/png,image/jpeg,.tif,.tiff" @change="pick" /></label>
    <!-- 场景名: 生成 public/scenes/imported/<场景名>.json，同名会覆盖 -->
    <label class="row">场景名 <input v-model="name" /></label>
    <!-- 比例尺的三种给法（见 script 开头说明） -->
    <div class="row tabs">
      <!-- 已知 米/像素 -->
      <button :class="{ on: mode === 'mpp' }" @click="mode = 'mpp'">米/像素</button>
      <!-- 截图: 给中心经纬度 + 缩放级别 -->
      <button :class="{ on: mode === 'web' }" @click="mode = 'web'">网络地图截图</button>
      <!-- GeoTIFF: 自带坐标 -->
      <button :class="{ on: mode === 'tif' }" @click="mode = 'tif'">GeoTIFF</button>
    </div>
    <!-- 已知分辨率 -->
    <div v-if="mode === 'mpp'" class="row">分辨率 <input v-model.number="mpp" type="number" step="0.01" min="0.05" /> 米/像素</div>
    <!-- 网络地图截图: 中心点 + 缩放级别 + 截图倍率 + 坐标系 -->
    <template v-if="mode === 'web'">
      <!-- 截图正中那个点的经纬度（地图应用里右键 / 长按能看到） -->
      <div class="row">中心纬度 <input v-model.number="lat" type="number" step="0.0001" /> 经度 <input v-model.number="lon" type="number" step="0.0001" /></div>
      <!-- 缩放级别可以带小数（浏览器缩放过）；高分屏截图勾上 -->
      <div class="row">缩放级别 <input v-model.number="zoom" type="number" step="0.5" /> <label><input v-model="hidpi" type="checkbox" /> 高分屏截图</label></div>
      <!-- 高德 / 腾讯的卫星图有火星偏移，选 GCJ-02 才能和 OSM 对上 -->
      <div class="row">坐标系
        <select v-model="datum"><option value="wgs84">WGS84（谷歌 / 天地图 / Esri）</option><option value="gcj02">GCJ-02（高德 / 腾讯）</option></select>
      </div>
    </template>
    <!-- GeoTIFF: 坐标、分辨率都在文件里 -->
    <p v-if="mode === 'tif'" class="hint">GeoTIFF 自带坐标和分辨率（需为经纬度坐标系）。</p>
    <!-- 有地理位置才能取 OSM；没有时提示效果会差一些 -->
    <label v-if="mode !== 'mpp'" class="row"><input v-model="useOsm" type="checkbox" /> 从 OpenStreetMap 取道路、水系、绿地（需联网）</label>
    <!-- 只给分辨率时的提醒 -->
    <p v-if="mode === 'mpp'" class="hint">只给分辨率时没有地理位置，道路只能靠图像，效果差一些；能给出经纬度更好。</p>
    <!-- 参考层数（可选）: 影子只给出楼的相对高矮，绝对高度靠它或默认太阳高度角 -->
    <div class="row">参考层数 <input v-model="refFloors" type="number" min="1" step="1" placeholder="可不填" /> <span class="hint">这一片的楼大多几层</span></div>
    <!-- 开始 / 进度 / 结果摘要 / 错误 -->
    <div class="row"><button class="go" :disabled="busy" @click="start">{{ busy ? '处理中…' : '开始处理' }}</button></div>
    <!-- 进度条: 阶段名 + 百分比 -->
    <div v-if="job" class="bar"><i :style="{ width: pct + '%' }"></i><span>{{ job.stage }} {{ pct }}%</span></div>
    <!-- 完成后的摘要: 尺寸、分辨率、建筑数（用了哪种识别方法）、OSM 道路数、用时 -->
    <p v-if="job?.summary" class="hint">
      {{ job.summary.width }}×{{ job.summary.height }} 像素 · {{ job.summary.mpp }} m/px · 建筑 {{ job.summary.buildings }} 栋（{{ { roofnet: '分割网络', sam: 'SAM', color: '颜色' }[job.summary.method] }}）
      <!-- 取了 OSM 才显示道路条数 -->
      <template v-if="job.summary.osm_roads !== undefined"> · OSM 道路 {{ job.summary.osm_roads }} 条</template> · {{ job.summary.seconds }} 秒
    </p>
    <!-- 错误: 参数不对 / 服务没开 / 处理失败 -->
    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
/* 和调试条同一套半透明毛玻璃风格，居中偏上 */
.imp {
  position: fixed; /* 浮在场景上面，不随场景缩放 */
  top: 60px; /* 让开左上角的人群信息条 */
  left: 50%;
  transform: translateX(-50%); /* 水平居中 */
  width: 420px;
  max-width: calc(100vw - 24px); /* 窄屏时两边留 12px */
  padding: 12px 14px; /* 内边距 */
  font: 12px/1.5 system-ui, 'Microsoft YaHei', sans-serif; /* 和调试条同一套字体 */
  color: #334155; /* 深蓝灰字 */
  background: rgba(255, 255, 255, 0.86); /* 比调试条更不透明: 表单要看得清 */
  backdrop-filter: blur(10px); /* 毛玻璃: 透出后面的场景但不干扰阅读 */
  border-radius: 10px; /* 大圆角 */
  box-shadow: 0 6px 24px rgba(15, 23, 42, 0.18); /* 轻阴影，和场景分层 */
  z-index: 10; /* 盖在调试条上面 */
}
/* 一行: 标签 + 输入框横排，放不下自动折行 */
.row { display: flex; align-items: center; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
/* 标题行: 标题靠左、关闭按钮靠右 */
.head { justify-content: space-between; font-size: 13px; }
/* 输入框 / 下拉框: 细边框小圆角，字体跟随面板 */
input:not([type='checkbox']), select { padding: 2px 6px; border: 1px solid #cbd5e1; border-radius: 5px; font: inherit; }
input[type='number'] { width: 84px; } /* 经纬度要 7 位数字，84px 够 */
/* 普通按钮: 白底细边 */
button { border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; }
/* 选中的比例尺方式、「开始处理」按钮: 深色实心 */
button.on, button.go { background: #334155; color: #fff; border-color: #334155; }
button:disabled { opacity: 0.6; cursor: default; } /* 处理中 */
/* 提示语灰色；错误红色，保留换行（后端的报错可能是多行日志） */
.hint { color: #64748b; margin: 4px 0; }
.err { color: #dc2626; margin: 4px 0; white-space: pre-wrap; }
/* 进度条: 灰底 + 蓝色填充（宽度动画），文字叠在上面 */
.bar { position: relative; height: 18px; background: #e2e8f0; border-radius: 9px; overflow: hidden; margin: 6px 0; }
/* 蓝色填充条，宽度 = 进度，0.4s 过渡让它平滑长 */
.bar i { position: absolute; inset: 0 auto 0 0; background: #60a5fa; transition: width 0.4s; }
/* 文字叠在填充条上（relative 让它排在绝对定位的 i 之上） */
.bar span { position: relative; padding-left: 8px; line-height: 18px; }
</style>
