// 室内视图的测试: 商场（店铺、走廊、人数跟随实时数据）和地下车库（车位、坡道、占用率 → 显示的车数）。
import { describe, it, expect } from 'vitest'
import { Interior } from '../src/city/interior.js'
import { makeRandom, pointInPolygon } from '../src/city/geometry.js'

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
const mall = { id: 'M', polygon: rect(0, 0, 80, 50), holes: [] }
const make = (b, kind, extra = {}) => new Interior(b, kind, { rand: makeRandom(1), ...extra })

describe('商场', () => {
  it('沿外墙排店铺，走廊是轮廓内缩的环；店铺中心都在楼内', () => {
    const v = make(mall, 'mall')
    expect(v.group.name).toBe('interior:M:mall')
    expect(v.shopSpots.length).toBeGreaterThan(10)
    for (const [cx, cy] of v.shopSpots) expect(pointInPolygon(cx, cy, mall.polygon)).toBe(true)
    expect(v.loop).toBeTruthy()
    expect(v.loopCum.length).toBe(v.loop.length + 1)
    expect(v.shopDepth).toBeGreaterThanOrEqual(3.5)
    expect(v.shopDepth).toBeLessThanOrEqual(10)
  })

  it('人数跟着 live 走（最少 8，最多 capacity），减少时砍掉末尾', () => {
    const v = make(mall, 'mall')
    v.update(0.5, 0)
    expect(v.people.count).toBe(8)
    v.update(0.5, 60)
    expect(v.people.count).toBe(60)
    v.update(0.5, 20)
    expect(v.people.count).toBe(20)
    v.update(0.5, 10000)
    expect(v.people.count).toBe(v.capacity)
  })

  it('走动的人沿走廊推进，位置始终在楼内；站着的人不动', () => {
    const v = make(mall, 'mall')
    v.update(0.5, 100)
    const arr = v.people.instanceMatrix.array
    const posOf = (i) => [arr[i * 16 + 12], arr[i * 16 + 14]]
    const before = v.agents.map((_, i) => posOf(i))
    for (let k = 0; k < 20; k++) v.update(0.5, 100)
    let moved = 0
    v.agents.forEach((a, i) => {
      const [x, y] = posOf(i)
      expect(pointInPolygon(x, y, mall.polygon)).toBe(true)
      if (a.still) expect(x).toBeCloseTo(before[i][0])
      else if (Math.hypot(x - before[i][0], y - before[i][1]) > 1) moved++
    })
    expect(moved).toBeGreaterThan(0)
  })

  it('窄楼缩不出走廊: loop 为 null，人全部站着', () => {
    const v = make({ id: 'N', polygon: rect(0, 0, 40, 9), holes: [] }, 'mall')
    expect(v.loop).toBeNull()
    v.update(0.5, 30)
    expect(v.agents.every((a) => a.still)).toBe(true)
  })
})

describe('地下车库', () => {
  const garage = { entry: [80, 25], normal: [1, 0], capacity: 100, occupied: 0 }

  it('车位布局按出入口排，坡道从出入口下来；显示的车数 = 占用率 × 车位数', () => {
    const v = make(mall, 'garage', { garage })
    expect(v.stalls.length).toBeGreaterThan(20)
    expect(v.cars.count).toBe(0)
    v.update(0.5, { occupied: 50, capacity: 100 })
    expect(v.cars.count).toBe(Math.round(v.stalls.length / 2))
    v.update(0.5, { occupied: 100, capacity: 100 })
    expect(v.cars.count).toBe(v.stalls.length)
    v.update(0.5, { occupied: 999, capacity: 100 })
    expect(v.cars.count).toBe(v.stalls.length) // 不超过车位数
  })

  it('没有出入口信息也能建（无坡道）；dispose 后不抛错', () => {
    const v = make(mall, 'garage')
    expect(v.stalls.length).toBeGreaterThan(0)
    expect(() => v.dispose()).not.toThrow()
  })
})
