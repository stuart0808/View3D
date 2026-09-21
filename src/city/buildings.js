// 由二维轮廓程序化生成「白模 + 店面」风格的建筑。只依赖轮廓、层数和哪些边临街。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { signedArea, edgeNormal, offsetPolygon, roundPolygon, makeShape, toGround, interiorPoints, distToPolygonEdge } from './geometry.js'

const FLOOR_H = 4.4
const CORNER_R = 1.6

// 店面主题: [玻璃色, 招牌色]
const SHOP_THEMES = [
  ['#8fb4cf', '#2b3a4e'],
  ['#9cc0d6', '#23405c'],
  ['#d9a86a', '#6b4226'],
  ['#e0b57c', '#8a5a33'],
  ['#a9b6c2', '#33363c'],
  ['#c9935a', '#3a2a20'],
]

export function buildBuildings(scene, nav, rand, style) {
  const group = new THREE.Group()
  group.name = 'buildings'
  const walls = [], trims = [], roofs = [], heatRoofs = []
  const glass = [], signs = [], frames = [] // {pos, quat, scale, color}

  for (const b of scene.buildings) {
    const h = (b.floors || 2) * FLOOR_H
    const holes = b.holes || []
    const body = roundPolygon(b.polygon, CORNER_R)
    const rHoles = holes.map((hh) => roundPolygon(hh, 0.8))

    // 墙体
    walls.push(toGround(new THREE.ExtrudeGeometry(makeShape(body, rHoles), { depth: h, bevelEnabled: false, curveSegments: 1 })))

    // 屋檐 + 女儿墙: 外轮廓外扩做挑檐，内缩做女儿墙内沿
    const outer = offsetPolygon(b.polygon, 0.4) || b.polygon
    const inner = offsetPolygon(b.polygon, -0.55)
    const outerR = roundPolygon(outer, CORNER_R + 0.4)
    const okInner = inner && Math.abs(signedArea(inner)) > Math.abs(signedArea(b.polygon)) * 0.4
    if (okInner) {
      const innerR = roundPolygon(inner, Math.max(0.3, CORNER_R - 0.55))
      const holeRings = [innerR]
      // 内院: 女儿墙环也要避开
      const innerHoles = holes.map((hh) => offsetPolygon(hh, 0.4) || hh)
      trims.push(toGround(new THREE.ExtrudeGeometry(makeShape(outerR, holeRings), {
        depth: 1.0, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 1,
      }), h - 0.45))
      roofs.push(toGround(new THREE.ShapeGeometry(makeShape(innerR, innerHoles.map((x) => roundPolygon(x, 0.8)))), h + 0.02))
      heatRoofs.push(toGround(new THREE.ShapeGeometry(makeShape(innerR, innerHoles.map((x) => roundPolygon(x, 0.8)))), h + 0.1))
      for (const ih of innerHoles) {
        const ring = offsetPolygon(ih, 0.5)
        if (ring) trims.push(toGround(new THREE.ExtrudeGeometry(makeShape(roundPolygon(ring, 1.0), [roundPolygon(ih, 0.8)]), { depth: 1.0, bevelEnabled: false }), h - 0.45))
      }
    } else {
      // 轮廓太碎，内缩失败 → 退化成一块带倒角的屋面板
      trims.push(toGround(new THREE.ExtrudeGeometry(makeShape(outerR, rHoles), {
        depth: 0.5, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 1,
      }), h - 0.1))
      heatRoofs.push(toGround(new THREE.ShapeGeometry(makeShape(body, rHoles)), h + 0.6))
    }

    addFacades(b, h, nav, rand, glass, signs, frames)
    addRoofProps(b, h, rand, trims)
  }

  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra })
  const addMerged = (geos, material, name, cast = true) => {
    if (!geos.length) return null
    const mesh = new THREE.Mesh(mergeGeometries(geos.map(stripUV), false), material)
    mesh.name = name
    mesh.castShadow = cast
    mesh.receiveShadow = true
    group.add(mesh)
    geos.forEach((g) => g.dispose())
    return mesh
  }
  addMerged(walls, mat(style.wall), 'walls')
  addMerged(trims, mat(style.trim), 'trims')
  const roofMat = mat(style.roof)
  roofMat.map = roofTexture(scene.angle || 0)
  // 屋面贴图按世界坐标平铺（ShapeGeometry 的 uv 就是原始 xy）
  const roofMesh = roofs.length ? new THREE.Mesh(mergeGeometries(roofs, false), roofMat) : null
  if (roofMesh) { roofMesh.receiveShadow = true; roofMesh.name = 'roofs'; group.add(roofMesh) }

  const heatGeometry = heatRoofs.length ? mergeGeometries(heatRoofs.map(stripUV), false) : null

  group.add(instancedBoxes(glass, new THREE.MeshStandardMaterial({ roughness: 0.18, metalness: 0.15 }), 'glass', false))
  group.add(instancedBoxes(signs, new THREE.MeshStandardMaterial({ roughness: 0.7 }), 'signs', true))
  group.add(instancedBoxes(frames, new THREE.MeshStandardMaterial({ roughness: 0.8 }), 'frames', false))
  return { group, heatGeometry }
}

function stripUV(g) {
  g.deleteAttribute('uv')
  return g
}

function roofTexture(angle) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 128, 128)
  ctx.strokeStyle = 'rgba(120,128,138,0.55)'
  ctx.lineWidth = 2
  ctx.strokeRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1 / 9, 1 / 9) // 9m 一格的屋面分缝
  tex.rotation = angle // 分缝方向跟随街区主方向
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** 临街边: 法线外侧 2.5m 处可行走。店面只做在这些边上。 */
function addFacades(b, h, nav, rand, glass, signs, frames) {
  const poly = b.polygon
  const area = signedArea(poly)
  const up = new THREE.Vector3(0, 1, 0)
  const q = new THREE.Quaternion()
  const n = poly.length
  const isShop = b.kind !== 'block'
  let theme = SHOP_THEMES[(rand() * SHOP_THEMES.length) | 0]
  let themeLeft = 0

  for (let i = 0; i < n; i++) {
    const p = poly[i], p1 = poly[(i + 1) % n]
    const ex = p1[0] - p[0], ey = p1[1] - p[1]
    const L = Math.hypot(ex, ey)
    const usable = L - 2 * (CORNER_R + 0.3)
    if (usable < 3.5) continue
    const [nx, ny] = edgeNormal(poly, i, area)
    const mx = (p[0] + p1[0]) / 2, my = (p[1] + p1[1]) / 2
    const frontage = nav.isWalkable(mx + nx * 2.5, my + ny * 2.5) || nav.isWalkable(mx + nx * 4, my + ny * 4)
    const tx = ex / L, ty = ey / L
    // 盒子的局部 X 沿墙、Z 朝外
    q.setFromAxisAngle(up, Math.atan2(-ty, tx))
    const place = (list, s, yMid, w, hh, depth, out, color) => {
      const cx = p[0] + tx * s + nx * out, cz = p[1] + ty * s + ny * out
      list.push({ pos: [cx, yMid, cz], quat: q.clone(), scale: [w, hh, depth], color })
    }
    const start = CORNER_R + 0.3

    if (isShop && frontage) {
      const bays = Math.max(1, Math.round(usable / 6))
      const bw = usable / bays
      for (let k = 0; k < bays; k++) {
        if (themeLeft <= 0) {
          theme = SHOP_THEMES[(rand() * SHOP_THEMES.length) | 0]
          themeLeft = 1 + ((rand() * 3) | 0)
        }
        themeLeft--
        const s = start + bw * (k + 0.5)
        place(glass, s, 1.85, bw - 0.5, 3.0, 0.12, 0.04, theme[0])
        place(signs, s, 3.85, bw - 0.25, 0.8, 0.3, 0.1, theme[1])
        place(frames, s - bw / 2, 2.1, 0.32, 4.2, 0.22, 0.06, '#aeb3ba')
        if (k === bays - 1) place(frames, s + bw / 2, 2.1, 0.32, 4.2, 0.22, 0.06, '#aeb3ba')
      }
      // 二层及以上: 一条窄窗带
      for (let f = 1; f < (b.floors || 2); f++) {
        place(glass, start + usable / 2, f * FLOOR_H + 2.1, usable, 1.3, 0.1, 0.03, '#9fb3c4')
      }
    } else if (!isShop) {
      for (let f = 0; f < (b.floors || 2); f++) {
        place(glass, start + usable / 2, f * FLOOR_H + 2.3, usable, 1.9, 0.1, 0.03, '#93a9bd')
      }
    }
  }
}

/** 屋顶上随机放一两个设备间，位置挑离边界最远的点 */
function addRoofProps(b, h, rand, out) {
  const area = Math.abs(signedArea(b.polygon))
  if (area < 250) return
  const count = area > 1500 ? 2 : 1
  const cand = interiorPoints(b.polygon, b.holes || [], 40, rand)
    .map((p) => ({ p, d: Math.min(distToPolygonEdge(p[0], p[1], b.polygon), ...(b.holes || []).map((hh) => distToPolygonEdge(p[0], p[1], hh))) }))
    .sort((a, c) => c.d - a.d)
  const used = []
  for (const c of cand) {
    if (used.length >= count || c.d < 5) break
    if (used.some((u) => Math.hypot(u[0] - c.p[0], u[1] - c.p[1]) < 14)) continue
    used.push(c.p)
    const w = Math.min(c.d * 0.9, 5 + rand() * 6), d = Math.min(c.d * 0.9, 4 + rand() * 5), hh = 1.6 + rand() * 1.6
    const g = new THREE.BoxGeometry(w, hh, d).toNonIndexed()
    g.rotateY(-(b.angle || 0))
    g.translate(c.p[0], h + hh / 2, c.p[1])
    out.push(g)
  }
}

function instancedBoxes(items, material, name, castShadow) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, Math.max(1, items.length))
  mesh.name = name
  mesh.count = items.length
  const m = new THREE.Matrix4(), c = new THREE.Color()
  items.forEach((it, i) => {
    m.compose(new THREE.Vector3(...it.pos), it.quat, new THREE.Vector3(...it.scale))
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.set(it.color))
  })
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  return mesh
}
