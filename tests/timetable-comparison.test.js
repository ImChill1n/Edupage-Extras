const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../scripts/lib/ee-timetable-comparison.js");

const lesson = (startTime, endTime, fields = {}) => ({ title: "Math", startTime, endTime, room: "12", group: "", ...fields });
const profile = (fields = {}) => ({ version: 1, source: "import", name: "Other", enabled: true, cycleWeeks: 1,
  anchorMonday: "2026-10-19", excludedGroups: [], templates: [[lesson("08:00", "08:45", { weekday: 0 })]], ...fields });
const calendar = (event = "DTSTART:20261019T080000\nDTEND:20261019T084500\nSUMMARY:Math") => `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\n${event}\nEND:VEVENT\nEND:VCALENDAR`;

test("comparison uses clock times, merges overlapping groups, and includes the exact 15 minute boundary", () => {
  assert.deepEqual(C.sharedGaps([lesson("08:00", "08:45"), lesson("08:15", "09:00")],
    [lesson("09:15", "10:00"), lesson("10:14", "11:00")]), [{ startTime: "09:00", endTime: "09:15" }]);
  assert.deepEqual(C.sharedGaps([], []), []);
  assert.deepEqual(C.sharedGaps([lesson("08:00", "09:00"), lesson("10:00", "11:00")], [], false), []);
});

test("weekly templates repeat before and after the anchor without shifting wall times across DST", () => {
  for (const date of ["2026-10-12", "2026-10-19", "2026-10-26", "2027-03-29"]) {
    const expanded = C.expand(profile(), date);
    assert.equal(expanded[0].date, date);
    assert.equal(expanded[0].startTime, "08:00");
  }
});

test("alternating templates use the chosen Monday across year boundaries and negative offsets", () => {
  const config = profile({ anchorMonday: "2026-12-28", cycleWeeks: 2,
    templates: [[lesson("08:00", "09:00", { weekday: 0 })], [lesson("10:00", "11:00", { weekday: 0 })]] });
  assert.equal(C.expand(config, "2027-01-04")[0].startTime, "10:00");
  assert.equal(C.expand(config, "2027-01-11")[0].startTime, "08:00");
  assert.equal(C.expand(config, "2026-12-21")[0].startTime, "10:00");
});

test("group exclusions retain common lessons and do not mutate the stored template", () => {
  const config = profile({ excludedGroups: ["French"], templates: [[
    lesson("08:00", "09:00", { weekday: 0 }), lesson("09:00", "10:00", { weekday: 0, group: "French" }),
  ]] });
  assert.equal(C.expand(config, "2026-10-19").length, 1);
  assert.equal(config.templates[0].length, 2);
});

test("calendar import unfolds UTF-8 fields, decodes text, drops metadata and deduplicates", () => {
  const parsed = C.parseIcs(calendar("DTSTART:20261019T080000\nDTEND:20261019T084500\nSUMMARY:Matema\n tika\\, A\nLOCATION:Room\\; 12\nDESCRIPTION:private metadata\nX-EE-GROUP:English"));
  assert.equal(parsed[0].title, "Matematika, A");
  assert.equal(parsed[0].room, "Room; 12");
  assert.equal(parsed[0].group, "English");
  assert.equal(JSON.stringify(parsed).includes("private"), false);
  const two = calendar().replace("END:VCALENDAR", `${calendar().split("BEGIN:VEVENT")[1].split("END:VCALENDAR")[0].replace(/^/, "BEGIN:VEVENT")}END:VCALENDAR`);
  assert.equal(C.parseIcs(two).length, 1);
});

test("calendar import accepts UTC exports and floating/local-zone lesson times", () => {
  const event = C.parseIcs(calendar("DTSTART:20261019T080000Z\nDTEND:20261019T084500Z\nSUMMARY:Math"))[0];
  assert.equal(event.startTime, C.clock(new Date("2026-10-19T08:00:00Z").getHours() * 60));
  assert.equal(C.parseIcs(calendar("DTSTART;TZID=Europe/Bratislava:20261019T080000\nDTEND;TZID=Europe/Bratislava:20261019T084500\nSUMMARY:Math"), "Europe/Bratislava")[0].startTime, "08:00");
});

test("calendar alarm metadata cannot replace lesson titles or times", () => {
  const result = C.parseIcs(calendar("DTSTART:20261019T080000\nDTEND:20261019T084500\nSUMMARY:Math\nBEGIN:VALARM\nTRIGGER:-PT10M\nSUMMARY:Alarm metadata\nEND:VALARM"));
  assert.equal(result[0].title, "Math");
});

test("calendar import rejects ambiguous/unsupported events instead of silently losing lessons", () => {
  const invalid = [
    [calendar("DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:All day"), "eeCompareTimedOnly"],
    [calendar("DTSTART:20260230T080000\nDTEND:20260230T090000\nSUMMARY:Invalid"), "eeCompareInvalidDate"],
    [calendar("DTSTART:20261019T250000\nDTEND:20261019T260000\nSUMMARY:Invalid"), "eeCompareInvalidDate"],
    [calendar("DTSTART:20261019T080000\nDTEND:20261019T084500\nSUMMARY:Math\nRRULE:FREQ=WEEKLY"), "eeCompareRecurrenceUnsupported"],
    [calendar("DTSTART;TZID=Pacific/Auckland:20261019T080000\nDTEND;TZID=Pacific/Auckland:20261019T084500\nSUMMARY:Math"), "eeCompareTimezoneUnsupported"],
    [calendar().replace("END:VCALENDAR", ""), "eeCompareInvalidCalendar"],
    ["x".repeat(C.MAX_FILE_BYTES + 1), "eeCompareTooLarge"],
  ];
  for (const [value, code] of invalid) assert.throws(() => C.parseIcs(value), { message: code });
});

test("sample-week selection includes only that week and normalizes the saved profile", () => {
  const samples = [lesson("08:00", "09:00", { date: "2026-10-19" }), lesson("09:00", "10:00", { date: "2026-10-26" })];
  assert.equal(C.templateFromWeek(samples, "2026-10-19").length, 1);
  const normalized = C.normalizeProfile({ ...profile(), rawFile: "private", description: "private" });
  assert.equal("rawFile" in normalized, false);
  assert.throws(() => C.normalizeProfile(profile({ anchorMonday: "2026-10-20" })));
  assert.throws(() => C.normalizeProfile(profile({ templates: [[lesson("09:00", "08:00", { weekday: 0 })]] })));
  assert.throws(() => C.normalizeProfile({ version: 1, source: "class", name: "Test", origin: "https://attacker.example", ownerId: "1", ownerLabel: "A" }));
});

test("timetable routes accept EduPage encoded links and reject malformed parameters", () => {
  assert.equal(C.pageMode("?eqa=bW9kZT10aW1ldGFibGU%3D"), "timetable");
  assert.equal(C.pageMode("?mode=timetable"), "timetable");
  assert.equal(C.pageMode("?mode=other&eqa=bW9kZT10aW1ldGFibGU%3D"), "other");
  for (const search of ["?eqa=%", "?eqa=" + "x".repeat(8193), "?eqa=YWJj", ""]) assert.equal(C.pageMode(search), "");
});

test("compact summaries compare actual finish times and retain simultaneous current lessons", () => {
  const own = [lesson("08:00", "11:30"), lesson("10:00", "10:45")];
  const other = [lesson("08:15", "09:00"), lesson("08:30", "09:15"), lesson("10:00", "12:15")];
  const data = C.daySummary(own, other, { currentMinute: 8 * 60 + 40 });
  assert.equal(data.ownFinish, "11:30");
  assert.equal(data.otherFinish, "12:15");
  assert.equal(data.difference, 45);
  assert.equal(data.current.length, 2);
  assert.equal(data.next[0].startTime, "10:00");
  assert.equal(C.daySummary(other, own).difference, -45);
  assert.equal(C.daySummary(own, own).difference, 0);
  assert.equal(C.daySummary(own, other, { currentMinute: 13 * 60 }).next.length, 0);
  assert.equal(C.daySummary(own, other).next[0].startTime, "08:15");
});

test("missing schedules have no finish comparison or gaps, while known empty days stay explicit", () => {
  const lessons = [lesson("08:00", "09:00"), lesson("10:00", "11:00")];
  const missing = C.daySummary(lessons, lessons, { otherKnown: false, currentMinute: 500 });
  assert.equal(missing.otherFinish, null);
  assert.equal(missing.difference, null);
  assert.deepEqual(missing.gaps, []);
  assert.deepEqual(missing.current, []);
  assert.deepEqual(C.daySummary(lessons, lessons, { allowGaps: false }).gaps, []);
  assert.equal(C.daySummary([], []).difference, null);
});
