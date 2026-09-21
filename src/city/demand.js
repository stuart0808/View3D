// 需求模型: 「谁、什么时候、想去哪、待多久」。全部由仿真时钟和日历驱动。
//
// 不给每个人排一整天的固定行程，而是一个随时间变化的活动选择模型:
//   · 每类人群有一条「此刻有多少人在核心区活动」的出现曲线（工作日 / 休息日不同）→ 决定进场的人数和人群构成
//   · 一个人每结束一段停留，就按「所属人群 × 当前时段」的活动偏好选下一站: 办公 / 逛店 / 公园 / 广场 / 看演出 / 离开
//   · 场馆活动由日历排期: 进场时段「看演出」的权重暴涨、应有人数上调；观众待到散场，散场后大多直接离开
// 真实项目里，这些曲线和偏好就是后端测算结果要填的地方。

export const GROUPS = [
  { id: 'worker', label: '上班族', share: 0.5, colors: ['#2f3f5c', '#3b4a63', '#54607a', '#1f2937', '#6b7a94'] },
  { id: 'elderly', label: '老年人', share: 0.15, colors: ['#b79d78', '#c4ad8c', '#9c8a70', '#d2c2a8'] },
  { id: 'youth', label: '青年', share: 0.25, colors: ['#e0705c', '#f0a23c', '#3aa6a0', '#f4f1ea', '#d94f7a'] },
  { id: 'visitor', label: '访客', share: 0.1, colors: ['#f5f5f4', '#e7e5e4', '#9db4d6', '#c9d6c0'] },
]

// 出现曲线: [小时, 0~1]，相对本人群规模的在场比例。rest = 周末和节假日
const PRESENCE = {
  worker: {
    workday: [[0, 0.02], [6.5, 0.05], [8, 0.7], [9.5, 1], [17.5, 1], [19, 0.55], [21, 0.25], [23, 0.05], [24, 0.02]],
    rest: [[0, 0.02], [9, 0.08], [12, 0.35], [16, 0.42], [20, 0.35], [23, 0.05], [24, 0.02]],
  },
  elderly: {
    workday: [[0, 0], [5.5, 0.05], [6.5, 0.45], [8, 0.9], [10.5, 1], [12, 0.35], [14.5, 0.5], [16, 0.85], [18, 0.6], [19.5, 0.55], [21, 0.08], [24, 0]],
    rest: [[0, 0], [5.5, 0.05], [6.5, 0.45], [8, 0.85], [10.5, 0.9], [12, 0.35], [15, 0.7], [18, 0.5], [19.5, 0.5], [21, 0.08], [24, 0]],
  },
  youth: {
    workday: [[0, 0.06], [3, 0.01], [9, 0.1], [12, 0.4], [15, 0.45], [18, 0.8], [20.5, 1], [22.5, 0.6], [24, 0.15]],
    rest: [[0, 0.12], [3, 0.02], [10, 0.3], [13, 0.8], [16, 1], [21, 1], [23, 0.5], [24, 0.15]],
  },
  visitor: {
    workday: [[0, 0], [9, 0.2], [11, 0.5], [15, 0.6], [19, 0.4], [22, 0.05], [24, 0]],
    rest: [[0, 0], [9, 0.45], [11, 1], [16, 1], [20, 0.7], [22.5, 0.1], [24, 0]],
  },
}
const REST_SCALE = { worker: 1, elderly: 1, youth: 1.15, visitor: 1.6 } // 休息日: 访客和青年的规模更大

// 活动偏好: 时段 → { 类别: 权重 }。类别: office / shop / park / plaza / venue / leave
const PERIODS = [[0, 'night'], [6, 'morning'], [11.5, 'noon'], [13.5, 'afternoon'], [17.5, 'evening'], [22, 'night']]
const MIX = {
  worker: {
    workday: {
      morning: { office: 9, shop: 0.5, leave: 0.2 }, noon: { shop: 6, plaza: 2, park: 1, office: 2 }, afternoon: { office: 9, shop: 0.5, leave: 0.3 },
      evening: { leave: 6, shop: 3, plaza: 1 }, night: { leave: 9, shop: 1 },
    },
    rest: { all: { shop: 5, park: 2, plaza: 2, leave: 2 } },
  },
  elderly: {
    all: {
      morning: { park: 6, plaza: 3, shop: 2, leave: 1 }, noon: { leave: 6, shop: 2 }, afternoon: { park: 5, plaza: 3, shop: 2, leave: 2 },
      evening: { plaza: 5, park: 1, leave: 4 }, night: { leave: 10 },
    },
  },
  youth: {
    all: {
      morning: { shop: 2, park: 1, leave: 1 }, noon: { shop: 5, plaza: 2, leave: 1 }, afternoon: { shop: 5, plaza: 2, park: 1, leave: 1.5 },
      evening: { shop: 5, plaza: 3, park: 1, leave: 1.5 }, night: { shop: 3, leave: 4 },
    },
  },
  visitor: { all: { all: { shop: 4, park: 3, plaza: 3, leave: 1.5 } } },
}

// 场馆排期规则: 每天每个时段办一场的概率、时长、上座率。type 对应 sidecar 里 venue.type
const EVENT_RULES = {
  stadium: { slots: [{ h: 19.5, workday: 0.3, rest: 0.75, dur: 2, title: '足球赛' }, { h: 15, workday: 0, rest: 0.5, dur: 2, title: '联赛下午场' }], fill: [0.55, 0.95] },
  opera: { slots: [{ h: 19.5, workday: 0.55, rest: 0.85, dur: 2.5, title: '晚场演出' }, { h: 14.5, workday: 0, rest: 0.6, dur: 2, title: '日场演出' }], fill: [0.6, 1] },
  default: { slots: [{ h: 19, workday: 0.3, rest: 0.6, dur: 2, title: '活动' }], fill: [0.4, 0.9] },
}
const INGRESS_MIN = 75, EGRESS_MIN = 35

function lerpCurve(pts, h) {
  for (let i = 1; i < pts.length; i++) {
    if (h <= pts[i][0]) { const [h0, v0] = pts[i - 1], [h1, v1] = pts[i]; return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0 || 1) }
  }
  return pts[pts.length - 1][1]
}

/** 确定性的伪随机: 同一天、同一个场馆、同一个时段，每次算出来都一样（跳回同一天看到的还是同一场活动） */
function hash01(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 100000) / 100000
}

export class Demand {
  /**
   * @param venues [{ id(建筑id), name, type, capacity }]
   * @param eventScale 观众人数的缩放: 真实场馆动辄上万人，逐人仿真撑不住，按比例缩小（默认 0.15）
   */
  constructor(clock, venues = [], { eventScale = 0.15 } = {}) {
    this.clock = clock
    this.venues = venues
    this.eventScale = eventScale
    this.events = []
    this.#schedule()
    clock.on((ev) => ev === 'day' && this.#schedule())
  }

  get rest() { return this.clock.dayType !== 'workday' }

  /** 排今天和明天的场次 */
  #schedule() {
    this.events = []
    const d0 = this.clock.date
    for (let k = 0; k < 2; k++) {
      const day = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + k)
      const rest = this.clock.dayTypeOf(day) !== 'workday'
      const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`
      for (const v of this.venues) {
        const rule = EVENT_RULES[v.type] || EVENT_RULES.default
        rule.slots.forEach((slot, si) => {
          if (hash01(`${key}|${v.id}|${si}`) >= (rest ? slot.rest : slot.workday)) return
          const start = day.getTime() + slot.h * 3600000
          const fill = rule.fill[0] + (rule.fill[1] - rule.fill[0]) * hash01(`${key}|${v.id}|${si}|fill`)
          this.events.push({ venue: v.id, venueName: v.name, title: slot.title, start, end: start + slot.dur * 3600000, attendance: Math.round(v.capacity * fill * this.eventScale), realAttendance: Math.round(v.capacity * fill) })
        })
      }
    }
    this.events.sort((a, b) => a.start - b.start)
  }

  /** 某个场馆此刻的活动阶段: null | { ev, phase: 'ingress'|'live'|'egress', progress } */
  phaseOf(venueId, t = this.clock.t) {
    for (const ev of this.events) {
      if (ev.venue !== venueId) continue
      if (t >= ev.start - INGRESS_MIN * 60000 && t < ev.start + 10 * 60000) return { ev, phase: 'ingress', progress: (t - (ev.start - INGRESS_MIN * 60000)) / ((INGRESS_MIN + 10) * 60000) }
      if (t >= ev.start && t < ev.end) return { ev, phase: 'live', progress: 1 }
      if (t >= ev.end && t < ev.end + EGRESS_MIN * 60000) return { ev, phase: 'egress', progress: 1 - (t - ev.end) / (EGRESS_MIN * 60000) }
    }
    return null
  }

  /** 各人群此刻应有的在场人数（不含活动观众），base = 高峰人数 */
  targets(base) {
    const key = this.rest ? 'rest' : 'workday', h = this.clock.hour
    return GROUPS.map((g) => Math.round(base * g.share * (this.rest ? REST_SCALE[g.id] : 1) * (this.clock.dayType === 'holiday' && g.id === 'visitor' ? 1.25 : 1) * lerpCurve(PRESENCE[g.id][key], h)))
  }

  /** 活动带来的额外应有人数: 进场时段逐渐增加，活动期间 = 观众数，散场后逐渐归零 */
  eventExtra() {
    let n = 0
    for (const v of this.venues) { const p = this.phaseOf(v.id); if (p) n += p.ev.attendance * Math.min(1, p.progress) }
    return Math.round(n)
  }

  /** 第 gi 类人群此刻的活动偏好 { 类别: 权重 } */
  mix(gi) {
    const m = MIX[GROUPS[gi].id]
    const day = m[this.rest ? 'rest' : 'workday'] || m.all
    if (day.all) return day.all
    let period = 'night'
    for (const [from, name] of PERIODS) if (this.clock.hour >= from) period = name
    return day[period]
  }

  /** 进办公楼后待多久（秒）: 上午待到午饭点，下午待到下班点，各带一点随机 */
  officeStay(rand) {
    const h = this.clock.hour
    const until = h < 11.3 ? 12 + (rand() - 0.5) * 0.6 : h < 17 ? 18 + (rand() - 0.3) * 1.4 : h + 0.5 + rand() * 1.5
    return Math.max(600, (until - h) * 3600)
  }

  /** 给界面用: 正在进行和接下来的场次 */
  upcoming(n = 3) {
    const t = this.clock.t
    return this.events.filter((ev) => ev.end + EGRESS_MIN * 60000 > t).slice(0, n).map((ev) => {
      const p = this.phaseOf(ev.venue)
      const d = new Date(ev.start), pad = (x) => String(x).padStart(2, '0')
      return { ...ev, time: `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`, phase: p && p.ev === ev ? p.phase : 'scheduled' }
    })
  }

  /** 下一场活动进场开始的时刻（毫秒时间戳），没有则 null */
  nextIngress() {
    const t = this.clock.t
    const ev = this.events.find((e) => e.start - INGRESS_MIN * 60000 > t)
    return ev ? ev.start - 60 * 60000 : null
  }
}
