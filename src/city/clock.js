// 仿真时钟 + 日历。整个城市里所有「随时间变化」的东西（人群作息、场馆活动、地铁/铁路时刻表、车流强度、昼夜光照）
// 都只读这一个时钟，保证彼此对得上。
//
// 两种时间要分清:
//   · 日程时间（这里）: 默认 1 现实秒 = 1 仿真分钟，一天 24 分钟走完。决定「现在该有多少人、谁去哪、几点发车」。
//   · 动作时间（引擎的 timeScale）: 小人走路、车开动的快慢，只比真实快 2 倍左右，否则就成瞬移了。
// 两者故意不同步: 日程走得快，动作保持可看。代价是一趟通勤在画面里要花的「日程时间」比真实长，属于可视化的取舍。

const DAY_MS = 86400000

/** 法定节假日与调休上班日。国务院每年发布通知，调休每年不同 —— 这里只放了肯定放假的日子，实际使用请按当年通知补全 */
export const DEFAULT_HOLIDAYS = [
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  '2027-01-01', '2027-05-01', '2027-10-01', '2027-10-02', '2027-10-03',
]
export const DEFAULT_MAKEUP_WORKDAYS = [] // 调休: 本是周末但要上班的日子，如 '2026-10-10'

export const DAY_TYPE_LABEL = { workday: '工作日', weekend: '周末', holiday: '节假日' }
const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad = (n) => String(n).padStart(2, '0')
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export class SimClock {
  /**
   * @param start  起始时刻（本地时间）
   * @param rate   日程时间流速: 每现实秒过多少仿真秒。60 = 一秒一分钟
   */
  constructor({ start = '2026-09-21T07:30:00', rate = 60, holidays = DEFAULT_HOLIDAYS, makeupWorkdays = DEFAULT_MAKEUP_WORKDAYS } = {}) {
    this.t = new Date(start).getTime()
    this.rate = rate
    this.paused = false
    this.holidays = new Set(holidays)
    this.makeupWorkdays = new Set(makeupWorkdays)
    this.listeners = new Set() // (event, clock) => void；event: 'minute' | 'hour' | 'day'
    this._lastMinute = Math.floor(this.t / 60000)
  }

  /** @returns 这一帧过了多少仿真秒 */
  tick(realDt) {
    if (this.paused) return 0
    const simDt = realDt * this.rate
    this.t += simDt * 1000
    const m = Math.floor(this.t / 60000)
    if (m !== this._lastMinute) {
      const prev = new Date(this._lastMinute * 60000), cur = this.date
      this._lastMinute = m
      this.#emit('minute')
      if (cur.getHours() !== prev.getHours()) this.#emit('hour')
      if (cur.getDate() !== prev.getDate()) this.#emit('day')
    }
    return simDt
  }

  #emit(ev) { for (const f of this.listeners) f(ev, this) }
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f) }

  get date() { return new Date(this.t) }
  /** 一天里的小时数，带小数: 18.5 = 18:30 */
  get hour() { const d = this.date; return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 }
  /** 从某个固定零点起算的仿真分钟数（时刻表、活动排期用它做时间轴） */
  get minutes() { return this.t / 60000 }

  dayTypeOf(d) {
    const k = keyOf(d)
    if (this.holidays.has(k)) return 'holiday'
    if (this.makeupWorkdays.has(k)) return 'workday'
    const wd = d.getDay()
    return wd === 0 || wd === 6 ? 'weekend' : 'workday'
  }

  get dayType() { return this.dayTypeOf(this.date) }
  /** 交通时刻表只分两套: 工作日 / 节假日（周末按节假日） */
  get timetable() { return this.dayType === 'workday' ? 'workday' : 'holiday' }

  get label() {
    const d = this.date
    return { date: `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_LABEL[d.getDay()]}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, dayType: DAY_TYPE_LABEL[this.dayType] }
  }

  setRate(r) { this.rate = r }

  /** 跳到今天（或之后最近一次）的 hour 点；用于演示「看看晚高峰」 */
  jumpToHour(h) {
    const d = this.date
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(h), Math.round((h % 1) * 60), 0)
    if (target.getTime() <= this.t) target.setTime(target.getTime() + DAY_MS)
    this.#jump(target.getTime())
  }

  /** 跳到下一个指定类型的日子的 hour 点（'workday' | 'weekend' | 'holiday'） */
  jumpToDayType(type, h = 10) {
    const d = this.date
    for (let i = 1; i < 400; i++) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, Math.floor(h), Math.round((h % 1) * 60), 0)
      if (this.dayTypeOf(c) === type) return this.#jump(c.getTime())
    }
  }

  #jump(ms) {
    this.t = ms
    this._lastMinute = Math.floor(ms / 60000)
    this.#emit('day') // 跳时间等同于换了一天: 让排期、时刻表重新生成
    this.#emit('hour')
  }
}

// ---------------------------------------------------------------------------
// 一天里的强度曲线（0~1），线性插值。人群分组作息上线之前先用它驱动总人数和车流
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
CURVES.holiday = { people: CURVES.weekend.people.map(([h, v]) => [h, Math.min(1, v * 1.15)]), cars: CURVES.weekend.cars }

export function activity(kind, dayType, hour) {
  const pts = CURVES[dayType][kind]
  for (let i = 1; i < pts.length; i++) {
    if (hour <= pts[i][0]) {
      const [h0, v0] = pts[i - 1], [h1, v1] = pts[i]
      return v0 + ((v1 - v0) * (hour - h0)) / (h1 - h0 || 1)
    }
  }
  return pts[pts.length - 1][1]
}

/** 太阳高度的粗略近似（0 = 夜里，1 = 正午），只用来调光照和天色 */
export function daylight(hour) {
  const x = Math.sin(((hour - 6) / 12) * Math.PI) // 6 点日出、18 点日落
  return Math.max(0, Math.min(1, x * 1.6 + 0.12))
}
