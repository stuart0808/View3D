// 场景编辑器纯逻辑（editor/src/model.js）的测试: 路宽、已有场景拆成矢量图、命中测试、吸附、45° 取向、生成前检查、统计。
import { describe, it, expect } from 'vitest' // vitest 的断言
import * as E from '../src/model.js' // 被测模块

describe('路宽', () => { // 路宽规则
  it('按车道数算，双向乘 2；手填的优先', () => {
    expect(E.roadWidth({ lanes: 2 })).toBe(14) // 双向 2+2
    expect(E.roadWidth({ lanes: 3, oneway: true })).toBe(10.5) // 单行 3 车道
    expect(E.roadWidth({})).toBe(7) // 没填按 1 条
    expect(E.roadWidth({ lanes: 2, width: 20 })).toBe(20) // 手填
  })
})

describe('已有场景 → 矢量图', () => { // 场景拆成矢量图
  // 一个最小场景: 两条路（一条逆点序单行、一条环道）、一条高架、一栋楼、一块绿地、有底图和经纬度
  const scene = { // 最小场景
    bounds: { minX: -90, minY: -40, maxX: 100, maxY: 60 }, // 场景范围
    roadGraph: {
      edges: [
        { a: '1', b: '2', width: 10.5, points: [[0, 0], [50, 0]], oneway: -1, laneCount: 3 }, // 逆点序的三车道单行路
        { a: '3', b: '4', width: 7, points: [[0, 10], [5, 15]], oneway: 1, roundabout: true }, // 环道
        { a: 'e1', b: 'e2', width: 14, points: [[-90, 0], [100, 0]], level: 1 }, // 高架
      ],
    },
    buildings: [{ id: 'b1', kind: 'shop', floors: 3, polygon: [[1, 1], [5, 1], [5, 5]] }], // 一栋 3 层商铺
    areas: [{ kind: 'green', polygon: [[0, 0], [1, 0], [1, 1]] }], // 一块绿地
    imagery: { url: 'x.jpg', widthM: 300, heightM: 200 }, // 底图
    origin: { geo: { type: 'webmerc' }, summary: { width: 1000, height: 600, mpp: 0.3, buildings: 1 } }, // 经纬度 + 原图尺寸
  }

  it('路: 单行按行驶方向重排点序，车道数沿用；环道当双向路；高架带标记', () => {
    const d = E.sceneToDrawing(scene) // 拆成矢量图
    expect(d.roads[0]).toMatchObject({ points: [[50, 0], [0, 0]], lanes: 3, oneway: true, width: 10.5, elevated: false })
    expect(d.roads[1]).toMatchObject({ oneway: false, width: 7 }) // 环道: 重新生成时按形状再识别
    expect(d.roads[2].elevated).toBe(true) // 高架路带标记
    expect(d.roads[2].lanes).toBe(2) // 14 米双向没指定车道数: 按路宽推 2 条
  })

  it('楼、区域、底图、经纬度原样带上；画布用底图尺寸', () => {
    const d = E.sceneToDrawing(scene) // 拆成矢量图
    expect(d.buildings).toEqual([{ id: 'b1', polygon: [[1, 1], [5, 1], [5, 5]], kind: 'shop', floors: 3 }]) // 楼原样，带上编号
    expect(d.areas[0].kind).toBe('green') // 区域类型
    expect(d.background).toEqual({ url: 'x.jpg' }) // 底图文件名
    expect(d.origin.summary.mpp).toBe(0.3) // 经纬度换算要原图尺寸
    expect([d.widthM, d.heightM]).toEqual([300, 200]) // 画布 = 底图尺寸
    expect(d.doors).toEqual([]) // 场景里没有门
  })

  it('没有底图: 画布取关于原点对称、包住场景范围的大小', () => {
    const d = E.sceneToDrawing({ ...scene, imagery: undefined, origin: undefined }) // 去掉底图和经纬度
    expect([d.widthM, d.heightM]).toEqual([200, 120]) // 2 × max(|-90|, 100)，2 × max(|-40|, 60)
    expect(d.background).toBeNull() // 没有底图
    expect(d.origin).toBeNull() // 没有经纬度
  })
})

describe('几何', () => { // 几何函数
  it('点到线段 / 折线的距离', () => {
    expect(E.nearestOnSegment([0, 0], [10, 0], [5, 3])).toEqual({ q: [5, 0], d: 3 }) // 垂足
    expect(E.nearestOnSegment([0, 0], [10, 0], [-4, 3]).d).toBe(5) // 超出端点: 到端点的距离
    expect(E.distToPolyline([[0, 0], [10, 0], [10, 10]], [12, 5])).toBe(2) // 离第二段更近
  })

  it('点选: 点 > 路 > 楼 > 区域，后画的优先', () => {
    const d = { // 一条路、一栋楼、一块区域、一个店门
      ...E.emptyDrawing(),
      roads: [{ points: [[0, 0], [100, 0]], lanes: 1 }], // 路宽 7 米
      buildings: [{ polygon: [[10, 10], [30, 10], [30, 30], [10, 30]], kind: 'shop' }], // 楼
      areas: [{ polygon: [[0, 5], [50, 5], [50, 50], [0, 50]], kind: 'park' }], // 区域比楼大，把楼盖住
      doors: [{ pos: [20, 10] }], // 店门在楼的北墙上
    }
    expect(E.hitTest(d, [20, 10.5], 1)).toEqual({ type: 'doors', index: 0 }) // 店门在楼边上，点优先
    expect(E.hitTest(d, [50, 3], 1)).toEqual({ type: 'roads', index: 0 }) // 路面半宽 3.5 米内
    expect(E.hitTest(d, [20, 20], 1)).toEqual({ type: 'buildings', index: 0 }) // 楼压在区域上
    expect(E.hitTest(d, [40, 40], 1)).toEqual({ type: 'areas', index: 0 }) // 只有区域的地方
    expect(E.hitTest(d, [200, 200], 1)).toBeNull() // 空地
  })

  it('吸附: 顶点优先，其次中心线；不吸自己', () => {
    const d = { ...E.emptyDrawing(), roads: [{ points: [[0, 0], [100, 0]] }, { points: [[50, -50], [50, 50]] }] } // 十字交叉的两条路
    expect(E.snapToRoads(d, [1, 1], 3)).toMatchObject({ p: [0, 0], kind: 'vertex' }) // 端点
    expect(E.snapToRoads(d, [30, 2], 3)).toMatchObject({ p: [30, 0], kind: 'line' }) // 中心线上的垂足
    expect(E.snapToRoads(d, [30, 10], 3)).toBeNull() // 太远
    expect(E.snapToRoads(d, [1, 1], 3, 0)).toBeNull() // 跳过第 0 条（正在改的那条）
  })

  it('Shift 取 45° 整数倍方向，长度不变', () => {
    const q = E.snapAngle([0, 0], [10, 1]) // 接近水平 → 水平
    expect(q[0]).toBeCloseTo(Math.hypot(10, 1)) // 长度不变
    expect(q[1]).toBeCloseTo(0) // y 归零
    const r = E.snapAngle([0, 0], [10, 9]) // 接近 45°
    expect(r[0]).toBeCloseTo(r[1]) // x = y
  })

  it('顶点平均点、点在多边形内', () => {
    expect(E.centroid([[0, 0], [4, 0], [4, 2], [0, 2]])).toEqual([2, 1]) // 矩形中心
    expect(E.inside([[0, 0], [4, 0], [4, 2], [0, 2]], 1, 1)).toBe(true) // 里面
    expect(E.inside([[0, 0], [4, 0], [4, 2], [0, 2]], 5, 1)).toBe(false) // 外面
  })
})

describe('生成前检查和统计', () => { // 生成前检查
  it('空画布、画布过小、点数不够都报出来', () => {
    expect(E.problems(E.emptyDrawing())).toEqual(['至少画一条路或一栋楼']) // 空画布
    const bad = { ...E.emptyDrawing(10, 300), roads: [{ points: [[0, 0]] }], buildings: [{ polygon: [[0, 0], [1, 1]] }], areas: [{ polygon: [] }] } // 宽度太小、各种点数不够
    expect(E.problems(bad)).toEqual(['画布宽高要在 20 ~ 3000 米之间', '第 1 条路少于 2 个点', '第 1 栋楼少于 3 个点', '第 1 块区域少于 3 个点']) // 每个问题一条
    expect(E.problems({ ...E.emptyDrawing(), roads: [{ points: [[0, 0], [1, 0]] }] })).toEqual([]) // 一条路就能生成
  })

  it('统计: 路的总长（公里，一位小数）和各类数量', () => {
    const d = { ...E.emptyDrawing(), roads: [{ points: [[0, 0], [300, 0], [300, 400]] }], doors: [{ pos: [0, 0] }] } // 300 + 400 米的折线、一个店门
    expect(E.stats(d)).toEqual({ roads: 1, roadKm: 0.7, buildings: 0, areas: 0, doors: 1, portals: 0, junctions: 0 }) // 0.7 公里
  })

  it('类型表和标记调色板一致（map2scene 靠颜色认类型）', () => {
    expect(E.BUILDING_KINDS.map((k) => k.id)).toEqual(['shop', 'block', 'residential', 'venue']) // 建筑类型顺序
    expect(E.AREA_KINDS.map((k) => k.id)).toEqual(['green', 'park', 'water', 'plaza', 'parking']) // 区域类型顺序
  })
})

describe('打开已有场景时保留身份和设置', () => { // 编辑已有场景
  // 两栋楼（一栋场馆、一栋做过实地标注），两扇门，一个设过的路口和一个没设过的
  const scene = { // 最小场景
    bounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 }, // 场景范围
    roadGraph: {
      nodes: { x: { pos: [0, 0], degree: 4, signal: { green: [40, 10] }, noLeft: true }, y: { pos: [50, 0], degree: 3 }, z: { pos: [-50, 0], degree: 3, control: 'none' } }, // 设过的十字路口、没设过的路口、设成无灯的路口
      edges: [], // 这组测试用不到边
    },
    buildings: [
      { id: 'b7', kind: 'venue', floors: 4, attraction: 1, venue: { name: '体育馆', type: 'stadium', capacity: 5000 }, polygon: [[0, 0], [1, 0], [1, 1]] }, // 场馆，默认吸引力
      { id: 'b9', kind: 'shop', floors: 2, attraction: 2.8, shops: [{ id: 's1', name: '面馆' }], polygon: [[5, 5], [6, 5], [6, 6]] }, // 实地标注写回过的商铺
    ],
    doors: [{ building: 'b9', pos: [5.5, 5], normal: [0, -1] }, { building: 'b7', pos: [0.5, 0], normal: [0, -1] }], // 两扇门
  }
  const d = E.sceneToDrawing(scene) // 拆成矢量图

  it('楼带上编号、场馆信息、实地标注的商户和吸引力；默认吸引力 1 不带', () => {
    expect(d.buildings[0]).toMatchObject({ id: 'b7', venue: { name: '体育馆', type: 'stadium', capacity: 5000 } })
    expect(d.buildings[0].attraction).toBeUndefined() // 默认值不写
    expect(d.buildings[1]).toMatchObject({ id: 'b9', attraction: 2.8, shops: [{ id: 's1', name: '面馆' }] })
  })

  it('店门全部带上（实测的门重新生成后位置不变）', () => {
    expect(d.doors).toEqual([{ pos: [5.5, 5] }, { pos: [0.5, 0] }]) // 位置原样
  })

  it('设过的路口还原成路口设置，没设过的不生成', () => {
    expect(d.junctions).toEqual([ // 两条设置
      { pos: [0, 0], control: 'signal', green: [40, 10], noLeft: true }, // 十字路口
      { pos: [-50, 0], control: 'none', green: null, noLeft: false }, // 无灯的路口
    ])
  })
})

describe('路段合并', () => { // 路段合并
  it('直直穿过路口的两段接成一条，拐弯的不接', () => {
    const roads = [ // 一个路口上的三段
      { points: [[-100, 0], [0, 0]], lanes: 2 }, // 西段
      { points: [[0, 0], [100, 0]], lanes: 2 }, // 东段: 和西段一条直线
      { points: [[0, 0], [0, -100]], lanes: 2 }, // 北段: 90° 拐弯，不接
    ]
    const m = E.mergeRoads(roads) // 合并
    expect(m).toHaveLength(2) // 东西接成一条，北段单独
    expect(m.find((r) => r.points.length === 3).points).toEqual([[-100, 0], [0, 0], [100, 0]]) // 接起来的，穿过路口中心
    expect(roads[0].points).toEqual([[-100, 0], [0, 0]]) // 不改传进来的
  })

  it('两段都从接点出发时把一段倒过来；属性不同的不接', () => {
    const m = E.mergeRoads([{ points: [[0, 0], [-50, 0]] }, { points: [[0, 0], [50, 0]] }]) // 背对背
    expect(m).toHaveLength(1) // 接成一条
    expect(m[0].points).toEqual([[50, 0], [0, 0], [-50, 0]]) // 东端在前
    expect(E.mergeRoads([{ points: [[0, 0], [-50, 0]], lanes: 1 }, { points: [[0, 0], [50, 0]], lanes: 3 }])).toHaveLength(2) // 车道数不同
  })

  it('单行路只接首尾相接的，接完点序仍是行驶方向', () => {
    const a = { points: [[-50, 0], [0, 0]], oneway: true, lanes: 2 }, b = { points: [[0, 0], [50, 0]], oneway: true, lanes: 2 }
    expect(E.mergeRoads([b, a])[0].points).toEqual([[-50, 0], [0, 0], [50, 0]]) // 顺序无关
    const c = { points: [[50, 0], [0, 0]], oneway: true, lanes: 2 } // 对头开: 两段都开向接点
    expect(E.mergeRoads([a, c])).toHaveLength(2) // 不接
  })

  it('三段连成一条直路时全部接上', () => {
    const m = E.mergeRoads([{ points: [[0, 0], [10, 0]] }, { points: [[20, 0], [30, 0]] }, { points: [[10, 0], [20, 0]] }])
    expect(m).toHaveLength(1) // 接成一条
    expect(m[0].points).toEqual([[0, 0], [10, 0], [20, 0], [30, 0]]) // 顺序正确
  })
})

describe('路口设置和提醒', () => {
  it('新路口设置默认有灯、默认配时、不禁左；能被点选', () => {
    const j = E.newJunction([3, 4]) // 新建
    expect(j).toEqual({ pos: [3, 4], control: 'signal', green: null, noLeft: false })
    const d = { ...E.emptyDrawing(), junctions: [j] } // 只有一个路口设置的图
    expect(E.hitTest(d, [3.5, 4], 1)).toEqual({ type: 'junctions', index: 0 }) // 点得到
    expect(E.stats(d).junctions).toBe(1) // 统计里有它
  })

  it('高架端点不在画布边上、路口设置附近没有路口，都给提醒', () => {
    const d = {
      ...E.emptyDrawing(200, 100), // 200 × 100 米的画布
      roads: [
        { points: [[-100, 0], [100, 0]], lanes: 2 }, // 地面路，贯通
        { points: [[-100, 10], [50, 10]], lanes: 1, elevated: true }, // 高架: 东端停在画布中间
        { points: [[0, -50], [0, 50]], lanes: 1 }, // 和地面路十字相交
      ],
      junctions: [E.newJunction([0, 0]), E.newJunction([80, 40])], // 一个在十字路口上，一个在空地上
    }
    const w = E.warnings(d) // 提醒列表
    expect(w).toHaveLength(2) // 两条
    expect(w[0]).toMatch(/第 2 条路是高架/) // 高架那条
    expect(w[1]).toMatch(/第 2 个路口设置/) // 空地上的路口设置
    expect(E.warnings({ ...d, roads: [d.roads[0], { ...d.roads[1], points: [[-100, 10], [100, 10]] }, d.roads[2]], junctions: [] })).toEqual([]) // 两端到边就没事
  })

  it('场馆类型和需求模型的排期规则一致', () => {
    expect(E.VENUE_TYPES.map((v) => v.id)).toEqual(['stadium', 'opera', 'default']) // 顺序和 demand.js 一致
  })
})
