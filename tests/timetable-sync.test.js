const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadTimetableInternals() {
  const scriptPath = path.join(__dirname, "..", "scripts", "timetable-sync.js");
  const source = fs.readFileSync(scriptPath, "utf8");

  const noop = () => {};
  // waitForTimetableReady's polling loop (timetable-sync.js) keeps scheduling
  // setTimeout calls in the background after the test's assertions are done,
  // which keeps Node's event loop alive for the full ~30s timeout before the
  // process can exit. unref() lets Node exit as soon as the test itself
  // finishes, without changing the timer's actual behavior.
  const unrefSetTimeout = (fn, ms) => {
    const id = setTimeout(fn, ms);
    id?.unref?.();
    return id;
  };
  const window = {
    setTimeout: unrefSetTimeout,
    clearTimeout,
    location: {
      origin: "https://school.edupage.org",
      href: "https://school.edupage.org/dashboard/eb.php?mode=timetable",
    },
  };
  window.top = window;

  const context = {
    console,
    Date,
    Math,
    Promise,
    window,
    document: {
      body: {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    chrome: {
      runtime: {
        sendMessage(_payload, callback) {
          if (callback) callback();
        },
        lastError: null,
        onMessage: {
          addListener: noop,
        },
      },
    },
  };

  window.document = context.document;
  context.globalThis = context;
  context.__EE_TEST__ = true;

  const libSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "lib", "ee-common.js"), "utf8");
  vm.runInNewContext(libSource + "\n" + source, context, { filename: scriptPath });
  return context.__eeTestExports;
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}

runTest("resolveDisplayedDate can anchor year selection to the visible timetable week", () => {
  const { resolveDisplayedDate, formatDate } = loadTimetableInternals();
  const anchored = resolveDisplayedDate("2.", "1.", new Date(2027, 11, 31));

  assert.equal(formatDate(anchored), "2028-01-02");
});

runTest("resolveDisplayedDate rejects calendar overflow from page text", () => {
  const { resolveDisplayedDate } = loadTimetableInternals();

  assert.equal(resolveDisplayedDate("31.", "2.", new Date(2026, 1, 1)), null);
  assert.equal(resolveDisplayedDate("10.", "13.", new Date(2026, 1, 1)), null);
});

runTest("timetable times support English AM/PM, midnight/noon, and 24-hour locales", () => {
  const { parseTimetableTimeRange } = loadTimetableInternals();
  assert.equal(parseTimetableTimeRange("11:40 am - 12:25 pm").endTime, "12:25");
  assert.equal(parseTimetableTimeRange("1:25 pm - 2:10 pm").startTime, "13:25");
  assert.equal(parseTimetableTimeRange("12:05 am - 12:45 am").startTime, "00:05");
  assert.equal(parseTimetableTimeRange("08:00 – 08:45").startTime, "08:00");
  assert.equal(parseTimetableTimeRange("25:00 - 26:00"), null);
});

runTest("English timetable day/month headers resolve actual calendar dates", () => {
  const { resolveDisplayedWeekDates } = loadTimetableInternals();
  assert.equal(resolveDisplayedWeekDates([{ dateText: "19/10" }], new Date(2026, 9, 21))[0].date, "2026-10-19");
});

runTest("compact English headers keep afternoon lessons after noon when AM/PM is omitted", () => {
  const { parseTimetableTimeRange, normalizeTimetablePeriods } = loadTimetableInternals();
  const result = normalizeTimetablePeriods(["11:40 - 12:25", "12:35 - 1:20", "1:25 - 2:10", "2:15 - 3:00"].map(parseTimetableTimeRange));
  assert.equal(result[1].endTime, "13:20");
  assert.equal(result[2].startTime, "13:25");
  assert.equal(result[3].endTime, "15:00");
});

runTest("resolveDisplayedWeekDates keeps cross-year week headers in chronological order", () => {
  const { resolveDisplayedWeekDates } = loadTimetableInternals();
  const resolved = resolveDisplayedWeekDates([
    { dayText: "Po", dateText: "30. 12." },
    { dayText: "Ut", dateText: "31. 12." },
    { dayText: "St", dateText: "1. 1." },
    { dayText: "Št", dateText: "2. 1." },
    { dayText: "Pi", dateText: "3. 1." },
  ], new Date(2026, 0, 2));

  assert.deepEqual(
    Array.from(resolved, (entry) => entry.date),
    ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03"],
  );
});
