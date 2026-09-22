// 实地标注页（survey.html）的入口: 手机上打开，在卫星图 / 楼轮廓上标商户的门口和临街范围
import { createApp } from 'vue'
import SurveyApp from './SurveyApp.vue'

createApp(SurveyApp).mount('#app') // 挂到 survey.html 里 id 为 app 的 div
