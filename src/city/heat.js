// 屋顶热力图: 把人群密度溅射到一张低分辨率画布上，屋顶覆盖层按世界坐标采样并做色带映射。
import * as THREE from 'three'
import { hiddenBuilding } from './buildings.js'

export class HeatLayer {
  constructor(scene, geometry, { metersPerPixel = 1.5 } = {}) {
    const b = scene.bounds
    this.minX = b.minX
    this.minY = b.minY
    this.mpp = metersPerPixel
    this.canvas = document.createElement('canvas')
    this.canvas.width = Math.ceil((b.maxX - b.minX) / metersPerPixel)
    this.canvas.height = Math.ceil((b.maxY - b.minY) / metersPerPixel)
    this.ctx = this.canvas.getContext('2d')
    this.ctx.fillStyle = '#000'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.sprite = this.#makeSprite(64)

    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = false

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        heatMap: { value: this.texture },
        origin: { value: new THREE.Vector2(b.minX, b.minY) },
        size: { value: new THREE.Vector2(b.maxX - b.minX, b.maxY - b.minY) },
        opacity: { value: 0.9 },
        hiddenBid: hiddenBuilding,
      },
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
          float v = texture2D(heatMap, vec2(uv.x, 1.0 - uv.y)).r;
          float a = smoothstep(0.04, 0.35, v) * opacity;
          gl_FragColor = vec4(ramp(clamp(v * 1.15, 0.0, 1.0)), a);
          #include <colorspace_fragment>
        }`,
    })
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.name = 'heat'
    this.mesh.renderOrder = 2
    this.elapsed = 0
  }

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
   * @param samples Float32Array [x, y, weight, ...]，count 为样本个数
   * 每次先整体衰减再叠加，得到时间上平滑的密度。
   */
  update(dt, samples, count, gain = 1) {
    this.elapsed += dt
    if (this.elapsed < 0.2) return
    this.elapsed = 0
    const { ctx, mpp } = this
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(0,0,0,0.10)'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.globalCompositeOperation = 'lighter'
    const r = 13 / mpp // 溅射半径 13m
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
