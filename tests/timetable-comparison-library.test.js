const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const C = require("../scripts/lib/ee-timetable-comparison.js");
const profile = name => ({ version: 1, source: "import", name, cycleWeeks: 1, anchorMonday: "2026-10-19",
  templates: [[{ title: "Example", weekday: 0, startTime: "08:00", endTime: "08:45" }]] });

function client(initial = {}) {
  const state = { data: structuredClone(initial), fail: false };
  const context = { EEComparison: C, crypto: require("node:crypto").webcrypto,
    chrome: { runtime: {}, storage: { local: {
      get(keys, callback) { callback(Object.fromEntries(keys.map(key => [key, state.data[key]]))); },
      set(value, callback) {
        if (state.fail) context.chrome.runtime.lastError = { message: "Synthetic failure" };
        else Object.assign(state.data, structuredClone(value));
        callback();
        delete context.chrome.runtime.lastError;
      },
    } } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../scripts/timetable-comparison-ui.js"), "utf8"), context);
  return { state, U: context.EEComparisonUI };
}

test("first add preserves the old single schedule and selects the new one", async () => {
  const { state, U } = client({ [C.KEY]: profile("Original") });
  await U.save(profile("Second"));
  assert.deepEqual(state.data[C.LIBRARY_KEY].schedules.map(entry => entry.profile.name), ["Original", "Second"]);
  assert.equal(state.data[C.LIBRARY_KEY].schedules[0].id, "legacy");
  assert.equal(state.data[C.KEY].name, "Second");
  await U.selectSchedule("legacy");
  assert.equal(state.data[C.KEY].name, "Original");
  assert.equal(state.data[C.LIBRARY_KEY].schedules.length, 2);
});

test("editing replaces only that schedule, including schedules with matching names", async () => {
  const { state, U } = client();
  await U.save(profile("Same")); await U.save(profile("Same"));
  const [first, second] = state.data[C.LIBRARY_KEY].schedules;
  assert.notEqual(first.id, second.id);
  await U.save(profile("Edited"), second.id);
  assert.deepEqual(state.data[C.LIBRARY_KEY].schedules.map(entry => entry.profile.name), ["Same", "Edited"]);
  assert.equal(state.data[C.KEY].name, "Edited");
  await assert.rejects(U.save(profile("Invalid edit"), "missing"));
  assert.equal(state.data[C.KEY].name, "Edited");
});

test("removal chooses a remaining schedule; removing the last clears all saved lesson data", async () => {
  const { state, U } = client({ [C.KEY]: profile("Original") });
  await U.save(profile("Second"));
  await U.removeSchedule(state.data[C.LIBRARY_KEY].activeId);
  assert.equal(state.data[C.KEY].name, "Original");
  await U.removeSchedule("legacy");
  assert.equal(state.data[C.KEY], null);
  assert.deepEqual(state.data[C.LIBRARY_KEY], { version: 1, activeId: null, schedules: [] });
  assert.equal((await U.loadLibrary()).schedules.length, 0);
});

test("failed add, edit, or switch preserves the whole library and the active timetable", async () => {
  const { state, U } = client({ [C.KEY]: profile("Original") });
  await U.save(profile("Second"));
  const before = structuredClone(state.data);
  state.fail = true;
  for (const write of [() => U.save(profile("Third")), () => U.save(profile("Changed"), "legacy"),
    () => U.selectSchedule("legacy"), () => U.removeSchedule("legacy")]) {
    await assert.rejects(write(), { message: "eeCompareStorageError" });
    assert.deepEqual(state.data, before);
  }
});

test("library normalization rejects duplicate IDs, unknown selections and invalid templates", () => {
  const entry = { id: "test", profile: profile("First") };
  for (const value of [ { version: 1, activeId: "test", schedules: [entry, entry] },
    { version: 1, activeId: "missing", schedules: [entry] },
    { version: 1, activeId: undefined, schedules: [{ ...entry, id: undefined }] },
    { version: 1, activeId: 7, schedules: [{ ...entry, id: 7 }] },
    false,
    { version: 1, activeId: "test", schedules: [{ ...entry, profile: {} }] }]) assert.throws(() => C.normalizeLibrary(value));
  assert.deepEqual(C.normalizeLibrary(null), { version: 1, activeId: null, schedules: [] });
});
