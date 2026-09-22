// 测试配置。src/city 里大部分模块是纯逻辑（时钟、需求模型、几何、车道划分…），直接在 node 里跑；
// 用到 document.createElement('canvas') 的模块（导航网格、建筑贴图）在 jsdom 环境下跑，见各测试文件顶部的 @vitest-environment 注释。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // three 是 ESM 包，vitest 默认能处理；这里只是把超时放宽一点，导航网格的距离场测试要算几十万格
    testTimeout: 20000,
  },
})
