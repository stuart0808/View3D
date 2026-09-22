// 入口: 挂载演示壳 App.vue（真正的场景组件是 components/CityScene.vue，引擎在 city/CityEngine.js）
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app') // 挂到 index.html 里 id 为 app 的 div
