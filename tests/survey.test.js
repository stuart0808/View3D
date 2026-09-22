// 实地标注工具纯逻辑（src/survey/model.js）的测试: 网格编号、坐标换算（和 Python 的 tools/osm.py 对表）、
// 吸附到外墙、沿墙取临街范围、商户增删改和日志、GeoJSON / CSV 导出。
import { describe, it, expect } from 'vitest' // vitest 的断言
import * as M from '../src/survey/model.js' // 被测模块

// 一栋 20 × 10 米的楼，左上角在原点（y 向下，和场景坐标一致）
const RECT = [[0, 0], [20, 0], [20, 10], [0, 10]]

describe('网格', () => {
  it('行号是字母、超过 26 行接着编 AA，列号两位', () => {
    // 0 → A，25 → Z，26 → AA，27 → AB，701 → ZZ，702 → AAA（和表格列名同一套规则）
    expect([0, 25, 26, 27, 701, 702].map(M.rowLabel)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
    expect(M.cellId(1, 2)).toBe('B03') // 第 2 行第 3 列
  })

  it('按 50 米切格、向上取整，点能找到所在格子，出界为 null', () => {
    // 场景 120 × 60 米: 3 列 × 2 行（最后一列 / 行不满一格也算一格）
    const g = M.makeGrid({ minX: -60, minY: -30, maxX: 60, maxY: 30 }) // 120 × 60 米的场景
    expect([g.cols, g.rows, g.cells.length]).toEqual([3, 2, 6]) // 列、行、格子总数
    expect(g.cells[0]).toMatchObject({ id: 'A01', x0: -60, y0: -30, x1: -10, y1: 20 }) // 第一格的编号和范围
    // 左上角 → A01；右下角附近 → B03；网格外 → null
    expect(M.cellAt(g, -59, -29)).toBe('A01')
    expect(M.cellAt(g, 59, 29)).toBe('B03')
    expect(M.cellAt(g, -61, 0)).toBeNull()
    expect(M.cellAt(g, 0, 100)).toBeNull()
  })
})

describe('坐标换算（期望值由 tools/osm.py 的 GeoRef 算出）', () => {
  // 测试点都是「原图中心往右 100 像素、往上 50 像素」，场景坐标 = (100, -50) × mpp
  const cases = [
    // 网络地图截图（WGS84）: 真实导入过的 sh-web-test 场景的参数
    { geo: { type: 'webmerc', lat: 31.295273, lon: 121.67441, zoom: 18.764, scale: 1, datum: 'wgs84' }, W: 2222, H: 1950, mpp: 0.3005, ll: [121.67472588986828, 31.2954079641163] },
    // 高德截图（GCJ-02，高分屏 2 倍）: 出入都要经过火星坐标换算
    { geo: { type: 'webmerc', lat: 31.23, lon: 121.47, zoom: 18, scale: 2, datum: 'gcj02' }, W: 1600, H: 1200, mpp: 0.256084593677938, ll: [121.46571990043948, 31.232035177908333] },
    // 经纬度网格（GeoTIFF / SpaceNet）
    { geo: { type: 'lonlat', lon0: 121.5, lat0: 31.25, dlon: 3e-6, dlat: 2.7e-6 }, W: 1000, H: 800, mpp: 0.2855083279560712, ll: [121.5018, 31.249055] },
  ]
  for (const c of cases) {
    it(`${c.geo.type} ${c.geo.datum || ''}: 场景米 ⇄ 经纬度`, () => {
      const g = M.makeGeo({ geo: c.geo, summary: { width: c.W, height: c.H, mpp: c.mpp } }) // 按 autoscene 写进场景的 origin 格式构造
      const [lon, lat] = g.toLonLat(100 * c.mpp, -50 * c.mpp) // 场景米 → 经纬度
      // 1e-7 度 ≈ 1 厘米
      expect(lon).toBeCloseTo(c.ll[0], 7) // 经度对上 Python
      expect(lat).toBeCloseTo(c.ll[1], 7) // 纬度对上 Python
      // 反过来要回到原处（GCJ-02 的逆是迭代的，误差 < 0.5 米，这里放宽到 5 厘米）
      const [x, y] = g.toScene(lon, lat) // 经纬度 → 场景米
      expect(Math.abs(x - 100 * c.mpp)).toBeLessThan(0.05) // x 回到原处
      expect(Math.abs(y + 50 * c.mpp)).toBeLessThan(0.05) // y 回到原处
    })
  }

  it('GCJ-02 加偏和 Python 一致，国外不加偏', () => {
    const [lon, lat] = M.wgs84ToGcj02(121.47, 31.23) // 上海市中心附近
    expect(lon).toBeCloseTo(121.47453490044272, 9) // 经度偏移和 Python 一致
    expect(lat).toBeCloseTo(31.22806748194233, 9) // 纬度偏移和 Python 一致
    expect(M.wgs84ToGcj02(2.35, 48.85)).toEqual([2.35, 48.85]) // 巴黎
    expect(M.gcj02ToWgs84(2.35, 48.85)).toEqual([2.35, 48.85]) // 反方向同样不动
  })

  it('没有地理位置（只给分辨率 / 内置场景）返回 null', () => {
    expect(M.makeGeo(undefined)).toBeNull() // 场景没有 origin
    expect(M.makeGeo({ geo: false, summary: { width: 10, height: 10, mpp: 0.3 } })).toBeNull() // 只给分辨率导入的图
    expect(M.makeGeo({ geo: { type: 'webmerc', lat: 0, lon: 0, zoom: 18 } })).toBeNull() // 缺尺寸
    expect(M.makeGeo({ geo: { type: 'utm' }, summary: { width: 10, height: 10, mpp: 1 } })).toBeNull() // 不认识的类型
  })
})

describe('几何', () => {
  it('点在楼里 / 楼外；后画的楼优先', () => {
    expect(M.inside(RECT, 5, 5)).toBe(true) // 楼中间
    expect(M.inside(RECT, 25, 5)).toBe(false) // 楼右边
    const a = { id: 'a', polygon: RECT }, b = { id: 'b', polygon: [[5, 0], [30, 0], [30, 10], [5, 10]] } // a、b 在 x = 5~20 重叠
    // 重叠区域取后面那栋；只在 a 里的取 a；都不在是 null
    expect(M.buildingAt([a, b], 10, 5).id).toBe('b')
    expect(M.buildingAt([a, b], 2, 5).id).toBe('a')
    expect(M.buildingAt([a, b], 50, 5)).toBeNull()
  })

  it('顶点平均点', () => {
    expect(M.centroid(RECT)).toEqual([10, 5]) // 20 × 10 矩形的中心
  })

  it('吸附到最近的外墙，法线朝外（顺时针、逆时针轮廓都对）', () => {
    // 楼下方（y = 12）点一下 → 吸到下边 y = 10，法线朝下（+y）
    const s = M.snapToWall(RECT, 7, 12) // 在楼下方 2 米处点
    expect(s.pos).toEqual([7, 10]) // 吸到下边
    expect(s.normal).toEqual([0, 1]) // 朝下（朝外）
    expect(s.dist).toBeCloseTo(2) // 离墙 2 米
    // 弧长: 上边 20 + 右边 10 + 下边从右往左走 13 = 43
    expect(s.s).toBeCloseTo(43)
    // 反向的轮廓: 法线仍朝外
    const r = M.snapToWall([...RECT].reverse(), 7, 12) // 逆时针的同一栋楼
    expect(r.pos).toEqual([7, 10]) // 吸到同一点
    expect(r.normal).toEqual([0, 1]) // 法线仍朝外
    // 在楼里面点也吸到最近的墙: 靠左边 → 法线朝左
    expect(M.snapToWall(RECT, 1, 5).normal).toEqual([-1, 0])
    expect(M.snapToWall([[0, 0], [0, 0]], 1, 1)).toBeNull() // 退化轮廓
  })

  it('临街范围沿外墙走较短的方向，拐角带上', () => {
    // 上边 x = 15 → 右边 y = 5: 顺时针走 5 + 5 = 10 米，经过右上角 (20, 0)
    const a = M.snapToWall(RECT, 15, -1), b = M.snapToWall(RECT, 21, 5) // 上边一点、右边一点
    const seg = M.wallSegment(RECT, a.s, b.s) // 从上边走到右边
    expect(seg.path).toEqual([[15, 0], [20, 0], [20, 5]]) // 途经右上角
    expect(seg.length).toBe(10) // 5 + 5 米
    // 倒过来点: 同一段，方向相反
    expect(M.wallSegment(RECT, b.s, a.s).path).toEqual([[20, 5], [20, 0], [15, 0]])
    // 跨过起点（左上角 (0, 0)）: 左边 y = 3 → 上边 x = 4，经过 (0, 0)，共 7 米
    const c = M.snapToWall(RECT, -1, 3), d = M.snapToWall(RECT, 4, -1) // 左边一点、上边一点
    const w = M.wallSegment(RECT, c.s, d.s) // 跨过弧长起点
    expect(w.path).toEqual([[0, 3], [0, 0], [4, 0]]) // 途经左上角
    expect(w.length).toBe(7) // 3 + 4 米
    // 同一条边上两点: 不带拐角
    expect(M.wallSegment(RECT, 2, 6).path).toEqual([[2, 0], [6, 0]])
  })
})

describe('标注数据', () => {
  it('新增 / 修改 / 删除都记日志，删除留墓碑', () => {
    let s = M.emptySurvey('imported/x') // 空白数据
    s = M.upsertShop(s, { id: 's1', building: 'b1', name: '面馆', category: 'food', doors: [] }, '甲', 1000) // 甲新增一家
    s = M.upsertShop(s, { id: 's1', building: 'b1', name: '兰州拉面', category: 'food', doors: [] }, '乙', 2000) // 乙改了店名
    s = M.upsertShop(s, { id: 's2', building: 'b1', name: '便利店', category: 'retail', doors: [] }, '甲', 3000) // 甲又新增一家
    expect(s.shops).toHaveLength(2) // 改名不新增记录
    expect(s.shops[0]).toMatchObject({ name: '兰州拉面', by: '乙', t: 2000 }) // 改过的记后改的人
    s = M.upsertShop(s, { ...s.shops[1], deleted: true }, '甲', 4000)
    expect(s.shops).toHaveLength(2) // 墓碑还在
    expect(M.liveShops(s).map((x) => x.id)).toEqual(['s1']) // 墓碑不算在活的商户里
    expect(M.shopsOf(s, 'b1').map((x) => x.id)).toEqual(['s1']) // b1 上只剩一家
    expect(M.shopsOf(s, 'b2')).toEqual([]) // b2 上没有
    expect(s.log.map((e) => e.action)).toEqual(['add', 'edit', 'add', 'delete']) // 四次操作四条日志
  })

  it('格子状态带人和时间，不改原对象', () => {
    const s0 = M.emptySurvey('d') // 空白数据
    const s = M.setCellStatus(s0, 'B03', 'done', '甲', 5) // 甲把 B03 标成已完成
    expect(s.cells.B03).toEqual({ status: 'done', by: '甲', t: 5 }) // 状态、人、时间
    expect(s.log).toEqual([{ t: 5, by: '甲', action: 'cell:done', id: 'B03' }]) // 也记了日志
    expect(s0.cells).toEqual({}) // 原对象没被改
  })

  it('商户编号: 时间 + 随机数，不同随机数不同编号', () => {
    const a = M.newShopId(1700000000000, () => 0.1), b = M.newShopId(1700000000000, () => 0.2) // 同一毫秒、不同随机数
    expect(a).toMatch(/^s[0-9a-z]+$/) // s 开头的 36 进制串
    expect(a).not.toBe(b) // 不会撞
  })

  it('业态名称；不认识的原样返回', () => {
    expect(M.catName('food')).toBe('餐饮') // 认识的业态
    expect(M.catName('xyz')).toBe('xyz') // 不认识的
    expect(M.catName(undefined)).toBe('') // 没填
  })
})

describe('导出', () => {
  // 一家两扇门、带临街线的店 + 一家已删除的店（不导出）
  const survey = {
    ...M.emptySurvey('imported/x'),
    shops: [
      { id: 's1', building: 'b1', name: '店, "老字号"', category: 'food', floor: '1', doors: [{ pos: [7, 10], normal: [0, 1] }, { pos: [12, 10], normal: [0, 1] }], frontage: [[5, 10], [15, 10]], frontageLen: 10, by: '甲', t: 0 },
      { id: 's2', building: 'b1', deleted: true, doors: [{ pos: [1, 1], normal: [0, 1] }] },
    ],
  }

  it('GeoJSON: 没有地理位置时用场景米；每扇门一个点 + 一条临街线', () => {
    const g = M.toGeoJSON(survey, null) // 不给换算器
    expect(g.crs).toBe('scene-m') // 坐标系标成场景米
    expect(g.features.map((f) => f.geometry.type)).toEqual(['Point', 'Point', 'LineString'])
    expect(g.features[0].geometry.coordinates).toEqual([7, 10]) // 第一扇门的位置原样输出
    expect(g.features[0].properties).toMatchObject({ id: 's1', category: '餐饮', feature: 'door' }) // 业态导出成中文名
  })

  it('GeoJSON: 有地理位置时是经纬度（7 位小数）', () => {
    const geo = { toLonLat: (x, y) => [121 + x * 1e-5, 31 - y * 1e-5] } // 假的换算器: 1 米 = 1e-5 度
    const g = M.toGeoJSON(survey, geo) // 给了换算器
    expect(g.crs).toBe('EPSG:4326') // 坐标系标成经纬度
    expect(g.features[0].geometry.coordinates).toEqual([121.00007, 30.9999]) // (7, 10) 米换算后的经纬度
  })

  it('CSV: BOM 开头、逗号和引号正确转义、删除的不导出', () => {
    const csv = M.toCSV(survey, null) // 不给换算器: 场景米
    expect(csv.charCodeAt(0)).toBe(0xfeff) // Excel 要的 BOM
    const lines = csv.slice(1).split('\r\n') // 去掉 BOM 按行切
    expect(lines).toHaveLength(2) // 表头 + 一家店
    expect(lines[0]).toMatch(/^编号,楼,网格,店名/) // 表头
    // 店名里有逗号和引号: 整格加引号、引号写两遍；门口取第一扇门；两扇门；临街 10 米
    expect(lines[1]).toContain('"店, ""老字号"""')
    expect(lines[1]).toContain(',7,10,2,10,甲,')
  })
})
