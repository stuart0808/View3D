// 仿真时钟 + 日历。整个城市里所有「随时间变化」的东西（人群作息、场馆活动、地铁/铁路时刻表、车流强度、昼夜光照）
// 都只读这一个时钟，保证彼此对得上。
//
// 全城只有这一种时间。rate = 仿真速度（每现实秒过多少仿真秒）: 人走路、车行驶、红绿灯、店里停留、发车间隔，
// 全都按同一个 rate 推进 —— 调到 60 倍，小人就真的以 60 倍速走路，而不是「日程走得快、动作照旧」再靠别的手段把人凑齐。
// 引擎每帧把这一帧的仿真时长切成若干小步去推进物理，所以倍速高了也稳定；倍速高到一帧算不完时，时钟会自动慢下来等物理。

const DAY_MS = 86400000 // 一天的毫秒数，跳日期时用

/** 法定节假日与调休上班日。国务院每年发布通知，调休每年不同 —— 这里只放了肯定放假的日子，实际使用请按当年通知补全 */
export const DEFAULT_HOLIDAYS = [
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  '2027-01-01', '2027-05-01', '2027-10-01', '2027-10-02', '2027-10-03',
]
export const DEFAULT_MAKEUP_WORKDAYS = [] // 调休: 本是周末但要上班的日子，如 '2026-10-10'

// 三种日子。人群作息按 workday / 其余 区分；交通时刻表只分 workday / holiday（周末按节假日跑）
export const DAY_TYPE_LABEL = { workday: '工作日', weekend: '周末', holiday: '节假日' }
const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad = (n) => String(n).padStart(2, '0')
// 日期 → 'YYYY-MM-DD'，节假日表用这个格式做键（本地时间，不走 toISOString 免得时区把日期错一天）
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export class SimClock {
  /**
   * @param start  起始时刻（本地时间）
   * @param rate   仿真速度: 每现实秒过多少仿真秒。1 = 实时，60 = 一秒一分钟
   */
  constructor({ start = '2026-09-21T07:30:00', rate = 10, holidays = DEFAULT_HOLIDAYS, makeupWorkdays = DEFAULT_MAKEUP_WORKDAYS } = {}) {
    this.t = new Date(start).getTime() // 当前仿真时刻（毫秒时间戳，本地时间）
    this.rate = rate
    this.paused = false // 暂停时 tick 返回 0，所有仿真都停
    this.holidays = new Set(holidays)
    this.makeupWorkdays = new Set(makeupWorkdays)
    this.listeners = new Set() // (event, clock) => void；event: 'minute' | 'hour' | 'day' | 'jump'
    this._lastMinute = Math.floor(this.t / 60000) // 上一次发过 minute 事件的分钟号，用来检测跨分钟
  }

  /**
   * 推进一帧。realDt 是现实秒，乘 rate 得到仿真秒。跨分钟时发 'minute'，同时跨了小时 / 日期就再发 'hour' / 'day'。
   * 一帧跨了好几分钟（高倍速）也只发一次 minute —— 监听者都是「刷新一下状态」，不需要每分钟一次。
   * @returns 这一帧过了多少仿真秒
   */
  tick(realDt) {
    if (this.paused) return 0
    const simDt = realDt * this.rate // 仿真秒
    this.t += simDt * 1000 // 毫秒
    const m = Math.floor(this.t / 60000) // 当前分钟号
    if (m !== this._lastMinute) {
      const prev = new Date(this._lastMinute * 60000), cur = this.date
      this._lastMinute = m
      this.#emit('minute')
      if (cur.getHours() !== prev.getHours()) this.#emit('hour')
      if (cur.getDate() !== prev.getDate()) this.#emit('day')
    }
    return simDt
  }

  /** 通知所有监听者 */
  #emit(ev) { for (const f of this.listeners) f(ev, this) }
  /** 订阅事件，返回取消函数。事件: 'minute' | 'hour' | 'day' | 'jump'（手动跳时间，世界状态不连续） */
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f) }

  /** 当前仿真时刻的 Date 对象 */
  get date() { return new Date(this.t) }
  /** 一天里的小时数，带小数: 18.5 = 18:30 */
  get hour() { const d = this.date; return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 }
  /** 从某个固定零点起算的仿真分钟数（时刻表、活动排期用它做时间轴） */
  get minutes() { return this.t / 60000 }

  /** 某一天是什么日子: 节假日表优先，其次调休上班日，最后看周几 */
  dayTypeOf(d) {
    const k = keyOf(d)
    if (this.holidays.has(k)) return 'holiday'
    if (this.makeupWorkdays.has(k)) return 'workday'
    const wd = d.getDay()
    return wd === 0 || wd === 6 ? 'weekend' : 'workday'
  }

  /** 今天是什么日子: 'workday' | 'weekend' | 'holiday' */
  get dayType() { return this.dayTypeOf(this.date) }
  /** 交通时刻表只分两套: 工作日 / 节假日（周末按节假日） */
  get timetable() { return this.dayType === 'workday' ? 'workday' : 'holiday' }

  /** 界面显示用的中文标签 { date, time, dayType } */
  get label() {
    const d = this.date
    return { date: `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_LABEL[d.getDay()]}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, dayType: DAY_TYPE_LABEL[this.dayType] }
  }

  /** 改仿真速度（每现实秒多少仿真秒）。引擎会按这个值把每帧切成小步推进物理 */
  setRate(r) { this.rate = r }

  /** 跳到今天（或之后最近一次）的 hour 点；用于演示「看看晚高峰」 */
  jumpToHour(h) {
    const d = this.date
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(h), Math.round((h % 1) * 60), 0) // 今天的 h 点（小数转分钟）
    if (target.getTime() <= this.t) target.setTime(target.getTime() + DAY_MS) // 已经过了就跳到明天
    this.#jump(target.getTime())
  }

  /** 跳到任意时刻（毫秒时间戳） */
  jumpTo(ms) { this.#jump(ms) }

  /** 跳到下一个指定类型的日子的 hour 点（'workday' | 'weekend' | 'holiday'） */
  jumpToDayType(type, h = 10) {
    const d = this.date
    for (let i = 1; i < 400; i++) { // 最多往后找 400 天（节假日表再稀也够）
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, Math.floor(h), Math.round((h % 1) * 60), 0)
      if (this.dayTypeOf(c) === type) return this.#jump(c.getTime())
    }
  }

  /** 跳时间的公共部分: 设时刻、重置分钟计数、依次发 jump / day / hour（监听者据此重置人群、重排活动、重铺列车） */
  #jump(ms) {
    this.t = ms
    this._lastMinute = Math.floor(ms / 60000)
    this.#emit('jump') // 手动跳时间: 世界状态不连续了，人群要按新时刻重新布置，排期、时刻表重新生成
    this.#emit('day')
    this.#emit('hour')
  }
}

// ---------------------------------------------------------------------------
// 一天里的强度曲线（0~1），[小时, 值] 节点之间线性插值。
// people 曲线在没有需求模型（demand.js）时驱动总人数；cars 曲线驱动路上的目标车数。
// 曲线形状是经验值: 工作日早晚双峰 + 午间小峰，休息日单峰且晚起；节假日在周末基础上人再多 15%。
// 接真实数据时替换这几个数组即可。
// ---------------------------------------------------------------------------
const CURVES = {
  workday: {
    people: [[0, 0.04], [5.5, 0.04], [7, 0.3], [8.5, 0.85], [10, 0.55], [12, 0.95], [13.5, 0.65], [17, 0.75], [18.5, 1.0], [20.5, 0.8], [22.5, 0.3], [24, 0.06]],
    cars: [[0, 0.08], [5.5, 0.1], [7.5, 0.9], [9, 1.0], [10.5, 0.6], [16.5, 0.65], [18, 1.0], [19.5, 0.8], [22, 0.35], [24, 0.1]],
  },
  weekend: {
    people: [[0, 0.06], [7, 0.08], [9.5, 0.45], [11.5, 0.85], [14, 0.95], [16.5, 1.0], [19.5, 0.95], [21.5, 0.6], [23, 0.25], [24, 0.08]],
    cars: [[0, 0.1], [7, 0.12], [10, 0.6], [14, 0.75], [17.5, 0.85], [20, 0.6], [23, 0.2], [24, 0.1]],
  },
}
CURVES.holiday = { people: CURVES.weekend.people.map(([h, v]) => [h, Math.min(1, v * 1.15)]), cars: CURVES.weekend.cars } // 节假日: 人 +15%（封顶 1），车同周末

/** 某类活动（'people' | 'cars'）在某种日子的某个时刻的强度，0~1 */
export function activity(kind, dayType, hour) {
  const pts = CURVES[dayType][kind]
  for (let i = 1; i < pts.length; i++) { // 找到第一个 ≥ hour 的节点，和前一个之间线性插值
    if (hour <= pts[i][0]) {
      const [h0, v0] = pts[i - 1], [h1, v1] = pts[i]
      return v0 + ((v1 - v0) * (hour - h0)) / (h1 - h0 || 1)
    }
  }
  return pts[pts.length - 1][1] // 超出最后节点取末值
}

/**
 * 太阳高度的粗略近似（0 = 夜里，1 = 正午），只用来调光照、天色、亮窗和路灯。
 * 6 点日出、18 点日落，正弦拉伸 1.6 倍再抬 0.12，让白天大部分时间都是满亮、黄昏很短 —— 好看优先于天文准确。
 */
export function daylight(hour) {
  const x = Math.sin(((hour - 6) / 12) * Math.PI) // 6 点日出、18 点日落
  return Math.max(0, Math.min(1, x * 1.6 + 0.12))
}
