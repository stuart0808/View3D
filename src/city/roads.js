// 道路的公共规则。地面标线（ground.js）和车流（traffic.js）都从这里取，保证车走在线里。

export const ELEVATED_H = 7.5 // 高架桥面标高（米）

/**
 * 路宽 → 车道划分。
 *   双向路: 单向 n = floor(半幅宽 / 3.3) 条（1~4），第 k 条车道中心在中心线右侧 (k+0.5)*laneW 处
 *   单行路（环岛）: 整幅都是同向车道
 */
export function laneLayout(width, oneway = false) {
  if (oneway) {
    const n = Math.max(1, Math.min(2, Math.floor(width / 3.5))) // 环道最多两圈车道，再多内圈弧段太短
    const laneW = width / n
    return { n, laneW, offsets: Array.from({ length: n }, (_, k) => -width / 2 + (k + 0.5) * laneW) }
  }
  const n = Math.max(1, Math.min(4, Math.floor(width / 2 / 3.3)))
  const laneW = width / 2 / n
  return { n, laneW, offsets: Array.from({ length: n }, (_, k) => (k + 0.5) * laneW) }
}

/** 单向 ≥3 车道的主干路/环路中间做实体中央隔离带，其余画黄线 */
export function hasMedian(width, oneway = false) {
  return !oneway && laneLayout(width).n >= 3
}
