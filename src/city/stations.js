// 车站模型。按「这一站有哪些线」分成三类:
//   metro  只有地铁: 地面上一两个玻璃出入口亭（带坡屋顶和扶梯口）+ 线路色的站名柱；站体在地下，用透视圆环示意
//   rail   只有铁路（城际 / 高铁）: 高架站 —— 轨道从站房里穿过，站房是带弧形大屋顶的长方体，正面玻璃幕，
//          轨面标高处有站台和雨棚；站前一块广场
//   hub    铁路 + 地铁的综合枢纽: 更大的站房 + 两翼的换乘厅，地铁出入口直接开在站房正面的檐廊下，站前广场更大
// stationLayouts() 只算「每一站是什么类型、放在哪、朝哪、多大」，是纯函数，可以直接测；buildStationMeshes() 才画东西。
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CURB_H } from './ground.js'
import { RAIL_H } from './roads.js'
import { pointInPolygon } from './geometry.js'

/** 三类车站的尺寸（米）。length 沿轨道方向，width 垂直于轨道 */
export const STATION_SPEC = {
  metro: { pavilion: [6.5, 3.2, 3.6], totem: 5.5 }, // 出入口亭 宽×高×深；站名柱高
  rail: { length: 120, width: 44, height: 22, forecourt: 60 }, // 站房 120×44m、22m 高；站前广场进深 60m
  hub: { length: 150, width: 56, height: 26, wing: [70, 34, 12], forecourt: 90 }, // 枢纽更大；两翼换乘厅 70×34m、12m 高
}

/** 一站的类型: 有铁路又有地铁是枢纽，只有铁路是高铁站，其余是地铁站 */
export function classifyStation(lines) {
  const rail = lines.some((l) => l.kind === 'rail'), metro = lines.some((l) => l.kind === 'metro')
  return rail && metro ? 'hub' : rail ? 'rail' : 'metro'
}

/** 在折线上找离 p 最近的点，返回该处的切向（站房要顺着轨道摆） */
function tangentNear(pts, p) {
  let best = Infinity, dir = [1, 0] // 最近距离、该段的单位切向
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) // 投影参数夹到线段内
    const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)
    if (d < best) { best = d; dir = [dx / Math.sqrt(l2), dy / Math.sqrt(l2)] } // 更近的段就用它的方向
  }
  return dir
}

/**
 * 每个车站的布局。
 * @param stations  Map 或数组: { name, pos:[x,y], lines:[{kind, color, points}], entrances:[[x,y]...] }
 * @param buildings 场景里的建筑（可选）: 站前广场会选压到建筑更少的那一侧
 * @returns [{ name, kind, x, y, tx, ty, angle(站房长轴方向，弧度，二维), color(主线路色), lineCount, entrances, side }]
 *   side: 站前广场在轨道的哪一侧（+1 = 轨道方向的右手侧，-1 = 左手侧）
 */
export function stationLayouts(stations, buildings = []) {
  const out = []
  for (const st of stations.values ? stations.values() : stations) { // 接受 Map 或数组
    const kind = classifyStation(st.lines)
    const rail = st.lines.find((l) => l.kind === 'rail') // 有铁路线就沿它摆
    // 地铁站没有地面体量，方向无所谓；铁路站房沿轨道
    const [tx, ty] = rail ? tangentNear(rail.points, st.pos) : [1, 0]
    // 广场朝哪边: 在两侧各撒几个采样点，数落在建筑里的有几个，少的那侧放广场
    let side = 1
    if (kind !== 'metro' && buildings.length) {
      const sp = STATION_SPEC[kind]
      const hits = (sgn) => { // sgn 侧的广场范围内 3×3 个采样点里有几个压在建筑上
        let n = 0
        for (const a of [-0.4, 0, 0.4]) for (const b of [0.3, 0.6, 0.9]) { // 沿轨道 ±40% 站长；垂直方向广场进深的 30/60/90%
          const along = a * sp.length, across = sgn * (sp.width / 2 + b * sp.forecourt)
          const px = st.pos[0] + tx * along - ty * across, py = st.pos[1] + ty * along + tx * across
          if (buildings.some((bd) => pointInPolygon(px, py, bd.polygon))) n++
        }
        return n
      }
      side = hits(1) <= hits(-1) ? 1 : -1 // 压楼少的一侧；相同时取右手侧
    }
    out.push({
      name: st.name, kind, x: st.pos[0], y: st.pos[1], tx, ty, angle: Math.atan2(ty, tx),
      color: (st.lines.find((l) => l.kind === 'metro') || st.lines[0]).color || '#3b7ddd', // 站名柱用地铁线路色，没有就用第一条线的
      lineCount: st.lines.length,
      entrances: st.entrances || [],
      side,
    })
  }
  return out
}

/** 把一个几何体放到 (x, z)，绕 Y 转到沿 (tx, ty) 方向，再抬到 y0 */
function place(g, x, y, tx, ty, y0, along = 0, across = 0) { // along 沿轨道偏移、across 垂直偏移（米），都在站点坐标系里
  g.rotateY(Math.atan2(-ty, tx)) // 二维 y 向下对应三维 z，转角取负
  g.translate(x + tx * along - ty * across, y0, y + ty * along + tx * across) // 站点坐标系 → 世界
  g.deleteAttribute('uv') // 不贴图，去掉才能和别的几何体合并
  return g.index ? g.toNonIndexed() : g
}

/**
 * 画出所有车站。返回一个 Group，里面按材质合并成几个网格（实体墙、玻璃、屋顶、透视标记）。
 * 用到的都是最基本的体块: 站房 = 盒子 + 半圆柱的弧形屋顶；出入口亭 = 玻璃盒 + 斜顶；站名柱 = 细杆 + 色块。
 */
export function buildStationMeshes(layouts) {
  const solid = [], glass = [], roof = [], accent = [], marks = [] // 按材质分五组
  const paint = (g, hex) => { // 顶点色，让不同站房 / 不同线路色共用一个材质
    const c = new THREE.Color(hex), n = g.attributes.position.count, col = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return g
  }
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d)

  for (const s of layouts) {
    const { x, y, tx, ty, side } = s
    // ---- 地铁出入口: 每个出入口一个玻璃亭 + 站名柱；枢纽的出入口也用同一套 ----
    if (s.kind !== 'rail') {
      const [pw, ph, pd] = STATION_SPEC.metro.pavilion
      for (const [ex, ey] of s.entrances) {
        // 亭子: 玻璃盒，靠站点那一侧开口（用一块深色板表示扶梯口）
        glass.push(paint(place(box(pw, ph, pd), ex, ey, tx, ty, CURB_H + ph / 2), '#9cc0d6')) // 立在路沿标高上
        // 斜顶: 沿短边倾斜的薄板，比亭子大一圈
        const top = box(pw + 1.2, 0.25, pd + 1.0) // 四周各挑出 0.5~0.6m
        top.rotateX(0.16) // 约 9° 的坡
        roof.push(paint(place(top, ex, ey, tx, ty, CURB_H + ph + 0.35), '#2f6fd0'))
        // 扶梯口: 亭子前一块下沉的深色板
        solid.push(paint(place(box(pw - 1.5, 0.15, 3.2), ex, ey, tx, ty, CURB_H + 0.05, 0, pd / 2 + 1.6), '#2a2f36'))
        // 站名柱: 细杆 + 顶上线路色的方块（换乘站叠两块）
        accent.push(paint(place(box(0.22, STATION_SPEC.metro.totem, 0.22), ex, ey, tx, ty, CURB_H + STATION_SPEC.metro.totem / 2, pw / 2 + 0.8, -pd / 2), '#5b626c'))
        for (let k = 0; k < Math.min(2, s.lineCount); k++) {
          accent.push(paint(place(box(1.0, 0.7, 0.3), ex, ey, tx, ty, CURB_H + STATION_SPEC.metro.totem - 0.4 - k * 0.8, pw / 2 + 0.8, -pd / 2), s.color))
        }
      }
      // 地下站体的示意: 透视叠加的圆环，换乘站更大
      const ring = new THREE.RingGeometry(s.lineCount > 1 ? 9 : 7, s.lineCount > 1 ? 14 : 11, 24) // 内外半径（米）
      ring.rotateX(-Math.PI / 2) // 放平
      ring.translate(x, 0.9, y) // 略高于地铁色带（0.7）
      ring.deleteAttribute('uv'); ring.deleteAttribute('normal')
      marks.push(ring.toNonIndexed())
    }
    if (s.kind === 'metro') continue

    // ---- 铁路站房: 轨道在 RAIL_H 标高穿过站房，站房高过轨道一层 ----
    const sp = STATION_SPEC[s.kind]
    const H = sp.height, L = sp.length, W = sp.width // 站房高 / 长（沿轨道）/ 宽
    // 主体: 实心体量上部留出轨道穿过的「洞」—— 用两片侧墙 + 顶上的屋顶盒表示，中间空着给轨道
    for (const sgn of [1, -1]) solid.push(paint(place(box(L, H - 4, 3), x, y, tx, ty, (H - 4) / 2, 0, sgn * (W / 2 - 1.5)), '#dfe3e8')) // 两片 3m 厚的侧墙，比屋顶矮 4m
    // 正面 / 背面: 大玻璃幕（背面矮一截）
    glass.push(paint(place(box(L - 6, H - 6, 0.4), x, y, tx, ty, (H - 6) / 2 + 1, 0, side * (W / 2 - 0.2)), '#8fb4cf'))
    glass.push(paint(place(box(L - 6, RAIL_H - 2, 0.4), x, y, tx, ty, (RAIL_H - 2) / 2 + 1, 0, -side * (W / 2 - 0.2)), '#8fb4cf'))
    // 弧形大屋顶: 半圆柱沿轨道方向，压扁成弧
    const arc = new THREE.CylinderGeometry(W / 2 + 2, W / 2 + 2, L + 4, 24, 1, false, 0, Math.PI) // 半个圆柱面（θ 0~π），比站房宽 2m、长 4m
    arc.rotateZ(Math.PI / 2) // 圆柱轴从 Y 转到 X（沿站房长轴）
    arc.scale(1, 0.32, 1)   // 压扁
    roof.push(paint(place(arc, x, y, tx, ty, H - 0.5), '#eef0f3'))
    // 屋顶两端的山墙（封住弧顶的两头）
    for (const sgn of [1, -1]) {
      const gable = new THREE.CircleGeometry(W / 2 + 2, 24, 0, Math.PI) // 半圆
      gable.rotateY(-Math.PI / 2); gable.scale(1, 0.32, 1) // 立起来、和弧顶同样压扁
      solid.push(paint(place(gable, x, y, tx, ty, H - 0.5, sgn * (L / 2 + 2), 0), '#d5d9de'))
    }
    // 站台层: 轨道两侧的站台板 + 站台上的柱子
    for (const sgn of [1, -1]) {
      solid.push(paint(place(box(L - 2, 0.8, 9), x, y, tx, ty, RAIL_H - 0.4, 0, sgn * 9.5), '#c9ced5')) // 9m 宽站台，顶面 = 轨面
      for (let k = -2; k <= 2; k++) solid.push(paint(place(box(0.8, H - 0.5 - RAIL_H, 0.8), x, y, tx, ty, (RAIL_H + H - 0.5) / 2, k * (L / 5), sgn * 9.5), '#c9ced5'))
    }
    // 站前广场: 浅色铺装薄板，在正面（+across 侧）
    const fc = sp.forecourt
    solid.push(paint(place(box(L + 20, 0.12, fc), x, y, tx, ty, 0.14, 0, side * (W / 2 + fc / 2)), '#ddd6cb')) // 比站房两头各宽 10m，贴在路沿标高上
    // 檐廊: 正面探出的一片薄顶，人在下面进出
    roof.push(paint(place(box(L - 10, 0.5, 8), x, y, tx, ty, 7, 0, side * (W / 2 + 4)), '#eef0f3')) // 7m 高、探出 8m
    // 站名: 正面顶上一条线路色的长牌
    accent.push(paint(place(box(L * 0.5, 1.6, 0.6), x, y, tx, ty, H - 4, 0, side * (W / 2 + 0.3)), s.kind === 'hub' ? '#7b3fb5' : '#3b7ddd'))

    // ---- 枢纽: 两翼的换乘厅（矮一截、平顶、玻璃），把地铁和铁路连成一体 ----
    if (s.kind === 'hub') {
      const [wl, ww, wh] = sp.wing // 翼长 / 宽 / 高
      for (const sgn of [1, -1]) { // 站房两端各一翼，和站房搭接 6m，向广场侧探出 4m
        solid.push(paint(place(box(wl, wh, ww), x, y, tx, ty, wh / 2, sgn * (L / 2 + wl / 2 - 6), side * (W / 2 - ww / 2 + 4)), '#dfe3e8'))
        glass.push(paint(place(box(wl - 4, wh - 3, 0.4), x, y, tx, ty, wh / 2, sgn * (L / 2 + wl / 2 - 6), side * (W / 2 + 4.2)), '#8fb4cf'))
        roof.push(paint(place(box(wl + 1, 0.5, ww + 1), x, y, tx, ty, wh + 0.25, sgn * (L / 2 + wl / 2 - 6), side * (W / 2 - ww / 2 + 4)), '#eef0f3'))
      }
    }
  }

  const group = new THREE.Group()
  group.name = 'stations'
  const add = (geos, mat, name, cast = true) => {
    if (!geos.length) return
    const m = new THREE.Mesh(mergeGeometries(geos), mat)
    m.name = name
    m.castShadow = cast
    m.receiveShadow = cast
    group.add(m)
  }
  add(solid, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 'stationSolid') // 哑光墙体
  add(glass, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.85 }), 'stationGlass') // 半透明玻璃
  add(roof, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), 'stationRoof') // 弧顶是单面壳，两面都画
  add(accent, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), 'stationAccent')
  if (marks.length) {
    // 透视标记: 不做深度测试，永远叠在最上面
    const m = new THREE.Mesh(mergeGeometries(marks), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false }))
    m.renderOrder = 11
    group.add(m)
  }
  return group
}
