// 实地标注涂色板纯逻辑（src/survey/board.js）的测试: 画板坐标、划区工具、涂色撤销、连通块、
// 门口合法性（格点、边缘、朝向）、商户编号延续（改大改小 / 切开 / 合并）、轮廓追踪、分块游程编码。
import { describe, it, expect } from 'vitest' // vitest 的断言
import * as B from '../src/survey/board.js' // 被测模块

/** 建一块 w × h 米的画板，原点在 (0, 0)，方便手算 */
function board(w, h) {
  return B.makeBoard({ minX: 0, minY: 0, maxX: w, maxY: h })
}

/** 按字符画铺画板: 每行一个字符串，'.' = 空白，数字 = 颜色号（测试里一眼看出形状） */
function draw(rows) {
  const b = board(rows[0].length, rows.length) // 尺寸取字符画的宽高
  rows.forEach((line, r) => [...line].forEach((ch, c) => (b.data[r * b.w + c] = ch === '.' ? 0 : +ch)))
  return b
}

/** 格子下标数组 → 'c,r' 字符串排序后比较（顺序无关） */
function cr(b, cells) {
  return cells.map((k) => `${k % b.w},${Math.floor(k / b.w)}`).sort()
}

describe('画板与坐标', () => {
  it('原点取整到米，宽高向上取整，一格一米', () => {
    const b = B.makeBoard({ minX: -10.4, minY: -5.2, maxX: 9.1, maxY: 4.9 }) // 不是整数的场景范围
    expect([b.x0, b.y0, b.w, b.h]).toEqual([-11, -6, 21, 11]) // -11 ~ 10、-6 ~ 5
    expect(b.data.length).toBe(21 * 11) // 一格一个字节
  })

  it('点所在的格子、最近的格点，出界处理', () => {
    const b = board(10, 5)
    expect(B.cellAt(b, 3.7, 2.1)).toEqual([3, 2]) // 向下取整
    expect(B.cellAt(b, -0.1, 1)).toBeNull() // 画板外
    expect(B.cellAt(b, 10, 1)).toBeNull() // 右边界本身已在外面
    expect(B.vertexNear(b, 3.4, 2.6)).toEqual([3, 3]) // 四舍五入
    expect(B.vertexNear(b, 12, -3)).toEqual([10, 0]) // 截到格点范围（格点比格子多一列）
    expect(B.vertexPos(board(3, 3), 2, 1)).toEqual([2, 1])
    expect(B.get(b, -1, 0)).toBe(0) // 出界当空白
  })
})

describe('划区工具', () => {
  const b = board(10, 10)

  it('方形笔刷: 奇数边长居中，偶数往左上偏，出界截掉', () => {
    expect(cr(b, B.brushCells(b, 5, 5, 1))).toEqual(['5,5'])
    expect(B.brushCells(b, 5, 5, 3).length).toBe(9) // 3 × 3
    expect(cr(b, B.brushCells(b, 5, 5, 2))).toEqual(['4,4', '4,5', '5,4', '5,5']) // 往左上偏
    expect(B.brushCells(b, 0, 0, 3).length).toBe(4) // 角上只剩 2 × 2
  })

  it('一笔连成线: 跳格也不断，斜线逐格走', () => {
    expect(B.lineCells(b, 0, 0, 5, 0).length).toBe(6) // 横线 6 格
    const diag = B.lineCells(b, 0, 0, 3, 3) // 对角线
    expect(cr(b, diag)).toEqual(['0,0', '1,1', '2,2', '3,3'])
    expect(B.lineCells(b, 2, 2, 2, 2, 3).length).toBe(9) // 起终点相同 = 一个笔刷
  })

  it('矩形两角顺序随意、含边界、截到画板里', () => {
    expect(B.rectCells(b, 3, 4, 1, 2).length).toBe(9) // 3 × 3
    expect(B.rectCells(b, -5, -5, 1, 1).length).toBe(4) // 出界部分截掉
  })

  it('多边形按格子中心取，楼的天井不算', () => {
    const tri = [[0, 0], [4, 0], [0, 4]] // 直角三角形
    expect(cr(b, B.polygonCells(b, tri))).toEqual(['0,0', '0,1', '0,2', '1,0', '1,1', '2,0']) // 中心 (c+½, r+½) 满足 x + y < 4
    const sq = [[0, 0], [6, 0], [6, 6], [0, 6]], hole = [[2, 2], [4, 2], [4, 4], [2, 4]] // 带洞的方块
    expect(B.polygonCells(b, sq, [hole]).length).toBe(36 - 4)
    expect(B.polygonCells(b, [[0, 0], [1, 1]])).toEqual([]) // 不成形
  })

  it('油漆桶: 同色连通、可加范围、超过上限放弃', () => {
    const d = draw(['11..', '1.1.', '....'])
    expect(B.floodCells(d, 0, 0).length).toBe(3) // 左上的 1（斜对角的 1 不连通）
    expect(B.floodCells(d, 3, 2).length).toBe(8) // 空白连通区（中间那格从下面连过来）
    expect(B.floodCells(d, 3, 2, { within: (c) => c >= 2 }).length).toBe(5) // 只在右两列里填
    expect(B.floodCells(d, 3, 2, { limit: 5 })).toBeNull() // 超过上限
    expect(B.floodCells(d, 9, 9)).toEqual([]) // 画板外
  })
})

describe('涂色与撤销', () => {
  it('一次操作的改动能撤销、重做；涂回原色的格子不算改动', () => {
    const b = board(4, 1)
    const e = B.beginEdit()
    expect(B.paint(b, e, [0, 1, 2], 3)).toBe(3) // 涂三格
    expect(B.paint(b, e, [2], 0)).toBe(1) // 第三格又擦掉: 回到原色
    expect(B.paint(b, e, [0], 3)).toBe(0) // 已经是这个颜色
    const d = B.endEdit(b, e)
    expect([...d.idx]).toEqual([0, 1]) // 只有两格真的变了
    expect([...b.data]).toEqual([3, 3, 0, 0])
    B.undoDiff(b, d)
    expect([...b.data]).toEqual([0, 0, 0, 0])
    B.redoDiff(b, d)
    expect([...b.data]).toEqual([3, 3, 0, 0])
  })
})

describe('连通块', () => {
  it('上下左右同色才连通；块的面积、种子、外包框、中心', () => {
    const b = draw(['11.2', '1..2', '.1.2'])
    const { labels, comps } = B.label(b)
    expect(comps.length - 1).toBe(3) // 左上的 1、下面孤立的 1、右边的 2
    const [a, c, d] = comps.slice(1) // 按扫描顺序
    expect([a.color, a.count, a.seed, a.c0, a.r0, a.c1, a.r1]).toEqual([1, 3, 0, 0, 0, 1, 1])
    expect([c.color, c.count]).toEqual([2, 3]) // 第一行就遇到的 2 先编号
    expect([d.color, d.count]).toEqual([1, 1]) // 斜着挨的 1 是另一家
    expect(labels[0]).toBe(1)
    expect(labels[2]).toBe(0) // 空白格
    expect([c.cx, c.cy]).toEqual([3.5, 1.5]) // 格子中心的平均（米）
  })
})

describe('门口: 格点上、色块边缘、朝外', () => {
  // 一家 3 × 2 的店，左上角在格子 (1, 1)，周围一圈空白
  const b = draw(['.....', '.111.', '.111.', '.....'])
  const { labels } = B.label(b)

  it('直边上只有一个朝向，凸角上两个，内部 / 远处没有', () => {
    expect(B.doorDirs(b, labels, 1, 2, 1)).toEqual(['N']) // 上边中间的格点: 朝北
    expect(B.doorDirs(b, labels, 1, 4, 2)).toEqual(['E']) // 右边中间: 朝东
    expect(B.doorDirs(b, labels, 1, 1, 1)).toEqual(['W', 'N']) // 左上角: 朝西或朝北
    expect(B.doorDirs(b, labels, 1, 4, 3)).toEqual(['E', 'S']) // 右下角
    expect(B.doorDirs(b, labels, 1, 2, 2)).toEqual([]) // 色块内部的格点
    expect(B.doorDirs(b, labels, 1, 0, 0)).toEqual([]) // 离得远
    expect(B.doorDirs(b, labels, 0, 2, 1)).toEqual([]) // 块号 0 = 空白
  })

  it('两家店相邻: 分界线上的格点两边各自朝对方', () => {
    const d = draw(['1122', '1122']) // 两行高: 格点 (2, 1) 在分界线中间，不在画板边上
    const lb = B.label(d).labels
    expect(B.doorDirs(d, lb, 1, 2, 1)).toEqual(['E']) // 1 号店朝东开门，对着 2 号店（商场里常见）
    expect(B.doorDirs(d, lb, 2, 2, 1)).toEqual(['W'])
    expect(B.doorDirs(d, lb, 1, 2, 0)).toEqual(['E', 'N']) // 画板上边缘也是「外面」
    expect(B.blocksAround(d, lb, 2, 1).sort()).toEqual([1, 2])
  })

  it('放门: 吸到最近格点，朝向跟着点的位置，优先选中的店', () => {
    expect(B.placeDoor(b, labels, 2.2, 0.7)).toMatchObject({ label: 1, i: 2, j: 1, dir: 'N' }) // 点在上边外侧
    expect(B.placeDoor(b, labels, 0.8, 1.3)).toMatchObject({ i: 1, j: 1, dir: 'W' }) // 左上角，点偏左 → 朝西
    expect(B.placeDoor(b, labels, 1.3, 0.8)).toMatchObject({ i: 1, j: 1, dir: 'N' }) // 左上角，点偏上 → 朝北
    expect(B.placeDoor(b, labels, 2.4, 1.6)).toBeNull() // 最近的格点 (2, 2) 在店里面
    expect(B.placeDoor(b, labels, 0, 0)).toBeNull() // 周围没店
    const d = draw(['1122'])
    const lb = B.label(d).labels
    expect(B.placeDoor(d, lb, 2, 0.2, 2)).toMatchObject({ label: 2, dir: 'W' }) // 分界线上: 优先给选中的 2 号
    expect(B.placeDoor(d, lb, 1.8, 0.2)).toMatchObject({ label: 1, dir: 'E' }) // 没选中: 点落在 1 号店里
  })

  it('门的场景坐标和法线', () => {
    const m = B.makeBoard({ minX: -3, minY: -2, maxX: 3, maxY: 2 })
    expect(B.doorGeom(m, { i: 1, j: 2, dir: 'S' })).toEqual({ pos: [-2, 0], normal: [0, 1] })
  })
})

describe('编号延续', () => {
  let n = 0
  const opts = { newId: () => 'n' + ++n, info: (c) => ({ cell: 'A01', center: [c.cx, c.cy] }) } // 固定新编号、附带派生字段

  /** 画板 + 记录 → 对号一次，返回结果和 prev（给下一次用） */
  function run(b, records, prev = null) {
    const lb = B.label(b)
    const out = B.reconcile(b, lb, records, prev, opts)
    return { ...out, prev: { labels: lb.labels, owner: out.owner } }
  }

  it('新块变新店，默认零售；再对一次什么都不变', () => {
    n = 0
    const b = draw(['11..', '11..'])
    const r1 = run(b, [])
    expect(r1.shops).toHaveLength(1)
    expect(r1.shops[0]).toMatchObject({ id: 'n1', color: 1, seed: [0, 0], area: 4, category: 'retail', doors: [], cell: 'A01' })
    expect([...r1.changed]).toEqual(['n1'])
    const r2 = run(b, r1.shops, r1.prev)
    expect(r2.changed.size).toBe(0) // 没有改动
    expect(run(b, r1.shops).changed.size).toBe(0) // 没有 prev（刚打开）时靠种子对上号
  })

  it('画大、擦掉种子格: 编号和店名不变，门留在还在边上的', () => {
    n = 0
    const b = draw(['11..', '11..'])
    let r = run(b, [])
    r.shops[0].name = '面馆'
    r.shops[0].doors = [{ i: 2, j: 1, dir: 'E' }, { i: 1, j: 0, dir: 'N' }] // 右边一扇、上边一扇
    b.data[2] = 1; b.data[6] = 1 // 往右扩一列: 右边那扇门被包进店里了
    b.data[0] = 0 // 擦掉种子格
    r = run(b, r.shops, r.prev)
    expect(r.shops).toHaveLength(1)
    expect(r.shops[0]).toMatchObject({ id: 'n1', name: '面馆', area: 5, seed: [1, 0] }) // 种子换到块里的第一格
    expect(r.shops[0].doors).toEqual([{ i: 1, j: 0, dir: 'N', pos: [1, 0], normal: [0, -1] }]) // 右边那扇不在边上了
    expect(r.changed.has('n1')).toBe(true)
  })

  it('切成两半: 大的留编号，小的是新店', () => {
    n = 0
    const b = draw(['11111'])
    let r = run(b, [])
    b.data[1] = 0 // 在第 2 格切开: 1 格 + 3 格
    r = run(b, r.shops, r.prev)
    const live = r.shops.filter((s) => !s.deleted)
    expect(live.map((s) => [s.id, s.area]).sort()).toEqual([['n1', 3], ['n2', 1]])
  })

  it('两家同色的店连起来: 重叠多的留下，另一家变墓碑，它的门并过来', () => {
    n = 0
    const b = draw(['111.11'])
    let r = run(b, [])
    const small = r.shops.find((s) => s.area === 2) // 右边那家
    small.doors = [{ i: 6, j: 0, dir: 'E' }] // 右端朝东的门
    b.data[3] = 1 // 中间补上: 连成一片
    r = run(b, r.shops, r.prev)
    const live = r.shops.filter((s) => !s.deleted), dead = r.shops.filter((s) => s.deleted)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id: 'n1', area: 6 })
    expect(live[0].doors.map((d) => d.dir)).toEqual(['E']) // 被合并那家的门还在边上，接过来
    expect(dead.map((s) => s.id)).toEqual([small.id])
  })

  it('换颜色就是另一家店: 老店删掉，新块新编号', () => {
    n = 0
    const b = draw(['11'])
    let r = run(b, [])
    b.data[0] = b.data[1] = 2 // 整家店换成 2 号色
    r = run(b, r.shops, r.prev)
    expect(r.shops.filter((s) => !s.deleted).map((s) => s.id)).toEqual(['n2'])
    expect(r.shops.find((s) => s.id === 'n1').deleted).toBe(true)
  })

  it('已有的墓碑和旧版（按楼标的、没有种子）的记录原样保留', () => {
    n = 0
    const old = [{ id: 'old', building: 'b1', doors: [] }, { id: 'gone', deleted: true, seed: [0, 0], color: 1 }]
    const r = run(draw(['.']), old)
    expect(r.shops).toEqual(old)
    expect(r.changed.size).toBe(0)
  })
})

describe('记录比较', () => {
  it('键的先后不影响，嵌套对象也排序；undefined 当 null', () => {
    expect(B.canon({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' } })).toBe(B.canon({ a: { c: 'x', d: [1, { x: 1, y: 2 }] }, b: 1 }))
    expect(B.canon({ a: 1 })).not.toBe(B.canon({ a: 2 }))
    expect(B.canon({ a: undefined })).toBe('{"a":null}')
  })
})

describe('自动配色', () => {
  it('挑周围没有的颜色，从上一次的下一个开始轮；全用过时挑最少的', () => {
    const b = draw(['12', '3.'])
    expect(B.freeColor(b, 1, 1, 2)).toBe(4) // 1、2、3 周围都有
    expect(B.freeColor(b, 1, 1, 2, 7)).toBe(8) // 从 8 开始轮
    const full = board(15, 2) // 两行 15 种颜色铺满，第二行只用 1 号 → 其余都只出现一次
    for (let c = 0; c < 15; c++) { full.data[c] = c + 1; full.data[15 + c] = 1 }
    expect(B.freeColor(full, 7, 1, 20)).toBe(2) // 1 号用得最多，其余一样少，取轮到的第一个
  })
})

describe('轮廓', () => {
  it('矩形店: 外轮廓 4 个角，顺时针（y 向下时面积为正）', () => {
    const b = draw(['....', '.11.', '.11.'])
    const { labels, comps } = B.label(b)
    const o = B.outline(b, labels, comps[1])
    expect(o.holes).toEqual([])
    expect(o.outer).toHaveLength(1)
    expect(o.outer[0]).toHaveLength(4) // 共线的中间点去掉了
    expect(B.ringArea(o.outer[0])).toBe(4) // 面积 = 格数
  })

  it('带洞的店（中间一格空）: 一个外轮廓 + 一个洞，面积相减等于格数', () => {
    const b = draw(['111', '1.1', '111'])
    const { labels, comps } = B.label(b)
    const o = B.outline(b, labels, comps[1])
    expect(o.outer).toHaveLength(1)
    expect(o.holes).toHaveLength(1)
    expect(B.ringArea(o.outer[0]) + B.ringArea(o.holes[0])).toBe(8)
  })

  it('L 形: 6 个角', () => {
    const b = draw(['1.', '11'])
    const { labels, comps } = B.label(b)
    const o = B.outline(b, labels, comps[1])
    expect(o.outer[0]).toHaveLength(6)
    expect(B.ringArea(o.outer[0])).toBe(3)
  })
})

describe('分块游程编码', () => {
  it('编码 → 解码还原；尺寸不符 / 坏数据不改画板', () => {
    const b = board(60, 55) // 2 × 2 块，右边和下边的块不满 50
    for (let k = 0; k < 10; k++) b.data[k] = 3 // 第一行前 10 格
    b.data[52 * 60 + 55] = 7 // 右下那块里的一格
    expect(B.tileDims(b)).toEqual({ rows: 2, cols: 2 })
    const a01 = B.encodeTile(b, 0, 0), b02 = B.encodeTile(b, 1, 1)
    expect(a01).toBe('3x10,0x2490')
    expect(b02).toBe('0x25,7x1,0x24') // 这块 10 宽 × 5 高 = 50 格，那一格在块内第 2 行第 5 列
    const c = board(60, 55)
    expect(B.loadTiles(c, { A01: { rle: a01 }, B02: { rle: b02 }, Z99: { rle: '0x1' } })).toBe(2) // 不在画板上的块跳过
    expect([...c.data]).toEqual([...b.data])
    expect(B.decodeTile(c, 0, 0, '0x5')).toBe(false) // 长度不对
    expect(B.decodeTile(c, 0, 0, '99x2500')).toBe(false) // 颜色号越界
    expect(c.data[0]).toBe(3) // 画板没被改
  })

  it('块编号和行列互换、格子属于哪块', () => {
    expect(B.parseTileId('B03')).toEqual([1, 2])
    expect(B.parseTileId('AA10')).toEqual([26, 9])
    expect(B.parseTileId('x')).toBeNull()
    const b = board(120, 60)
    expect(B.tileOfIndex(b, 55 * 120 + 101)).toBe('B03')
    expect(B.tilesOfCells(b, [0, 1, 60]).sort()).toEqual(['A01', 'A02'])
  })
})
