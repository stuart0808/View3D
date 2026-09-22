// 道路的公共规则。地面标线（ground.js）和车流（traffic.js）都从这里取，保证车走在线里。

export const ELEVATED_H = 6.5 // 高架桥面标高（米）
export const RAIL_H = 11 // 铁路高架的轨面标高，比公路高架高一层，可以从它上面跨过去

/**
 * 路宽 → 车道划分。offsets[k] = 第 k 条车道中心在「行驶方向右侧」离道路中心线多远。
 *   普通双向路: 单向 n = floor(半幅宽 / 3.3) 条（1~4），从中心线往外排
 *   桥下的路 (median > 0): 桥面正下方 median 米宽是桥墩和隔离带，不走车，车道从桥面投影外侧开始排
 *   单行路（环岛）: 整幅都是同向车道
 */
export function laneLayout(width, oneway = false, median = 0) {
  if (oneway) {
    const n = Math.max(1, Math.min(2, Math.floor(width / 3.5))) // 环道最多两圈车道，再多内圈弧段太短
    const laneW = width / n
    return { n, laneW, inner: 0, offsets: Array.from({ length: n }, (_, k) => -width / 2 + (k + 0.5) * laneW) }
  }
  const inner = median > 0 ? median + 0.4 : 0
  const n = Math.max(1, Math.min(4, Math.floor((width / 2 - inner) / 3.3)))
  const laneW = (width / 2 - inner) / n
  return { n, laneW, inner, offsets: Array.from({ length: n }, (_, k) => inner + (k + 0.5) * laneW) }
}

/** 单向 ≥3 车道的主干路/环路中间做实体中央隔离带，其余画黄线（桥下的路另有一整条桥下隔离带） */
export function hasMedian(width, oneway = false) {
  return !oneway && laneLayout(width).n >= 3
}
