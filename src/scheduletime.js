'use strict'
// When a scheduled task is due. Pure: no clock, no storage.
//
// A task has either a five-field cron expression (`expr`, also the @aliases
// and Chinese shorthands of src/scheduleexpr.js) or one absolute local minute
// (`at`, "YYYY-MM-DD HH:mm"). Both are read in the task's own time zone.
//
// An occurrence is one epoch minute (UTC), the unit the core's schedule
// decisions use. Its identity is the local wall-clock minute (firstInstant in
// src/scheduleexpr.js):
//   - a local minute that happens twice when clocks go back is one
//     occurrence, at its first instant; the repeat is not an occurrence;
//   - a local minute that does not exist when clocks go forward is no
//     occurrence: a recurring task does not run that day at that time, and a
//     one-off set to such a minute is refused when it is created.
//
// Whether a given minute matches is always answered by the existing matcher
// (matchCron / firstInstant). The day filter below only skips whole days that
// cannot match, so that a search over months is a few thousand cheap checks.
const { normalizeCron, parseField, matchCron, normalizeAt, describeCron, describeAt, firstInstant } = require('./scheduleexpr')
const { tzParts, tzOffsetMin, normalizeTz, isValidTz } = require('./core/time')

const MINUTE_MS = 60_000
// Five years of days: far enough to find a 29 February schedule.
const SEARCH_DAYS = 1830
// A backward search over this few minutes checks each one directly.
const DIRECT_MINUTES = 3
// Clock changes move local time by at most a few hours: within FOLD_WINDOW
// minutes after one, FOLD_MARGIN minutes of local time may have repeated.
const FOLD_WINDOW = 240
const FOLD_MARGIN = 180

const pad = value => String(value).padStart(2, '0')
const wall = (y, mo, d, h, mi) => `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`
const range = (min, max) => Array.from({ length: max - min + 1 }, (_, index) => min + index)

// The parsed form of a task's schedule; throws the parser's own message.
function compileSchedule(task) {
  if (task && typeof task.at === 'string' && task.at) return { at: normalizeAt(task.at) }
  const expr = normalizeCron(task && task.expr)
  const [mi, h, dom, mon, dow] = expr.split(' ')
  const set = (field, min, max) => parseField(field, min, max)
  const sorted = (field, min, max) => {
    const values = set(field, min, max)
    return values === null ? range(min, max) : [...values].sort((a, b) => a - b)
  }
  return { expr, minutes: sorted(mi, 0, 59), hours: sorted(h, 0, 23),
    dom: set(dom, 1, 31), mon: set(mon, 1, 12), dow: set(dow, 0, 6) }
}

// Can any minute of this calendar day match? The same day rule as matchCron
// (both day fields restricted: either may match).
function dayCanMatch(schedule, y, mo, d) {
  if (schedule.mon !== null && !schedule.mon.has(mo)) return false
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  const domOk = schedule.dom === null || schedule.dom.has(d)
  const dowOk = schedule.dow === null || schedule.dow.has(weekday)
  return schedule.dom !== null && schedule.dow !== null ? domOk || dowOk : domOk && dowOk
}

function localParts(minute, tz) {
  const p = tzParts(minute * MINUTE_MS, tz)
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute }
}

// The epoch minute of a local wall-clock minute (its first instant), or null
// when that local minute does not exist.
function minuteOfWall(text, tz) {
  const ms = firstInstant(text, tz)
  return ms === null ? null : ms / MINUTE_MS
}

// Is this epoch minute an occurrence of the schedule?
function isOccurrence(schedule, minute, tz) {
  const zone = normalizeTz(tz)
  if (schedule.at) return minuteOfWall(schedule.at, zone) === minute
  if (!matchCron(schedule.expr, minute * MINUTE_MS, zone)) return false
  const p = localParts(minute, zone)
  return minuteOfWall(wall(p.y, p.mo, p.d, p.h, p.mi), zone) === minute
}

// The first occurrence strictly after `after` (epoch minutes), or null when
// none exists within the search bound.
//
// First instants grow with the local wall-clock time, so on the starting day
// no local minute earlier than `after`'s own can be an occurrence after it.
function nextOccurrence(schedule, after, tz) {
  const zone = normalizeTz(tz)
  if (schedule.at) {
    const minute = minuteOfWall(schedule.at, zone)
    return minute !== null && minute > after ? minute : null
  }
  const start = localParts(after, zone)
  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + offset))
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate()
    if (!dayCanMatch(schedule, y, mo, d)) continue
    for (const h of schedule.hours) {
      if (offset === 0 && h < start.h) continue
      for (const mi of schedule.minutes) {
        if (offset === 0 && h === start.h && mi < start.mi) continue
        const minute = minuteOfWall(wall(y, mo, d, h, mi), zone)
        if (minute !== null && minute > after && matchCron(schedule.expr, minute * MINUTE_MS, zone)) return minute
      }
    }
  }
  return null
}

// The latest occurrence in (floor, upto] (epoch minutes), or null.
function prevOccurrence(schedule, floor, upto, tz) {
  const zone = normalizeTz(tz)
  if (!(upto > floor)) return null
  if (schedule.at) {
    const minute = minuteOfWall(schedule.at, zone)
    return minute !== null && minute > floor && minute <= upto ? minute : null
  }
  // The minute tick asks about the last minute or two: check them directly.
  if (upto - floor <= DIRECT_MINUTES) {
    for (let minute = upto; minute > floor; minute--) if (isOccurrence(schedule, minute, zone)) return minute
    return null
  }
  // Otherwise day by day, latest local minute first; first instants fall with
  // the local time, so the first one inside the range is the answer. A local
  // minute later than `upto`'s own has happened already only when clocks went
  // back shortly before `upto`; then up to three hours of later local minutes
  // are compared as instants too.
  const at = localParts(upto, zone)
  const folded = tzOffsetMin(zone, upto * MINUTE_MS) !== tzOffsetMin(zone, (upto - FOLD_WINDOW) * MINUTE_MS)
  const limit = Date.UTC(at.y, at.mo - 1, at.d, at.h, at.mi) + (folded ? FOLD_MARGIN * MINUTE_MS : 0)
  const start = new Date(limit)
  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - offset))
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate()
    // Every minute of this local day is more than a day older than `floor`.
    if (Date.UTC(y, mo - 1, d + 2) < floor * MINUTE_MS) return null
    if (!dayCanMatch(schedule, y, mo, d)) continue
    for (let hi = schedule.hours.length - 1; hi >= 0; hi--) {
      for (let mi = schedule.minutes.length - 1; mi >= 0; mi--) {
        if (Date.UTC(y, mo - 1, d, schedule.hours[hi], schedule.minutes[mi]) > limit) continue
        const minute = minuteOfWall(wall(y, mo, d, schedule.hours[hi], schedule.minutes[mi]), zone)
        if (minute === null || minute > upto) continue
        if (minute <= floor) return null
        if (matchCron(schedule.expr, minute * MINUTE_MS, zone)) return minute
      }
    }
  }
  return null
}

// The schedule in words for the task list. Chinese comes from the existing
// describers; `nowMs` lets a one-off drop the date parts it shares with today.
function describeSchedule(task, tz, nowMs = null) {
  try {
    if (task.at) {
      const p = nowMs === null ? null : tzParts(nowMs, tz)
      return describeAt(task.at, p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : undefined)
    }
    return describeCron(task.expr)
  } catch { return null }
}

module.exports = { compileSchedule, isOccurrence, nextOccurrence, prevOccurrence, describeSchedule,
  minuteOfWall, isValidTz, normalizeTz, MINUTE_MS, SEARCH_DAYS }
