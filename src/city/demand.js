// 需求模型: 「谁、什么时候、想去哪、待多久」。全部由仿真时钟和日历驱动。
//
// 不给每个人排一整天的固定行程，而是一个随时间变化的活动选择模型:
//   · 每类人群有一条「此刻有多少人在核心区活动」的出现曲线（工作日 / 休息日不同）→ 决定进场的人数和人群构成
//   · 一个人每结束一段停留，就按「所属人群 × 当前时段」的活动偏好选下一站: 办公 / 逛店 / 公园 / 广场 / 看演出 / 离开
//   · 场馆活动由日历排期: 进场时段「看演出」的权重暴涨、应有人数上调；观众待到散场，散场后大多直接离开
// 真实项目里，这些曲线和偏好就是后端测算结果要填的地方。

/**
 * 四类人群。share 是高峰期各类占总人数的份额；colors 是小人的配色（远看能一眼分出谁是谁）:
 * 上班族深蓝灰、老年人米色、青年亮色、访客浅色。
 */
export const GROUPS = [
  { id: 'worker', label: '上班族', share: 0.5, colors: ['#2f3f5c', '#3b4a63', '#54607a', '#1f2937', '#6b7a94'] },
  { id: 'elderly', label: '老年人', share: 0.15, colors: ['#b79d78', '#c4ad8c', '#9c8a70', '#d2c2a8'] },
  { id: 'youth', label: '青年', share: 0.25, colors: ['#e0705c', '#f0a23c', '#3aa6a0', '#f4f1ea', '#d94f7a'] },
  { id: 'visitor', label: '访客', share: 0.1, colors: ['#f5f5f4', '#e7e5e4', '#9db4d6', '#c9d6c0'] },
]

// 出现曲线: [小时, 0~1]，相对本人群规模的在场比例。rest = 周末和节假日。
// 形状是经验值: 上班族工作日 9:30~17:30 满员、休息日很少来核心区；老年人早晚两波（晨练、饭后遛弯）、
// 午休回家；青年下午到晚上为主、休息日更多；访客白天来、休息日翻倍。接真实数据时替换这些数组。
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
// 休息日各人群的规模倍率: 访客和青年更多，上班族和老年人规模不变（只是曲线不同）
const REST_SCALE = { worker: 1, elderly: 1, youth: 1.15, visitor: 1.6 }

// 活动偏好: 时段 → { 类别: 权重 }。类别: office / shop / park / plaza / venue / leave。
// 权重只有相对意义: 一个人结束一段停留后，按当前时段的权重抽下一站的类别，再在该类里按吸引力和距离抽具体地点。
// 'venue' 不写在表里，进场时段由 crowd.js 按「还差多少观众」动态加上。
// 结构: MIX[人群][workday|rest|all][时段|all]，'all' 表示不分
const PERIODS = [[0, 'night'], [6, 'morning'], [11.5, 'noon'], [13.5, 'afternoon'], [17.5, 'evening'], [22, 'night']] // [起始小时, 时段名]，升序
const MIX = {
  worker: { // 上班族: 工作日上下午几乎都在办公，午休出来吃饭逛店，傍晚下班离开；休息日像普通逛街的人
    workday: {
      morning: { office: 9, shop: 0.5, leave: 0.2 }, noon: { shop: 6, plaza: 2, park: 1, office: 2 }, afternoon: { office: 9, shop: 0.5, leave: 0.3 },
      evening: { leave: 6, shop: 3, plaza: 1 }, night: { leave: 9, shop: 1 },
    },
    rest: { all: { shop: 5, park: 2, plaza: 2, leave: 2 } },
  },
  elderly: { // 老年人: 不分工作日；早上公园，中午回家，下午公园广场，晚上广场（跳舞），深夜不出门
    all: {
      morning: { park: 6, plaza: 3, shop: 2, leave: 1 }, noon: { leave: 6, shop: 2 }, afternoon: { park: 5, plaza: 3, shop: 2, leave: 2 },
      evening: { plaza: 5, park: 1, leave: 4 }, night: { leave: 10 },
    },
  },
  youth: { // 青年: 逛店为主，晚上也在
    all: {
      morning: { shop: 2, park: 1, leave: 1 }, noon: { shop: 5, plaza: 2, leave: 1 }, afternoon: { shop: 5, plaza: 2, park: 1, leave: 1.5 },
      evening: { shop: 5, plaza: 3, park: 1, leave: 1.5 }, night: { shop: 3, leave: 4 },
    },
  },
  visitor: { all: { all: { shop: 4, park: 3, plaza: 3, leave: 1.5 } } }, // 访客: 逛店看景，不分时段
}

// 场馆排期规则: 每天每个时段办一场的概率（workday / rest 分开）、时长（小时）、上座率区间。
// type 对应 sidecar 里 venue.type；没匹配上的用 default。是否办、办多满由日期哈希决定（见 hash01），
// 所以同一天怎么跳回来看到的都是同一场。
const EVENT_RULES = {
  stadium: { slots: [{ h: 19.5, workday: 0.3, rest: 0.75, dur: 2, title: '足球赛' }, { h: 15, workday: 0, rest: 0.5, dur: 2, title: '联赛下午场' }], fill: [0.55, 0.95] }, // 体育场: 晚场为主，休息日才有下午场
  opera: { slots: [{ h: 19.5, workday: 0.55, rest: 0.85, dur: 2.5, title: '晚场演出' }, { h: 14.5, workday: 0, rest: 0.6, dur: 2, title: '日场演出' }], fill: [0.6, 1] }, // 剧院: 场次更密，上座率更高
  default: { slots: [{ h: 19, workday: 0.3, rest: 0.6, dur: 2, title: '活动' }], fill: [0.4, 0.9] },
}
const INGRESS_MIN = 75, EGRESS_MIN = 35 // 开场前 75 分钟开始进场，散场后 35 分钟走完

// 住户出行。三条曲线都是 [小时, 值]:
//   HOME_DEPART  每小时离家的比例（相对此刻在家的人）—— 工作日早高峰集中出门，休息日晚且分散
//   HOME_RETURN  每小时回来的比例（相对此刻在核心区之外的住户）—— 傍晚集中回来，深夜全部到家
//   HOME_FRACTION 开场 / 跳时间铺场用: 此刻应该有多大比例的住户在家
const HOME_DEPART = {
  workday: [[0, 0], [5.5, 0.02], [6.5, 0.3], [7.5, 0.9], [8.5, 0.7], [9.5, 0.25], [11, 0.12], [17, 0.1], [19, 0.12], [21, 0.03], [23, 0], [24, 0]],
  rest: [[0, 0], [6, 0.02], [8, 0.15], [10, 0.4], [12, 0.25], [15, 0.3], [18, 0.25], [20, 0.1], [22, 0.02], [24, 0]],
}
const HOME_RETURN = {
  workday: [[0, 1], [4, 1], [5, 0.02], [11, 0.03], [12, 0.1], [16, 0.15], [17.5, 0.6], [19, 0.9], [21, 1], [24, 1]],
  rest: [[0, 1], [4, 1], [6, 0.05], [11, 0.12], [14, 0.25], [17, 0.5], [20, 0.9], [22, 1], [24, 1]],
}
const HOME_FRACTION = {
  workday: [[0, 1], [6, 0.97], [8, 0.55], [9.5, 0.3], [12, 0.35], [17, 0.35], [19, 0.6], [21, 0.85], [23, 0.97], [24, 1]],
  rest: [[0, 1], [7, 0.95], [10, 0.65], [14, 0.5], [18, 0.55], [21, 0.8], [23, 0.95], [24, 1]],
}

/** 在 [小时, 值] 节点之间线性插值；超出最后一个节点取末值 */
function lerpCurve(pts, h) {
  for (let i = 1; i < pts.length; i++) { // 找到第一个 ≥ h 的节点，在它和前一个之间插值
    if (h <= pts[i][0]) { const [h0, v0] = pts[i - 1], [h1, v1] = pts[i]; return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0 || 1) }
  }
  return pts[pts.length - 1][1]
}

/** 确定性的伪随机: 同一天、同一个场馆、同一个时段，每次算出来都一样（跳回同一天看到的还是同一场活动） */
function hash01(str) {
  let h = 2166136261 // FNV-1a 32 位
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 100000) / 100000 // 取 5 位小数的 [0,1)
}

export class Demand {
  /**
   * @param venues [{ id(建筑id), name, type, capacity }]
   * @param eventScale 观众人数的缩放: 真实场馆动辄上万人，逐人仿真撑不住，按比例缩小（默认 0.15）
   */
  constructor(clock, venues = [], { eventScale = 0.15, residentScale = 0.1 } = {}) {
    this.clock = clock
    this.residentScale = residentScale // 住户人数的缩放: 一栋 1 万㎡的住宅楼真实住两百多人，按比例缩小
    this.venues = venues
    this.eventScale = eventScale
    this.events = [] // 今明两天的场次，按开始时间排序
    this.#schedule()
    clock.on((ev) => ev === 'day' && this.#schedule()) // 换日重排
  }

  /** 休息日（周末或节假日）: 作息和活动偏好都换成 rest 那套 */
  get rest() { return this.clock.dayType !== 'workday' }

  /** 排今天和明天的场次（换日事件时重排，所以「明天」永远有排期，跨夜的散场也不会丢） */
  #schedule() {
    this.events = []
    const d0 = this.clock.date
    for (let k = 0; k < 2; k++) {
      const day = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + k) // 今天 / 明天的零点
      const rest = this.clock.dayTypeOf(day) !== 'workday' // 那一天是不是休息日（决定用哪个概率）
      const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}` // 日期字符串，哈希的种子
      for (const v of this.venues) {
        const rule = EVENT_RULES[v.type] || EVENT_RULES.default
        rule.slots.forEach((slot, si) => {
          if (hash01(`${key}|${v.id}|${si}`) >= (rest ? slot.rest : slot.workday)) return // 按概率决定这一场办不办
          const start = day.getTime() + slot.h * 3600000 // 开场时刻（毫秒）
          const fill = rule.fill[0] + (rule.fill[1] - rule.fill[0]) * hash01(`${key}|${v.id}|${si}|fill`) // 上座率，另一个哈希
          this.events.push({ venue: v.id, venueName: v.name, title: slot.title, start, end: start + slot.dur * 3600000, attendance: Math.round(v.capacity * fill * this.eventScale), realAttendance: Math.round(v.capacity * fill) })
        })
      }
    }
    this.events.sort((a, b) => a.start - b.start)
  }

  /**
   * 某个场馆此刻的活动阶段: null | { ev, phase: 'ingress'|'live'|'egress', progress }。
   * ingress 的 progress 从 0 涨到 1（观众陆续到场），egress 的 progress 从 1 降到 0（陆续离开），live 恒为 1。
   * 开场后 10 分钟内仍算 ingress（迟到的人）。
   */
  phaseOf(venueId, t = this.clock.t) {
    for (const ev of this.events) { // 按开始时间排序，第一个命中的就是当前场
      if (ev.venue !== venueId) continue
      if (t >= ev.start - INGRESS_MIN * 60000 && t < ev.start + 10 * 60000) return { ev, phase: 'ingress', progress: (t - (ev.start - INGRESS_MIN * 60000)) / ((INGRESS_MIN + 10) * 60000) }
      if (t >= ev.start && t < ev.end) return { ev, phase: 'live', progress: 1 }
      if (t >= ev.end && t < ev.end + EGRESS_MIN * 60000) return { ev, phase: 'egress', progress: 1 - (t - ev.end) / (EGRESS_MIN * 60000) }
    }
    return null
  }

  /**
   * 各人群此刻应有的在场人数（不含活动观众），base = 界面上的「高峰人数」。
   * = base × 份额 × 休息日倍率 × 节假日访客加成 × 出现曲线。返回数组顺序与 GROUPS 一致
   */
  targets(base) {
    const key = this.rest ? 'rest' : 'workday', h = this.clock.hour
    // 节假日（不只是周末）访客再加 25%
    return GROUPS.map((g) => Math.round(base * g.share * (this.rest ? REST_SCALE[g.id] : 1) * (this.clock.dayType === 'holiday' && g.id === 'visitor' ? 1.25 : 1) * lerpCurve(PRESENCE[g.id][key], h)))
  }

  /** 活动带来的额外应有人数: 进场时段逐渐增加，活动期间 = 观众数，散场后逐渐归零 */
  eventExtra() {
    let n = 0
    for (const v of this.venues) { const p = this.phaseOf(v.id); if (p) n += p.ev.attendance * Math.min(1, p.progress) } // 各场馆叠加；progress 在 ingress 里可能略超 1，夹住
    return Math.round(n)
  }

  /** 第 gi 类人群此刻的活动偏好 { 类别: 权重 }。先按 workday/rest 取表，再按时段取行；'all' 表示不分 */
  mix(gi) {
    const m = MIX[GROUPS[gi].id]
    const day = m[this.rest ? 'rest' : 'workday'] || m.all // 没有分工作日 / 休息日的用 all
    if (day.all) return day.all // 不分时段
    let period = 'night' // PERIODS 从 0 点开始，所以总能命中
    for (const [from, name] of PERIODS) if (this.clock.hour >= from) period = name
    return day[period]
  }

  /** 进办公楼后待多久（秒）: 上午待到午饭点，下午待到下班点，各带一点随机 */
  officeStay(rand) {
    const h = this.clock.hour
    const until = h < 11.3 ? 12 + (rand() - 0.5) * 0.6 : h < 17 ? 18 + (rand() - 0.3) * 1.4 : h + 0.5 + rand() * 1.5 // 待到几点: 11:42~12:18 / 17:35~19:00 / 再待 0.5~2h
    return Math.max(600, (until - h) * 3600) // 至少 10 分钟
  }

  // ---- 住户 ----
  // 住宅楼里的人不走「出现曲线」，而是按离家率 / 回家率逐个出门、回来（crowd.js 里记账，三态守恒）
  /** 一栋住宅楼里参与仿真的住户数: 建筑面积 / 45㎡ 每人，再乘缩放 */
  residentsOf(area, floors) { return Math.max(4, Math.round(((area * floors) / 45) * this.residentScale)) }
  get #dayKey() { return this.rest ? 'rest' : 'workday' }
  /** 此刻每小时离家的比例（相对在家的人） */
  homeDepartRate() { return lerpCurve(HOME_DEPART[this.#dayKey], this.clock.hour) }
  /** 此刻每小时回家的比例（相对在外的人） */
  homeReturnRate() { return lerpCurve(HOME_RETURN[this.#dayKey], this.clock.hour) }
  /** 此刻应有多大比例的住户在家（铺场用） */
  homeFraction() { return lerpCurve(HOME_FRACTION[this.#dayKey], this.clock.hour) }

  /** 这会儿出门的住户是哪类人: 工作日早上主要是上班族，其余时间老人和年轻人多 */
  residentGroup(rand) {
    const r = rand(), commuteHours = !this.rest && this.clock.hour < 9.5 // 工作日 9:30 前是通勤时段
    return commuteHours ? (r < 0.7 ? 0 : r < 0.9 ? 1 : 2) : r < 0.25 ? 0 : r < 0.65 ? 1 : 2 // 通勤: 上班族 70% / 老人 20% / 青年 10%；其他时候 25 / 40 / 35
  }

  /** 出门后直接离开核心区（去别处上班 / 办事）的概率；否则就在核心区里活动 */
  commuteOutProb(gi) { return !this.rest && this.clock.hour < 10 && gi === 0 ? 0.8 : 0.15 }

  /** 给界面用: 正在进行和接下来的场次 */
  upcoming(n = 3) {
    const t = this.clock.t
    return this.events.filter((ev) => ev.end + EGRESS_MIN * 60000 > t).slice(0, n).map((ev) => { // 散场还没走完的也算
      const p = this.phaseOf(ev.venue)
      const d = new Date(ev.start), pad = (x) => String(x).padStart(2, '0')
      return { ...ev, time: `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`, phase: p && p.ev === ev ? p.phase : 'scheduled' }
    })
  }

  /** 下一场活动进场开始的时刻（毫秒时间戳），没有则 null */
  nextIngress() {
    const t = this.clock.t
    const ev = this.events.find((e) => e.start - INGRESS_MIN * 60000 > t) // 第一个还没开始进场的
    return ev ? ev.start - 60 * 60000 : null // 跳到开场前 1 小时（进场已经开始 15 分钟）
  }
}
