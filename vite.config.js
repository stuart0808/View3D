import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// /api 转给卫星图导入服务（python tools/sat_server.py，端口 8770）；导入的场景写在 public/scenes/imported/，vite 直接当静态文件发。
// 注意别把 public/scenes/imported 加进 watch.ignored: vite 靠文件监听维护 public 目录的文件清单，忽略了新生成的场景就取不到
export default defineConfig({
  plugins: [
    vue(),
    // 场景编辑器从根目录的 editor.html 搬到了 editor/（地址 /editor/）: 旧链接 / 书签自动跳过去，查询参数保留
    {
      name: 'editor-old-url',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url.startsWith('/editor.html')) return next() // 别的请求照常
          res.statusCode = 302 // 临时跳转
          res.setHeader('Location', req.url.replace('/editor.html', '/editor/'))
          res.end()
        })
      },
    },
  ],
  // 三个页面: index.html（三维仿真）、survey.html（手机上的实地标注工具）、editor/index.html（场景编辑器，地址 /editor/）；打包时都要出
  build: {
    rollupOptions: { input: { main: 'index.html', survey: 'survey.html', editor: 'editor/index.html' } },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8770' },
  },
})
