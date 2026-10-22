(function (root) {
  "use strict";

  const KEY = "eeTimetableComparison";
  const LIBRARY_KEY = "eeTimetableComparisons";
  const ENABLED_KEY = "eeTimetableComparisonEnabled";
  const MAX_FILE_BYTES = 1024 * 1024;
  const MAX_LESSONS = 4000;
  const DAY = 86400000;
  const clean = (value, max = 160) => typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";
  const fail = (code) => { throw new Error(code); };

  function pageMode(search) {
    const query = new URLSearchParams(search);
    if (query.has("mode")) return query.get("mode") || "";
    const encoded = query.get("eqa");
    if (!encoded || encoded.length > 8192) return "";
    try {
      return new URLSearchParams(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))).get("mode") || "";
    } catch (_) { return ""; }
  }

  function normalizeLibrary(value, legacy = null) {
    if (value === undefined || value === null) return { version: 1, activeId: legacy ? "legacy" : null,
      schedules: legacy ? [{ id: "legacy", profile: normalizeProfile(legacy) }] : [] };
    if (value.version !== 1 || !Array.isArray(value.schedules)) fail("eeCompareInvalidProfile");
    const ids = new Set();
    const schedules = value.schedules.map(entry => {
      if (!entry || typeof entry.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(entry.id) || ids.has(entry.id)) fail("eeCompareInvalidProfile");
      ids.add(entry.id);
      return { id: entry.id, profile: normalizeProfile(entry.profile) };
    });
    if (schedules.length ? !ids.has(value.activeId) : value.activeId !== null) fail("eeCompareInvalidProfile");
    return { version: 1, activeId: value.activeId, schedules };
  }

  function dayNumber(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return NaN;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date.getTime() / DAY : NaN;
  }

  function dateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function addDays(value, count) {
    const day = dayNumber(value);
    if (!Number.isFinite(day) || !Number.isInteger(count)) fail("eeCompareInvalidDate");
    return new Date((day + count) * DAY).toISOString().slice(0, 10);
  }

  function weekday(value) {
    const day = dayNumber(value);
    return Number.isFinite(day) ? ((day + 3) % 7 + 7) % 7 : NaN;
  }

  function monday(value) { return addDays(value, -weekday(value)); }

  function minutes(value) {
    if (!/^\d{1,2}:\d{2}$/.test(value || "")) return NaN;
    const [hours, mins] = value.split(":").map(Number);
    return hours < 24 && mins < 60 ? hours * 60 + mins : NaN;
  }

  function clock(value) {
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }

  function normalizeLesson(value, template = false) {
    if (!value || typeof value !== "object") fail("eeCompareInvalidLesson");
    const start = minutes(value.startTime);
    const end = minutes(value.endTime);
    const title = clean(value.title);
    if (!title || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) fail("eeCompareInvalidLesson");
    const result = { title, startTime: clock(start), endTime: clock(end), room: clean(value.room), group: clean(value.group) };
    if (template) {
      if (!Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6) fail("eeCompareInvalidLesson");
      result.weekday = value.weekday;
    } else {
      if (!Number.isFinite(dayNumber(value.date))) fail("eeCompareInvalidDate");
      result.date = value.date;
    }
    return result;
  }

  function normalizeProfile(value) {
    if (!value || value.version !== 1 || !["import", "class"].includes(value.source)) fail("eeCompareInvalidProfile");
    const name = clean(value.name, 60);
    if (!name) fail("eeCompareNameRequired");
    const result = { version: 1, source: value.source, name, enabled: value.enabled !== false,
      excludedGroups: Array.isArray(value.excludedGroups) ? [...new Set(value.excludedGroups.map((item) => clean(item)).filter(Boolean))].slice(0, 100) : [] };
    if (value.source === "class") {
      const url = new URL(value.origin);
      if (url.protocol !== "https:" || !/^[a-z0-9-]+\.edupage\.org$/i.test(url.hostname) || url.port || url.username || url.password) fail("eeCompareInvalidProfile");
      result.origin = url.origin;
      result.ownerId = clean(value.ownerId, 100);
      result.ownerLabel = clean(value.ownerLabel);
      if (!result.ownerId || !result.ownerLabel) fail("eeCompareInvalidProfile");
      return result;
    }
    if (![1, 2].includes(value.cycleWeeks) || monday(value.anchorMonday) !== value.anchorMonday) fail("eeCompareInvalidDate");
    if (!Array.isArray(value.templates) || value.templates.length !== value.cycleWeeks) fail("eeCompareInvalidProfile");
    let count = 0;
    result.templates = value.templates.map((week) => {
      if (!Array.isArray(week) || (count += week.length) > MAX_LESSONS) fail("eeCompareTooLarge");
      return week.map((lesson) => normalizeLesson(lesson, true));
    });
    if (!count) fail("eeCompareEmptyImport");
    result.cycleWeeks = value.cycleWeeks;
    result.anchorMonday = value.anchorMonday;
    return result;
  }

  function included(lessons, excludedGroups = []) {
    return lessons.filter((lesson) => !lesson.group || !excludedGroups.includes(lesson.group));
  }

  function expand(profile, start, count = 7) {
    const config = normalizeProfile(profile);
    if (config.source !== "import" || !Number.isInteger(count) || count < 1 || count > 31) fail("eeCompareInvalidProfile");
    const lessons = [];
    for (let offset = 0; offset < count; offset++) {
      const date = addDays(start, offset);
      const weeks = Math.floor((dayNumber(monday(date)) - dayNumber(config.anchorMonday)) / 7);
      const index = ((weeks % config.cycleWeeks) + config.cycleWeeks) % config.cycleWeeks;
      for (const lesson of included(config.templates[index], config.excludedGroups)) {
        if (lesson.weekday === weekday(date)) {
          const { weekday: ignored, ...fields } = lesson;
          lessons.push({ ...fields, date });
        }
      }
    }
    return lessons;
  }

  function sharedGaps(own, other, known = true) {
    if (!known) return [];
    const intervals = [...own, ...other].map((lesson) => [minutes(lesson.startTime), minutes(lesson.endTime)])
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
      .sort((a, b) => a[0] - b[0]);
    if (!intervals.length) return [];
    const gaps = [];
    let end = intervals[0][1];
    for (const [start, nextEnd] of intervals.slice(1)) {
      if (start - end >= 15) gaps.push({ startTime: clock(end), endTime: clock(start) });
      end = Math.max(end, nextEnd);
    }
    return gaps;
  }

  function daySummary(own, other, { ownKnown = true, otherKnown = true, currentMinute = null, allowGaps = true } = {}) {
    const finish = (lessons, known) => known && lessons.length
      ? clock(Math.max(...lessons.map((lesson) => minutes(lesson.endTime)))) : null;
    const ownFinish = finish(own, ownKnown);
    const otherFinish = finish(other, otherKnown);
    const sorted = other.slice().sort((a, b) => minutes(a.startTime) - minutes(b.startTime));
    const current = otherKnown && currentMinute !== null
      ? sorted.filter((lesson) => minutes(lesson.startTime) <= currentMinute && minutes(lesson.endTime) > currentMinute) : [];
    const nextStart = otherKnown ? sorted.find((lesson) => currentMinute === null || minutes(lesson.startTime) > currentMinute)?.startTime : null;
    const next = nextStart ? sorted.filter((lesson) => lesson.startTime === nextStart) : [];
    return { ownFinish, otherFinish, current, next,
      difference: ownFinish && otherFinish ? minutes(otherFinish) - minutes(ownFinish) : null,
      gaps: sharedGaps(own, other, allowGaps && ownKnown && otherKnown) };
  }

  function parseStamp(value, parameters, localZone) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value);
    if (!match || /VALUE=DATE(?:;|$)/i.test(parameters)) fail("eeCompareTimedOnly");
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    const time = `${match[4]}:${match[5]}`;
    if (!Number.isFinite(dayNumber(date)) || !Number.isFinite(minutes(time)) || Number(match[6] || 0) > 59) fail("eeCompareInvalidDate");
    const zone = /(?:^|;)TZID=(?:"([^"]+)"|([^;]+))/i.exec(parameters);
    if (zone && (match[7] || (zone[1] || zone[2]) !== localZone)) fail("eeCompareTimezoneUnsupported");
    if (match[7]) {
      const stamp = new Date(`${date}T${time}:${match[6] || "00"}Z`);
      return { date: dateKey(stamp), time: `${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}` };
    }
    return { date, time };
  }

  function parseIcs(text, localZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    if (typeof text !== "string" || text.length > MAX_FILE_BYTES || new TextEncoder().encode(text).length > MAX_FILE_BYTES) fail("eeCompareTooLarge");
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n[ \t]|\n[ \t]/g, "").split(/\r?\n/);
    const unescape = (value) => value.replace(/\\([nN,;\\])/g, (_, char) => /[nN]/.test(char) ? " " : char);
    let event = null;
    let componentDepth = 0;
    let calendar = false;
    let finished = false;
    const lessons = [];
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon < 0) { if (line.trim()) fail("eeCompareInvalidCalendar"); else continue; }
      const [property, ...params] = line.slice(0, colon).split(";");
      const key = property.toUpperCase();
      const value = line.slice(colon + 1);
      if (event && key === "BEGIN" && value !== "VEVENT") { componentDepth++; continue; }
      if (componentDepth) {
        if (key === "END") componentDepth--;
        continue;
      }
      if (key === "BEGIN" && value === "VCALENDAR") { if (calendar || finished) fail("eeCompareInvalidCalendar"); calendar = true; }
      else if (key === "END" && value === "VCALENDAR") { if (!calendar || event) fail("eeCompareInvalidCalendar"); finished = true; calendar = false; }
      else if (key === "BEGIN" && value === "VEVENT") { if (!calendar || event) fail("eeCompareInvalidCalendar"); event = {}; }
      else if (key === "END" && value === "VEVENT") {
        if (!event?.DTSTART || !event.DTEND || !event.SUMMARY) fail("eeCompareInvalidCalendar");
        const start = parseStamp(event.DTSTART.value, event.DTSTART.params, localZone);
        const end = parseStamp(event.DTEND.value, event.DTEND.params, localZone);
        if (start.date !== end.date) fail("eeCompareTimedOnly");
        lessons.push(normalizeLesson({ date: start.date, startTime: start.time, endTime: end.time,
          title: unescape(event.SUMMARY.value), room: unescape(event.LOCATION?.value || ""), group: unescape(event["X-EE-GROUP"]?.value || "") }));
        if (lessons.length > MAX_LESSONS) fail("eeCompareTooLarge");
        event = null;
      } else if (event) {
        if (["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "DURATION"].includes(key)) fail("eeCompareRecurrenceUnsupported");
        if (["DTSTART", "DTEND", "SUMMARY", "LOCATION", "X-EE-GROUP"].includes(key)) {
          if (event[key]) fail("eeCompareInvalidCalendar");
          event[key] = { value, params: params.join(";") };
        }
      }
    }
    if (!finished || event || calendar || componentDepth) fail("eeCompareInvalidCalendar");
    if (!lessons.length) fail("eeCompareEmptyImport");
    const unique = new Map(lessons.map((lesson) => [JSON.stringify(lesson), lesson]));
    return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || minutes(a.startTime) - minutes(b.startTime));
  }

  function templateFromWeek(lessons, start) {
    if (monday(start) !== start) fail("eeCompareInvalidDate");
    return lessons.filter((lesson) => lesson.date >= start && lesson.date < addDays(start, 7))
      .map((lesson) => normalizeLesson({ ...lesson, weekday: weekday(lesson.date) }, true));
  }

  const api = { KEY, LIBRARY_KEY, ENABLED_KEY, MAX_FILE_BYTES, MAX_LESSONS, clean, dayNumber, dateKey, addDays, monday, weekday, minutes, clock,
    normalizeLibrary,
    normalizeLesson, normalizeProfile, included, expand, sharedGaps, daySummary, pageMode, parseIcs, templateFromWeek };
  root.EEComparison = Object.freeze(api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
