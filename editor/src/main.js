// 场景编辑器页（editor/index.html，地址 /editor/）的入口: 画路、楼、区域，生成场景后在仿真里打开
import { createApp } from 'vue'
import EditorApp from './EditorApp.vue'

createApp(EditorApp).mount('#app') // 挂到 editor/index.html 里 id 为 app 的 div
