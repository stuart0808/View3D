// 屋顶热力图: 把「店里有多少人」画成屋顶上的色斑。
//
// 做法（两步，都很便宜）:
//   1. CPU 端: 一张低分辨率（1.5m/像素）的 canvas，每 0.2s 整体乘 0.9 衰减，再把每个「在店里的人」按热力落点
//      用径向渐变的小圆盘「溅射」上去（lighter 混合 = 相加）。时间上的指数平滑让色斑不会一闪一闪
//   2. GPU 端: 屋顶几何体用一个自定义 shader，按顶点的世界坐标去采样这张 canvas 纹理，密度值过一条色带
//      （薄荷绿 → 青蓝 → 蓝 → 紫），密度低于阈值的地方全透明
// 屋顶几何体来自 buildings.js（每栋楼的屋面板，带 bid 属性），所以室内视图隐藏某栋楼时热力层也跟着隐藏。
// 只覆盖逐人仿真的区域（activeRegion），别处没有人也就没有热力。
import * as THREE from 'three'
import { hiddenBuilding } from './buildings.js'

export class HeatLayer {
  /**
   * @param scene           scene.json，取热力范围
   * @param geometry        屋顶几何体（buildings.js 合并好的 heatGeometry）
   * @param metersPerPixel  canvas 分辨率，越粗越省，1.5m 在等轴测远景里看不出像素
   */
  constructor(scene, geometry, { metersPerPixel = 1.5 } = {}) {
    const b = scene.activeRegion || scene.bounds // 热力只来自逐人仿真的区域
    this.minX = b.minX
    this.minY = b.minY
    this.mpp = metersPerPixel
    // 密度画布: 黑 = 0，越亮越密
    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.ceil((b.maxX - b.minX) / metersPerPixel)
    this.canvas.height = Math.ceil((b.maxY - b.minY) / metersPerPixel)
    this.ctx = this.canvas.getContext('2d')
    this.ctx.fillStyle = '#000'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.sprite = this.#makeSprite(64)

    // canvas → 纹理。NoColorSpace: 存的是密度不是颜色，不能做 sRGB 转换；不要 mipmap，每 0.2s 更新一次太贵
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false, // 半透明覆盖层，不写深度，免得挡住后面的东西
      uniforms: {
        heatMap: { value: this.texture },
        origin: { value: new THREE.Vector2(b.minX, b.minY) }, // 世界坐标 → 纹理 uv 的换算
        size: { value: new THREE.Vector2(b.maxX - b.minX, b.maxY - b.minY) },
        opacity: { value: 0.9 },
        hiddenBid: hiddenBuilding, // 和 buildings.js 共用同一个 uniform 对象，改一处两边都变
      },
      // 顶点: 把世界 xz 传给片元当采样坐标；被隐藏的楼（室内视图）把顶点扔到裁剪空间外
      vertexShader: /* glsl */ `
        attribute float bid;
        uniform float hiddenBid;
        varying vec2 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xz;
          gl_Position = projectionMatrix * viewMatrix * w;
          if (abs(bid - hiddenBid) < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        }`,
      // 片元: 采样密度 → 色带；密度 < 0.04 全透明，0.35 以上全显示
      fragmentShader: /* glsl */ `
        uniform sampler2D heatMap;
        uniform vec2 origin, size;
        uniform float opacity;
        varying vec2 vWorld;
        vec3 ramp(float t) {
          vec3 c0 = vec3(0.45, 0.93, 0.78);  // 薄荷绿
          vec3 c1 = vec3(0.35, 0.78, 0.96);  // 青蓝
          vec3 c2 = vec3(0.42, 0.52, 0.98);  // 蓝
          vec3 c3 = vec3(0.62, 0.38, 0.96);  // 紫
          if (t < 0.33) return mix(c0, c1, t / 0.33);
          if (t < 0.66) return mix(c1, c2, (t - 0.33) / 0.33);
          return mix(c2, c3, (t - 0.66) / 0.34);
        }
        void main() {
          vec2 uv = (vWorld - origin) / size;
          float v = texture2D(heatMap, vec2(uv.x, 1.0 - uv.y)).r; // canvas 的 y 向下，纹理的 v 向上
          float a = smoothstep(0.04, 0.35, v) * opacity;
          gl_FragColor = vec4(ramp(clamp(v * 1.15, 0.0, 1.0)), a);
          #include <colorspace_fragment>
        }`,
    })
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.name = 'heat'
    this.mesh.renderOrder = 2 // 在不透明的屋顶之后画
    this.elapsed = 0
  }

  /** 溅射用的圆盘: 中心白、边缘透明的径向渐变 */
  #makeSprite(size) {
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    const ctx = cv.getContext('2d')
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.5, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    return cv
  }

  /**
   * 每帧调用；内部每 0.2s（现实时间）才真正重画一次 —— 时间平滑按现实时间走，仿真倍速再高也不闪。
   * @param samples Float32Array [x, y, weight, ...]，count 为样本个数（crowd.js 里每个在店内的人一条）
   * @param gain    整体增益，人少的场景可以调大
   */
  update(dt, samples, count, gain = 1) {
    this.elapsed += dt
    if (this.elapsed < 0.2) return
    this.elapsed = 0
    const { ctx, mpp } = this
    // 先整体衰减 10%（往上叠一层 10% 的黑），再相加溅射
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(0,0,0,0.10)'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.globalCompositeOperation = 'lighter'
    const r = 13 / mpp // 溅射半径 13m: 大约一家店面的范围
    for (let i = 0; i < count; i++) {
      ctx.globalAlpha = Math.min(1, samples[i * 3 + 2] * 0.035 * gain)
      ctx.drawImage(this.sprite, (samples[i * 3] - this.minX) / mpp - r, (samples[i * 3 + 1] - this.minY) / mpp - r, r * 2, r * 2)
    }
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
    this.material.dispose()
  }
}
