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
    expect(d.buildings).toEqual([{ polygon: [[1, 1], [5, 1], [5, 5]], kind: 'shop', floors: 3 }]) // 楼原样
    expect(d.areas[0].kind).toBe('green') // 区域类型
    expect(d.background).toEqual({ url: 'x.jpg' }) // 底图文件名
    expect(d.origin.summary.mpp).toBe(0.3) // 经纬度换算要原图尺寸
    expect([d.widthM, d.heightM]).toEqual([300, 200]) // 画布 = 底图尺寸
    expect(d.doors).toEqual([]) // 店门不带，重新生成时自动布
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
    expect(E.stats(d)).toEqual({ roads: 1, roadKm: 0.7, buildings: 0, areas: 0, doors: 1, portals: 0 }) // 0.7 公里
  })

  it('类型表和标记调色板一致（map2scene 靠颜色认类型）', () => {
    expect(E.BUILDING_KINDS.map((k) => k.id)).toEqual(['shop', 'block', 'residential', 'venue']) // 建筑类型顺序
    expect(E.AREA_KINDS.map((k) => k.id)).toEqual(['green', 'park', 'water', 'plaza', 'parking']) // 区域类型顺序
  })
})
