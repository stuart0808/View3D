// 程序化建筑。输入只有二维轮廓、类型（kind）、层数；每类建筑有几种「原型」，由楼的编号确定性地选，
// 所以同一个场景每次打开都一样，但街上不会全是一个模子刻出来的楼。
//   住宅 residential  板楼（阳台 + 楼梯间竖条）/ 退台顶层 / 点式；暖色涂料墙面
//   写字楼 block       玻璃幕墙塔楼（竖向肋 + 塔冠）/ 裙房 + 石材格窗 / 逐级收分的塔楼
//   商业 shop          大商场（入口门头 + 屋顶采光天窗）/ 沿街小商铺（遮阳篷）；临街面都是橱窗 + 招牌
//   场馆 venue         体育场 / 壳体剧院（见 buildVenue）
//
// 画法: 墙体 / 幕墙 / 屋面 / 草坪各自合并成一个大网格（顶点色），橱窗、招牌、壁柱这类小构件用三个 InstancedMesh 的单位盒子；
// 每个顶点 / 实例带建筑编号 bid，室内视图靠它在着色器里隐藏单独一栋（见 hideable）。
// 坐标: 二维 (x, y) 对应三维 (x, ·, z)，高度沿 y；toGround 负责把拉伸体从 xy 平面翻到地面上。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { signedArea, edgeNormal, offsetPolygon, roundPolygon, makeShape, toGround, interiorPoints, distToPolygonEdge } from './geometry.js'

const CORNER_R = 1.6 // 平面轮廓的圆角半径 (m)
/** 各类建筑的层高 (m)，楼高 = 层数 × 层高；人群模型算楼层用的也是它 */
export const FLOOR_H = { shop: 4.4, block: 4.0, residential: 3.1, venue: 4.4 }

/**
 * 室内视图要「单独隐藏某一栋楼」，但所有楼是合并成几个大网格画的。
 * 做法: 每个顶点（或实例）带一个建筑编号 bid，着色器里遇到 bid == hiddenBuilding 就把顶点扔到裁剪空间外。
 * 零额外 draw call；阴影用的深度材质也打同样的补丁，否则隐藏的楼还会投影。
 */
export const hiddenBuilding = { value: -1 }

/** 给材质打「可隐藏」补丁（见上）。返回同一个材质，方便链式写 */
export function hideable(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.hiddenBid = hiddenBuilding // 直接引用同一个对象: 改一次 .value，所有材质同步
    // 顶点着色器: 声明 bid 属性和 uniform，投影之后把命中的顶点甩到裁剪空间外（z=2 > w=1 必被裁掉）
    shader.vertexShader = 'attribute float bid;\nuniform float hiddenBid;\n' +
      shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  if (abs(bid - hiddenBid) < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);')
  }
  return material
}

/** 网格投影用的深度材质也要打补丁，不然被隐藏的楼还会在地上留个影子 */
function withShadowHiding(mesh) {
  mesh.customDepthMaterial = hideable(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }))
  return mesh
}

/** 给几何体的每个顶点写上建筑编号 */
function tag(geometry, bid) {
  geometry.setAttribute('bid', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count).fill(bid), 1))
  return geometry
}

const _c = new THREE.Color()
/** 给几何体刷一个纯色（顶点色）。墙体类的网格共用一个白色材质，颜色全靠它 */
function paint(geometry, hex) {
  _c.set(hex)
  // 每个顶点写同一个 RGB（材质 vertexColors=true 时生效）
  const n = geometry.attributes.position.count, col = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return geometry
}

// ---------------------------------------------------------------------------
// 调色板
// ---------------------------------------------------------------------------
const SHOP_THEMES = [ // [玻璃色, 招牌色]
  ['#8fb4cf', '#2b3a4e'], ['#9cc0d6', '#23405c'], ['#d9a86a', '#6b4226'],
  ['#e0b57c', '#8a5a33'], ['#a9b6c2', '#33363c'], ['#c9935a', '#3a2a20'],
]
const RESI_WALL = ['#ebe3d5', '#e6d8c6', '#dde0e4', '#e9dcd2', '#e1e5da', '#f0e9dc']
const RESI_ACCENT = ['#b9694f', '#7d8fa3', '#9a8566', '#6f8f7a', '#a85f4a', '#5f7c96']
const OFFICE_GLASS = ['#7f9db8', '#6e8ea6', '#8aa7b5', '#5f7d94', '#93a9bd', '#789a9c']
const OFFICE_STONE = ['#d8dade', '#cfd3d8', '#e0dcd4', '#c9ced4']
const MALL_WALL = ['#e4e6e9', '#dcdfe3', '#e9e4dc', '#d9dde2']
const MALL_ACCENT = ['#d2603a', '#2f6fd0', '#d59a2a', '#2f9c8f', '#b8456b']
const AWNING = ['#c4553e', '#2f7d6b', '#d09a3a', '#4a6fa5', '#8c4a6e'] // 小商铺遮阳篷

/** 按编号从调色板里取色（负数也安全） */
const pick = (arr, k) => arr[((k % arr.length) + arr.length) % arr.length]

/**
 * 把场景里所有建筑画出来。
 * @param scene  scene.json（用 buildings[]: polygon / holes / kind / floors / venue / angle，以及 angle 街区主方向）
 * @param nav    导航网格，只用来判断商铺哪面临街（contains / isWalkable）
 * @param rand   确定性随机数
 * @param style  { roof } 屋面底色
 * @returns { group, heatGeometry }  heatGeometry 是所有屋顶热力层合并后的几何体（heat.js 用它做热力图），可能为 null
 * 每栋楼的「原型」由 seed = 编号 × 7 + 层数 决定，所以同一个场景每次打开长得一样。
 */
export function buildBuildings(scene, nav, rand, style) {
  const group = new THREE.Group()
  group.name = 'buildings'
  // 合并用的几何体列表: 实体墙面 / 玻璃幕墙 / 带分缝贴图的屋面 / 屋顶热力层 / 场馆草坪
  const L = { solid: [], glassy: [], roofs: [], heat: [], pitch: [] }
  // 实例化的小盒子: 橱窗和窗带 / 招牌 / 其他细部（壁柱、阳台、竖肋、遮阳篷…），元素 {pos, quat, scale, color}
  const I = { glass: [], signs: [], details: [] }

  scene.buildings.forEach((b, bid) => {
    // 记下处理这栋之前各列表的长度: 之后新增的那一段就是这栋楼的几何体 / 实例
    const mark = Object.values(L).map((l) => l.length), imark = Object.values(I).map((l) => l.length)
    // seed 决定原型和配色: 编号 × 7 + 层数，相邻编号的楼不会是同一套
    const ctx = { L, I, nav, rand, style, seed: bid * 7 + (b.floors || 2) }
    // 按类型分派；未知 kind 一律当商铺画
    if (b.kind === 'venue') buildVenue(b, ctx)
    else if (b.kind === 'residential') buildResidential(b, ctx)
    else if (b.kind === 'block') buildOffice(b, ctx)
    else buildShop(b, ctx)
    // 这一栋新增的所有几何体 / 实例统一打上编号
    Object.values(L).forEach((list, k) => { for (let i = mark[k]; i < list.length; i++) tag(list[i], bid) })
    Object.values(I).forEach((list, k) => { for (let i = imark[k]; i < list.length; i++) list[i].bid = bid })
  })

  // 一组几何体合并成一个网格挂到 group 上；屋面要保留 uv（贴分缝图），其他都去掉 uv 以便和无 uv 的几何体合并
  const addMerged = (geos, material, name, { cast = true, keepUV = false } = {}) => {
    if (!geos.length) return null
    const mesh = withShadowHiding(new THREE.Mesh(mergeGeometries(keepUV ? geos : geos.map(stripUV), false), material))
    mesh.name = name
    mesh.castShadow = cast // 屋面 / 草坪不投影: 它们在楼顶或场地里，影子全落在楼体内，白算
    mesh.receiveShadow = true
    group.add(mesh)
    geos.forEach((g) => g.dispose()) // 合并后原几何体没用了
    return mesh
  }
  // 墙体: 粗糙的涂料 / 石材；幕墙: 低粗糙 + 一点金属感，有反光
  addMerged(L.solid, hideable(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86 })), 'walls')
  addMerged(L.glassy, hideable(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.16, metalness: 0.35 })), 'curtainWalls')
  // 屋面: 统一材质色 + 分缝贴图，不用顶点色
  const roofMat = hideable(new THREE.MeshStandardMaterial({ color: style.roof, roughness: 0.85 }))
  roofMat.map = roofTexture(scene.angle || 0) // 屋面贴图按世界坐标平铺（ShapeGeometry 的 uv 就是原始 xy）
  addMerged(L.roofs, roofMat, 'roofs', { cast: false, keepUV: true })
  addMerged(L.pitch, hideable(new THREE.MeshStandardMaterial({ color: '#86b574', roughness: 1 })), 'pitch', { cast: false })
  // 热力层不进 group: 只合并几何体，网格和材质由 heat.js 自己建
  const heatGeometry = L.heat.length ? mergeGeometries(L.heat.map(stripUV), false) : null

  // 实例化细部: 玻璃不投影（薄片的影子只剩噪点），招牌和壁柱投影
  group.add(instancedBoxes(I.glass, hideable(new THREE.MeshStandardMaterial({ roughness: 0.18, metalness: 0.15 })), 'glass', false))
  group.add(instancedBoxes(I.signs, hideable(new THREE.MeshStandardMaterial({ roughness: 0.7 })), 'signs', true))
  group.add(instancedBoxes(I.details, hideable(new THREE.MeshStandardMaterial({ roughness: 0.8 })), 'details', true))
  return { group, heatGeometry }
}

// ---------------------------------------------------------------------------
// 通用构件
// ---------------------------------------------------------------------------
/**
 * 轮廓拉伸成一段棱柱（y0 起、高 h），圆角
 * @param list   目标几何体列表（L.solid / L.glassy）
 * @param poly   外轮廓；holes 内院轮廓（圆角固定 0.8m）
 * @param y0     起始高度 (m)；h 高度 (m)；color 顶点色；r 轮廓圆角半径 (m)
 * @returns 几何体本身，调用方偶尔要再处理
 */
function prism(list, poly, holes, y0, h, color, r = CORNER_R) {
  // curveSegments 1: 圆角只用最少的段数，几千栋楼的顶点数才压得住
  const g = toGround(new THREE.ExtrudeGeometry(makeShape(roundPolygon(poly, r), holes.map((x) => roundPolygon(x, 0.8))), { depth: h, bevelEnabled: false, curveSegments: 1 }), y0)
  list.push(paint(g, color))
  return g
}

/**
 * 屋顶: 挑檐 + 女儿墙 + 带分缝的屋面 +（可选）热力层
 * @param poly / holes  楼顶轮廓和内院；y 楼顶标高 (m)；trimColor 女儿墙颜色
 * @param heat  是否在这块屋面上放热力层（退台楼的露台不放，热力层只放最上面的屋面）
 * @param r     轮廓圆角半径 (m)，要和楼体的 prism 一致，女儿墙才贴得上
 */
function roofCap(ctx, poly, holes, y, trimColor, heat = true, r = CORNER_R) {
  const { L } = ctx
  // 女儿墙环: 外扩 0.4m 做挑檐，内缩 0.55m 是墙厚，两者之间的环就是女儿墙，环内是屋面
  const outer = offsetPolygon(poly, 0.4) || poly
  const inner = offsetPolygon(poly, -0.55)
  const outerR = roundPolygon(outer, r + 0.4) // 外圈圆角随外扩量加大，和楼体的圆角同心
  // 内缩后面积不到 40% 说明轮廓太窄（细长连廊之类），围不出女儿墙环
  const ok = inner && Math.abs(signedArea(inner)) > Math.abs(signedArea(poly)) * 0.4
  const rHoles = holes.map((x) => roundPolygon(x, 0.8))
  if (!ok) { // 轮廓太碎，内缩失败 → 退化成一块带倒角的屋面板
    // 0.5m 厚的板、0.12m 倒角当檐口，下沉 0.1m 埋进楼体；热力层抬 0.6m 浮在板上
    L.solid.push(paint(toGround(new THREE.ExtrudeGeometry(makeShape(outerR, rHoles), { depth: 0.5, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 1 }), y - 0.1), trimColor))
    if (heat) L.heat.push(toGround(new THREE.ShapeGeometry(makeShape(roundPolygon(poly, r), rHoles)), y + 0.6))
    return
  }
  const innerR = roundPolygon(inner, Math.max(0.3, r - 0.55)) // 内圈圆角随内缩量减小，最小 0.3m
  const innerHoles = holes.map((x) => roundPolygon(offsetPolygon(x, 0.4) || x, 0.8)) // 内院: 女儿墙环也要避开
  // 女儿墙 1m 高，下沉 0.45m 埋进楼体避免漏缝，露出 0.55m；屋面比楼顶高 0.02m 防 z-fighting，热力层再高 0.08m
  L.solid.push(paint(toGround(new THREE.ExtrudeGeometry(makeShape(outerR, [innerR]), { depth: 1.0, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 1 }), y - 0.45), trimColor))
  L.roofs.push(toGround(new THREE.ShapeGeometry(makeShape(innerR, innerHoles)), y + 0.02))
  if (heat) L.heat.push(toGround(new THREE.ShapeGeometry(makeShape(innerR, innerHoles)), y + 0.1))
  // 内院: 每个洞口周围也围一圈女儿墙（外扩 0.9m 到内扩 0.4m 之间的环）
  for (const ih of holes) {
    const ring = offsetPolygon(ih, 0.9)
    if (ring) L.solid.push(paint(toGround(new THREE.ExtrudeGeometry(makeShape(roundPolygon(ring, 1.0), [roundPolygon(offsetPolygon(ih, 0.4) || ih, 0.8)]), { depth: 1.0, bevelEnabled: false }), y - 0.45), trimColor))
  }
}

/** 内缩 d 米；缩没了 / 缩坏了返回 null */
function setback(poly, d) {
  const p = offsetPolygon(poly, -d)
  // 缩到不足原面积 25% 就当失败: 太小的顶层 / 塔冠不好看，调用方退回不退台的做法
  return p && Math.abs(signedArea(p)) > Math.abs(signedArea(poly)) * 0.25 ? p : null
}

/**
 * 沿轮廓的每条边走一遍，回调里拿到一个 place(list, 沿边位置 s, 中心高度, 宽, 高, 厚, 外伸, 颜色, 俯仰) 的放置函数。
 * 盒子的局部 X 沿墙、Z 朝外。minLen: 短于它的边跳过。
 * @param poly    轮廓；corner 楼体的圆角半径 (m)，两端各让出这么多
 * @param fn      回调，参数 { i 边号, len 边长, usable 可用长度, start 起点偏移, mid 中点, normal 外法线, place }
 * place 的参数: s 沿边距起点 (m)、yMid 盒子中心高度、w 宽 / h 高 / depth 厚、out 沿外法线外伸 (m)、color、tilt 绕局部 X 的俯仰（遮阳篷用）
 */
function eachEdge(poly, minLen, fn, corner = CORNER_R) {
  const area = signedArea(poly), up = new THREE.Vector3(0, 1, 0)
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i], p1 = poly[(i + 1) % n]
    const ex = p1[0] - p[0], ey = p1[1] - p[1], len = Math.hypot(ex, ey)
    const usable = len - 2 * (corner + 0.3) // 两端各让出圆角 + 0.3m，构件不会伸到圆角上
    if (usable < minLen) continue
    const [nx, ny] = edgeNormal(poly, i, area)
    const tx = ex / len, ty = ey / len
    // 边的切向 → 绕 Y 的旋转，让盒子的局部 X 沿墙
    const q = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(-ty, tx))
    // 局部 Z 是不是真的朝外: 绕 Y 转 θ 后局部 Z = (sinθ, 0, cosθ) = (-ty, 0, tx)；和外法线反向时，俯仰要反过来
    const zSign = -ty * nx + tx * ny >= 0 ? 1 : -1
    const place = (list, s, yMid, w, h, depth, out, color, tilt = 0) => {
      const quat = tilt ? q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt * zSign)) : q
      list.push({ pos: [p[0] + tx * s + nx * out, yMid, p[1] + ty * s + ny * out], quat, scale: [w, h, depth], color })
    }
    fn({ i, len, usable, start: corner + 0.3, mid: [(p[0] + p1[0]) / 2, (p[1] + p1[1]) / 2], normal: [nx, ny], place })
  }
}

/**
 * 每层一条窗带（核心区以外、或者不需要细分开间的立面都用它）
 * @param y0  这段楼体的起始高度 (m)；floors 层数；floorH 层高 (m)
 * @param sill 窗台高 (m)；height 窗高 (m)；minLen 短于它的边不开窗；from 从第几层开始（裙房以上）
 * 窗带贴墙外 0.03m、厚 0.1m，只是一层「贴片」
 */
function windowBands(ctx, poly, y0, floors, floorH, color, { sill = 1.0, height = 1.6, minLen = 3.5, from = 0 } = {}) {
  eachEdge(poly, minLen, (e) => {
    for (let f = from; f < floors; f++) e.place(ctx.I.glass, e.start + e.usable / 2, y0 + f * floorH + sill + height / 2, e.usable, height, 0.1, 0.03, color)
  })
}

/** 屋顶上随机放一两个设备间，位置挑离边界最远的点 */
function roofProps(ctx, b, poly, y, color) {
  const area = Math.abs(signedArea(poly))
  if (area < 250) return // 250㎡ 以下的楼顶放不下设备间
  const holes = poly === b.polygon ? b.holes || [] : [] // 只有原始轮廓才有内院；退台顶层 / 塔冠的轮廓没有洞
  // 撒 40 个候选点，按离边界（含内院边）最远排序
  const cand = interiorPoints(poly, holes, 40, ctx.rand)
    .map((p) => ({ p, d: Math.min(distToPolygonEdge(p[0], p[1], poly), ...holes.map((hh) => distToPolygonEdge(p[0], p[1], hh))) }))
    .sort((a, c) => c.d - a.d)
  const used = []
  for (const c of cand) {
    if (used.length >= (area > 1500 ? 2 : 1) || c.d < 4) break // 1500㎡ 以上放两个；离边不足 4m 的点放不下（后面的更近，直接停）
    if (used.some((u) => Math.hypot(u[0] - c.p[0], u[1] - c.p[1]) < 14)) continue // 两个设备间至少隔 14m
    used.push(c.p)
    // 尺寸: 5~11m × 4~9m，不超过离边距离的 0.9 倍；高 1.6~3.2m
    const w = Math.min(c.d * 0.9, 5 + ctx.rand() * 6), d = Math.min(c.d * 0.9, 4 + ctx.rand() * 5), hh = 1.6 + ctx.rand() * 1.6
    const g = new THREE.BoxGeometry(w, hh, d).toNonIndexed()
    g.rotateY(-(b.angle || 0)) // 和楼的朝向对齐
    g.translate(c.p[0], y + hh / 2, c.p[1])
    ctx.L.solid.push(paint(g, color))
  }
}

// ---------------------------------------------------------------------------
// 住宅
// ---------------------------------------------------------------------------
/**
 * 住宅楼。三种原型: slab 板楼、penthouse 顶上两层内缩的退台楼、point 点式楼。
 * 底层 3.4m 是深色基座；长边（长度 > 最长边 60%）当正立面，一面出阳台、另一面出楼梯间竖条，短边只开一列小窗。
 */
function buildResidential(b, ctx) {
  const { L, I, seed } = ctx
  const fh = FLOOR_H.residential, floors = b.floors || 11, holes = b.holes || []
  const wall = pick(RESI_WALL, seed), accent = pick(RESI_ACCENT, seed >> 1), base = '#b7b2a8' // 墙色和强调色用不同的位，不会总是同一对
  const type = ['slab', 'penthouse', 'slab', 'point'][seed % 4] // 一半板楼、四分之一退台、四分之一点式
  const top = type === 'penthouse' ? setback(b.polygon, 2.6) : null // 退台: 顶两层内缩 2.6m；缩不动就退回板楼
  const bodyFloors = top ? floors - 2 : floors // 主体层数（退台楼的顶两层单独画）
  const h = bodyFloors * fh // 主体高度 (m)

  prism(L.solid, b.polygon, holes, 0, 3.4, base) // 底层: 深一点的石材基座
  prism(L.solid, b.polygon, holes, 3.4, h - 3.4, wall)
  if (top) {
    // 退台顶: 两层的强调色小体量，圆角小一点 (1.0m)；热力层放在顶层屋面上，露台不放
    prism(L.solid, top, [], h, 2 * fh, accent, 1.0)
    roofCap(ctx, top, [], h + 2 * fh, '#eceef1', true, 1.0)
    roofCap(ctx, b.polygon, holes, h, '#eceef1', false) // 退台形成的露台
    windowBands(ctx, top, h, 2, fh, '#9fb3c4')
  } else roofCap(ctx, b.polygon, holes, h, '#eceef1')
  roofProps(ctx, b, top || b.polygon, (top ? floors : bodyFloors) * fh, wall) // 设备间放在最上面的屋面

  // 长边 = 正立面: 一侧做阳台，另一侧做楼梯间竖条；短边（山墙）只开一列小窗
  let longest = 0
  eachEdge(b.polygon, 0, (e) => (longest = Math.max(longest, e.len)))
  let side = 0 // 长边计数: 奇数面阳台、偶数面楼梯间，正反面交替
  eachEdge(b.polygon, 3, (e) => {
    const isLong = e.len > longest * 0.6 && type !== 'point' // 超过最长边 60% 算长边；点式楼四面同样处理
    if (!isLong) { // 山墙 / 点式楼
      // 从二层起每层一扇窗: 山墙 2.4m 宽的小窗，点式楼开整面；窗台 1.7m、窗高 1.4m
      for (let f = 1; f < bodyFloors; f++) e.place(I.glass, e.start + e.usable / 2, f * fh + 1.7, Math.min(e.usable, type === 'point' ? e.usable : 2.4), 1.4, 0.1, 0.03, '#9fb3c4')
      if (type === 'point') e.place(I.details, e.start + e.usable / 2, h / 2 + 1, 2.4, h - 2, 0.5, 0.25, accent) // 点式楼每面中间一道竖向色带
      return
    }
    side++
    // 长边: 从二层起通长窗带，窗台 1.75m、窗高 1.5m
    for (let f = 1; f < bodyFloors; f++) e.place(I.glass, e.start + e.usable / 2, f * fh + 1.75, e.usable, 1.5, 0.1, 0.03, '#9fb3c4')
    if (side % 2 === 1) { // 阳台面: 每层一道挑板 + 栏板
      // 挑板 0.16m 厚、出挑 1.3m（中心外伸 0.65m）；栏板 1m 高、0.1m 厚，贴在挑板外缘
      for (let f = 1; f < bodyFloors; f++) {
        e.place(I.details, e.start + e.usable / 2, f * fh + 0.08, e.usable - 1, 0.16, 1.3, 0.65, '#f3f1ec')
        e.place(I.details, e.start + e.usable / 2, f * fh + 0.62, e.usable - 1, 1.0, 0.1, 1.28, accent)
      }
    } else { // 背面: 楼梯间竖条，高出屋面一点
      // 约 22m 一个核心筒，3.4m 宽、0.7m 厚，从地面到高出屋面 2.2m
      const cores = Math.max(1, Math.round(e.usable / 22))
      for (let k = 0; k < cores; k++) e.place(I.details, e.start + (e.usable * (k + 0.5)) / cores, (h + 2.2) / 2, 3.4, h + 2.2, 0.7, 0.35, accent)
    }
  })
}

// ---------------------------------------------------------------------------
// 写字楼
// ---------------------------------------------------------------------------
/** 写字楼。三种原型: curtain 玻璃幕墙塔楼、stepped 逐级收分、grid 裙房 + 石材格窗 */
function buildOffice(b, ctx) {
  const { L, I, seed } = ctx
  const fh = FLOOR_H.block, floors = b.floors || 8, holes = b.holes || []
  const h = floors * fh
  const glassCol = pick(OFFICE_GLASS, seed), stone = pick(OFFICE_STONE, seed >> 1)
  const type = ['curtain', 'grid', 'stepped', 'curtain', 'grid'][seed % 5] // 五选一: 幕墙和格窗各占两份，收分只占一份

  if (type === 'curtain') { // 玻璃幕墙塔楼: 整个体量是玻璃，竖向肋 + 每 4 层一道腰线 + 塔冠
    prism(L.glassy, b.polygon, holes, 0, h, glassCol)
    prism(L.solid, b.polygon, holes, 0, 0.9, '#8a9099') // 勒脚: 0.9m 深灰石材，玻璃不直接落地
    const crown = setback(b.polygon, 1.2) // 塔冠: 内缩 1.2m、高 2.6m 的浅色体量，热力层放在塔冠顶上
    if (crown) { prism(L.solid, crown, [], h, 2.6, '#e6e9ed', 1.0); roofCap(ctx, crown, [], h + 2.6, '#eceef1', true, 1.0) } else roofCap(ctx, b.polygon, holes, h, '#eceef1')
    eachEdge(b.polygon, 3, (e) => {
      // 竖向肋 3.2m 一根（至少 2 格），0.16m 宽，从勒脚顶到檐口，比玻璃外伸 0.2m
      const fins = Math.max(2, Math.round(e.usable / 3.2))
      for (let k = 0; k <= fins; k++) e.place(I.details, e.start + (e.usable * k) / fins, h / 2 + 0.4, 0.16, h - 0.8, 0.4, 0.2, '#e9edf1')
      // 腰线: 每 4 层一道 0.35m 高的浅色横带
      for (let f = 4; f < floors; f += 4) e.place(I.details, e.start + e.usable / 2, f * fh, e.usable, 0.35, 0.3, 0.12, '#dfe4ea')
    })
    if (floors >= 14 && seed % 2 === 0) { // 高的那几栋顶上加一根桅杆
      // 14m 高的方杆，落在塔冠（没塔冠就是楼顶）里最靠中的一点
      const c = interiorPoints(crown || b.polygon, [], 1, ctx.rand)[0]
      if (c) { const g = new THREE.BoxGeometry(0.5, 14, 0.5).toNonIndexed(); g.translate(c[0], h + 2.6 + 7, c[1]); L.solid.push(paint(g, '#c9ced5')) }
    }
    return
  }

  if (type === 'stepped') { // 逐级收分: 下 55% 满铺，中段内缩 3m，顶段再缩 3m
    // 分段表: 每段 {轮廓, 内院, 到第几层}；缩不动的段就省掉，最后一段总是补齐到顶层
    const tiers = [{ poly: b.polygon, holes, to: Math.round(floors * 0.55) }]
    const mid = setback(b.polygon, 3), topP = mid && setback(mid, 3)
    if (mid) tiers.push({ poly: mid, holes: [], to: Math.round(floors * 0.85) })
    if (topP) tiers.push({ poly: topP, holes: [], to: floors })
    tiers[tiers.length - 1].to = floors
    let f0 = 0 // 当前段的起始层
    tiers.forEach((t, k) => {
      const y0 = f0 * fh, th = (t.to - f0) * fh
      if (th <= 0) return // 层数太少时中段可能是空的
      // 偶数段石材 + 窗带，奇数段幕墙 + 竖肋，材质交替；上面的段圆角小 (1.0m)
      prism(k % 2 ? L.glassy : L.solid, t.poly, t.holes, y0, th, k % 2 ? glassCol : stone, k ? 1.0 : CORNER_R)
      if (k % 2 === 0) windowBands(ctx, t.poly, y0, t.to - f0, fh, '#8fa6ba', { height: 2.0, from: k ? 0 : 0 })
      else eachEdge(t.poly, 3, (e) => { const fins = Math.max(2, Math.round(e.usable / 3.2)); for (let j = 0; j <= fins; j++) e.place(I.details, e.start + (e.usable * j) / fins, y0 + th / 2, 0.16, th, 0.4, 0.2, '#e9edf1') }, 1.0)
      roofCap(ctx, t.poly, t.holes, y0 + th, '#eceef1', k === tiers.length - 1, k ? 1.0 : CORNER_R) // 只有最上一段放热力层
      f0 = t.to
    })
    roofProps(ctx, b, tiers[tiers.length - 1].poly, h, stone)
    return
  }

  // grid: 两层裙房（外扩 2.5m，深色石材，大玻璃）+ 石材塔身、逐层窗带
  const podium = offsetPolygon(b.polygon, 2.5)
  const ph = 2 * fh + 0.6 // 裙房高 = 两层 + 0.6m 檐口
  if (podium) {
    prism(L.solid, podium, [], 0, ph, '#9aa0a8')
    roofCap(ctx, podium, [], ph, '#d5d9de', false) // 裙房顶不放热力层
    // 裙房大玻璃: 通高减 2.4m 留上下边框
    eachEdge(podium, 3.5, (e) => e.place(I.glass, e.start + e.usable / 2, ph / 2 - 0.2, e.usable, ph - 2.4, 0.12, 0.04, '#7f9db8'))
  }
  prism(L.solid, b.polygon, holes, 0, h, stone)
  windowBands(ctx, b.polygon, 0, floors, fh, '#8fa6ba', { height: 2.1, from: podium ? 2 : 0 }) // 有裙房时窗带从三层起
  eachEdge(b.polygon, 3, (e) => { // 竖向壁柱把窗带分成格
    // 6m 一根、0.5m 宽，从裙房顶到楼顶
    const cols = Math.max(2, Math.round(e.usable / 6))
    for (let k = 0; k <= cols; k++) e.place(I.details, e.start + (e.usable * k) / cols, (h + ph) / 2, 0.5, h - ph, 0.3, 0.15, stone)
  })
  roofCap(ctx, b.polygon, holes, h, '#eceef1')
  roofProps(ctx, b, b.polygon, h, stone)
}

// ---------------------------------------------------------------------------
// 商业
// ---------------------------------------------------------------------------
/**
 * 商业。面积 > 2200㎡ 算商场（入口门头 + 屋顶天窗 + 檐下品牌色带），否则是沿街小商铺（每个开间一个遮阳篷）。
 * 临街判断: 边中点外 2.5m 或 4m 是人行道就算临街，临街面按 6m 一个开间排橱窗 + 招牌，连续 1~3 个开间共用一个配色。
 */
function buildShop(b, ctx) {
  const { L, I, nav, rand, seed } = ctx
  const fh = FLOOR_H.shop, floors = b.floors || 2, holes = b.holes || []
  const h = floors * fh
  const area = Math.abs(signedArea(b.polygon))
  const isMall = area > 2200 // 2200㎡ 以上算商场
  const wall = pick(MALL_WALL, seed), accent = pick(MALL_ACCENT, seed >> 1) // 墙色和品牌色按 seed 取

  prism(L.solid, b.polygon, holes, 0, h, wall)
  roofCap(ctx, b.polygon, holes, h, '#eceef1')
  roofProps(ctx, b, b.polygon, h, wall)

  // 橱窗配色 theme 用 rand 随机（不用 seed，让同一栋楼的开间也有变化），themeLeft 是当前主题还要延续几个开间
  let theme = SHOP_THEMES[(rand() * SHOP_THEMES.length) | 0], themeLeft = 0
  let portal = null // 最长的那条临街边，商场的入口门头放这儿
  eachEdge(b.polygon, 3.5, (e) => {
    const [nx, ny] = e.normal
    const far = !nav.contains(e.mid[0], e.mid[1]) // 核心区以外: 不知道哪面临街，也没人走近看，统一画窗带
    // 临街: 边中点外 2.5m（紧挨人行道）或 4m（隔着绿化带）能走人
    const frontage = nav.isWalkable(e.mid[0] + nx * 2.5, e.mid[1] + ny * 2.5) || nav.isWalkable(e.mid[0] + nx * 4, e.mid[1] + ny * 4)
    if (far || !frontage) {
      // 核心区外每层一条窗带（窗台 2.3m、窗高 1.9m）；核心区内的非临街面（背巷、贴邻楼）留白
      if (far) for (let f = 0; f < floors; f++) e.place(I.glass, e.start + e.usable / 2, f * fh + 2.3, e.usable, 1.9, 0.1, 0.03, '#93a9bd')
      return
    }
    if (!portal || e.len > portal.len) portal = e
    const bays = Math.max(1, Math.round(e.usable / 6)), bw = e.usable / bays // 开间约 6m，按边长取整均分
    for (let k = 0; k < bays; k++) {
      if (themeLeft <= 0) { theme = SHOP_THEMES[(rand() * SHOP_THEMES.length) | 0]; themeLeft = 1 + ((rand() * 3) | 0) } // 换主题，随机延续 1~3 个开间
      themeLeft--
      const s = e.start + bw * (k + 0.5) // 开间中心
      // 橱窗 3m 高（中心 1.85m）；招牌 0.8m 高在 3.85m，商场统一品牌色、小商铺各店各色
      e.place(I.glass, s, 1.85, bw - 0.5, 3.0, 0.12, 0.04, theme[0])
      e.place(I.signs, s, 3.85, bw - 0.25, 0.8, 0.3, 0.1, isMall ? accent : theme[1])
      // 开间之间的壁柱 4.2m 高、0.32m 宽；每个开间画左侧的，最后一个开间补右侧的
      e.place(I.details, s - bw / 2, 2.1, 0.32, 4.2, 0.22, 0.06, '#aeb3ba')
      if (k === bays - 1) e.place(I.details, s + bw / 2, 2.1, 0.32, 4.2, 0.22, 0.06, '#aeb3ba')
      if (!isMall) e.place(I.details, s, 3.25, bw - 0.6, 0.08, 1.5, 0.8, pick(AWNING, seed + k), -0.32) // 小商铺: 斜挑的遮阳篷（出挑 1.5m，下倾 0.32 rad）
    }
    // 二层以上: 窗台 2.1m、1.3m 高的通长窗带
    for (let f = 1; f < floors; f++) e.place(I.glass, e.start + e.usable / 2, f * fh + 2.1, e.usable, 1.3, 0.1, 0.03, '#9fb3c4')
    if (isMall) e.place(I.details, e.start + e.usable / 2, h - 0.9, e.usable, 0.5, 0.2, 0.1, accent) // 商场: 檐下一道通长的品牌色带
  })

  if (isMall && portal) { // 入口门头: 比檐口高出一截的门框 + 通高玻璃
    const w = Math.min(14, portal.usable * 0.4) // 门头宽 = 临街边可用长度的 40%，封顶 14m
    // 门框高出檐口 2.6m、厚 1.6m、外伸 0.8m；玻璃比门框窄 2.2m（两边各留 1.1m 框），再向外 0.02m 免得和门框重面
    portal.place(I.details, portal.start + portal.usable / 2, (h + 2.6) / 2, w, h + 2.6, 1.6, 0.8, accent)
    portal.place(I.glass, portal.start + portal.usable / 2, (h + 0.6) / 2, w - 2.2, h - 0.6, 0.2, 1.62, '#9cc3dc')
  }
  if (isMall) { // 屋顶采光天窗: 沿街区主方向的一条玻璃长廊
    // 放在离边界（含内院）最远的点；离边不足 9m 的楼顶放不下
    const c = interiorPoints(b.polygon, holes, 30, rand).map((p) => ({ p, d: Math.min(distToPolygonEdge(p[0], p[1], b.polygon), ...holes.map((x) => distToPolygonEdge(p[0], p[1], x))) })).sort((a, z) => z.d - a.d)[0]
    if (c && c.d > 9) {
      // 长 = 1.5 倍离边距离、宽 5m、高 2.2m；方向按 seed 奇偶沿或垂直街区主方向
      const len = c.d * 1.5, g = new THREE.BoxGeometry(len, 2.2, 5).toNonIndexed()
      g.rotateY(-(b.angle || 0) + (seed % 2 ? Math.PI / 2 : 0))
      g.translate(c.p[0], h + 1.4, c.p[1])
      L.glassy.push(paint(g, '#a9cbe0'))
    }
  }
}

// ---------------------------------------------------------------------------
// 场馆
// ---------------------------------------------------------------------------
/**
 * 只用到轮廓（绕形心缩放得到一圈圈同心环）和场馆类型:
 *   stadium  外墙一圈 + 逐级下降的阶梯看台 + 中间草坪 + 顶上一圈挑出的环形罩棚
 *   其他     基座 + 椭球形壳体 + 一条贯穿壳体的玻璃幕带（剧院 / 音乐厅常见的样子）
 * 屋顶热力层: 体育场铺在罩棚上，剧院直接贴着壳体。
 */
function buildVenue(b, ctx) {
  const { L } = ctx
  const poly = b.polygon
  // 形心 = 顶点平均；ring(k) 是绕形心缩放 k 倍的同心轮廓
  let cx = 0, cy = 0
  for (const [x, y] of poly) { cx += x; cy += y }
  cx /= poly.length
  cy /= poly.length
  const ring = (k) => poly.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k])
  // annulus: k0 圈和 k1 圈之间的环拉伸 depth 高，从 y 起；k1 = 0 时是实心
  const annulus = (k0, k1, depth, y, color) => paint(toGround(new THREE.ExtrudeGeometry(makeShape(ring(k0), k1 > 0 ? [ring(k1)] : []), { depth, bevelEnabled: false, curveSegments: 1 }), y), color)

  if (b.venue?.type === 'stadium') {
    const H = 25 // 外墙高 25m，厚度是轮廓的 10%（0.9~1.0 圈）
    L.solid.push(annulus(1, 0.9, H, 0, '#cfd3d8'))
    const N = 9 // 看台级数
    for (let i = 0; i < N; i++) { // 看台: 从外圈 22m 高逐级降到场边 3m，隔一级换个深浅
      // 每级占 0.4/N 的缩放比，从 0.9 圈缩到 0.5 圈（场地）
      const k0 = 0.9 - (i * 0.4) / N, k1 = 0.9 - ((i + 1) * 0.4) / N
      L.solid.push(annulus(k0, k1, 22 - (i * 19) / N, 0, i % 2 ? '#dfe3e8' : '#c7ccd3'))
    }
    L.pitch.push(toGround(new THREE.ShapeGeometry(makeShape(ring(0.5))), 0.4)) // 草坪抬 0.4m，高出最低一级看台的地面
    L.solid.push(annulus(1.06, 0.68, 1.3, H + 1.2, '#f1f3f5')) // 环形罩棚，向场内挑出: 1.06 圈到 0.68 圈，1.3m 厚，架在墙顶上方 1.2m
    L.heat.push(toGround(new THREE.ShapeGeometry(makeShape(ring(1.06), [ring(0.68)])), H + 2.6)) // 热力层铺在罩棚顶面
    return
  }

  // 主轴方向和两个半径（轮廓大多是椭圆，用顶点的协方差估）
  let sxx = 0, syy = 0, sxy = 0
  for (const [x, y] of poly) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy) }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ca = Math.cos(ang), sa = Math.sin(ang) // 协方差矩阵的主特征方向
  let rx = 1, ry = 1 // 沿主轴 / 副轴的最大半径 (m)
  for (const [x, y] of poly) { rx = Math.max(rx, Math.abs((x - cx) * ca + (y - cy) * sa)); ry = Math.max(ry, Math.abs(-(x - cx) * sa + (y - cy) * ca)) }
  const BASE = 4.5, DOME = Math.min(22, Math.min(rx, ry) * 0.62) // 基座 4.5m；壳高最多 22m，不超过短半径的 62%（太高像个蛋）
  L.solid.push(annulus(1, 0, BASE, 0, '#cfd3d8'))
  L.solid.push(annulus(1.07, 0, 0.7, 0, '#e6e9ed')) // 基座外的一圈台阶
  // shell: 单位半球（θ 0~π/2）按三个半径缩放、转到主轴方向、坐在基座顶上
  const shell = (kx, ky, kz) => {
    const g = new THREE.SphereGeometry(1, 40, 18, 0, Math.PI * 2, 0, Math.PI / 2)
    g.scale(rx * kx, DOME * ky, ry * kz)
    g.rotateY(-ang)
    g.translate(cx, BASE, cy)
    return g
  }
  L.solid.push(paint(shell(0.93, 1, 0.93).toNonIndexed(), '#e9ecef')) // 主壳缩 7%，留出基座边缘
  L.glassy.push(paint(shell(0.3, 1.012, 0.945).toNonIndexed(), '#9cc3dc')) // 玻璃幕带: 一条更窄但略高的壳，从主壳里「露」出来
  L.heat.push(shell(0.945, 1.03, 0.96)) // 热力层比主壳大一点点，贴在外面
}

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
/** 去掉 uv 属性，几何体才能和没有 uv 的合并 */
function stripUV(g) {
  g.deleteAttribute('uv')
  return g
}

/** 屋面分缝贴图: 128px 的白底方框，按 9m 一格平铺。没有 canvas（测试环境）时返回 null */
function roofTexture(angle) {
  if (typeof document === 'undefined') return null
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const c2 = cv.getContext('2d')
  if (!c2) return null
  c2.fillStyle = '#fff'
  c2.fillRect(0, 0, 128, 128)
  c2.strokeStyle = 'rgba(120,128,138,0.55)' // 半透明灰的分缝线，2px 宽；贴图平铺后每格四边各一条
  c2.lineWidth = 2
  c2.strokeRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(1 / 9, 1 / 9) // 9m 一格的屋面分缝
  tex.rotation = angle // 分缝方向跟随街区主方向
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** 一批 {pos, quat, scale, color, bid} 变成一个单位盒子的 InstancedMesh；空列表也建一个 count=0 的网格，省得外面判空 */
function instancedBoxes(items, material, name, castShadow) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, Math.max(1, items.length))
  mesh.name = name
  mesh.count = items.length // 实际画的实例数（空列表时 0，缓冲至少留 1 个位置）
  const m = new THREE.Matrix4(), c = new THREE.Color()
  // 每个实例: 位置 + 朝向 + 缩放合成一个矩阵，颜色写进实例色
  items.forEach((it, i) => {
    m.compose(new THREE.Vector3(...it.pos), it.quat, new THREE.Vector3(...it.scale))
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.set(it.color))
  })
  // bid 按实例存；空位填 -2（永远不等于任何楼号，也不等于 hiddenBuilding 的 -1）
  mesh.geometry.setAttribute('bid', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, items.length)).map((_, i) => items[i]?.bid ?? -2), 1))
  mesh.castShadow = castShadow
  mesh.receiveShadow = true
  mesh.frustumCulled = false // 实例分布在全城，单位盒子的包围球不准，关掉剔除
  return withShadowHiding(mesh)
}
