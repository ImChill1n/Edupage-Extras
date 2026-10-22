const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const C = require("../scripts/lib/ee-timetable-comparison.js");

function background() {
  const state = { created: [], removed: [], calls: [], fail: false, revision: null, afterRead: null, enabled: true };
  let id = 0;
  const context = { EEComparison: C, __EE_TEST__: true, URL, Date, Map, Promise, setTimeout, clearTimeout,
    LAST_EDUPAGE_ORIGIN_KEY: "origin", storageGet: async () => ({ origin: "https://example.edupage.org", [C.ENABLED_KEY]: state.enabled }),
    createTab: async (url) => { const tab = { id: ++id }; state.created.push({ url, ...tab }); return tab; },
    removeTab: async (tabId) => { state.removed.push(tabId); }, waitForTabComplete: async () => {},
    sendTabMessageRetry: async (tabId, message) => {
      state.calls.push({ tabId, ...message });
      if (state.fail) throw new Error("secret server response");
      const result = message.type === "ee-comparison-classes" ? { classes: [{ id: "Class B", label: "Class B" }] }
        : { classLabel: message.ownerId, dayHeaders: [{ date: message.weekStart }], lessons: [
          { title: "Synthetic lesson", date: message.weekStart, startTime: "08:00", endTime: "08:45", teacher: "not retained", group: "Group A" },
        ] };
      if (state.afterRead) await state.afterRead(result);
      return { ok: true, data: result };
    },
    chrome: { runtime: { id: "extension", getURL: (suffix) => `chrome-extension://extension/${suffix}`, onMessage: { addListener: (fn) => { state.listener = fn; } } },
      storage: { onChanged: { addListener: (fn) => { state.revision = fn; } } } },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../scripts/timetable-comparison-background.js"), "utf8"), context);
  return { state, api: context.__eeComparisonBackgroundTest };
}
const sender = { id: "extension", frameId: 0, url: "https://example.edupage.org/dashboard/eb.php" };
const request = (ownerId = "self", fields = {}) => ({ type: "ee-comparison-week", ownerId, weekStart: "2026-10-19", ...fields });

test("live cache isolates owner, school and week, strips metadata and closes every hidden tab", async () => {
  const { state, api } = background();
  const first = await api.request(request(), sender);
  assert.equal(first.data.lessons[0].teacher, undefined);
  await api.request(request(), sender);
  assert.equal(state.created.length, 1);
  await api.request(request("Class B"), sender);
  await api.request(request("self", { weekStart: "2026-10-26" }), sender);
  await api.request(request(), { ...sender, url: "https://different.edupage.org/" });
  assert.equal(state.created.length, 4);
  assert.deepEqual(state.removed, [1, 2, 3, 4]);
  assert.ok(state.created.every((tab) => new URL(tab.url).searchParams.get("eeComparison") === "1"));
});

test("failed refresh never replaces cached data and always closes its tab", async () => {
  const { state, api } = background();
  const first = await api.request(request(), sender);
  state.fail = true;
  await assert.rejects(api.request(request("self", { force: true }), sender));
  assert.equal((await api.request(request(), sender)).fetchedAt, first.fetchedAt);
  assert.deepEqual(state.removed, [1, 2]);
});

test("comparison removal clears cache and prevents in-flight reads repopulating it", async () => {
  const { state, api } = background();
  await api.request(request(), sender);
  state.revision({ [C.KEY]: { newValue: undefined } }, "local");
  assert.equal(api.cache.size, 0);
  state.afterRead = async () => state.revision({ [C.KEY]: {} }, "local");
  await api.request(request("Class B"), sender);
  assert.equal(api.cache.size, 0);
});

test("live reads reject foreign origins, subframes, spoofed extension IDs and invalid weeks", async () => {
  const { state, api } = background();
  for (const invalid of [{ ...sender, url: "https://attacker.example" }, { ...sender, frameId: 1 }, { ...sender, id: "other" }]) {
    await assert.rejects(api.request(request(), invalid));
  }
  await assert.rejects(api.request(request("self", { weekStart: "2026-10-20" }), sender));
  assert.equal(state.created.length, 0);
});

test("mismatched class replies and out-of-week lesson dates cannot enter the cache", async () => {
  for (const change of [data => { data.classLabel = "Wrong class"; }, data => { data.lessons[0].date = "2026-10-26"; }]) {
    const { state, api } = background();
    state.afterRead = change;
    await assert.rejects(api.request(request("Class B"), sender));
    assert.equal(api.cache.size, 0);
    assert.deepEqual(state.removed, [1]);
  }
});

test("settings can list classes using the remembered school and responses redact failure details", async () => {
  const { state, api } = background();
  const result = await api.request({ type: "ee-comparison-classes" }, { id: "extension", url: "chrome-extension://extension/menu/settings.html" });
  assert.equal(result.data.classes.length, 1);
  state.fail = true;
  const response = await new Promise(resolve => state.listener(request(), sender, resolve));
  assert.equal(response.error, "eeCompareLiveUnavailable");
  assert.equal(JSON.stringify(response).includes("secret"), false);
});


test("disabled comparison refuses live reads without opening tabs", async () => {
  const { state, api } = background();
  state.enabled = false;
  await assert.rejects(api.request(request(), sender), { message: "eeCompareDisabled" });
  assert.equal(state.created.length, 0);
});

test("switching off closes an active temporary tab before its read finishes", async () => {
  const { state, api } = background();
  let entered;
  let resume;
  const reading = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { resume = resolve; });
  state.afterRead = async () => { entered(); await blocked; };
  const job = api.request(request(), sender);
  await reading;
  state.enabled = false;
  state.revision({ [C.ENABLED_KEY]: { newValue: false } }, "local");
  assert.deepEqual(state.removed, [1]);
  resume();
  await job;
  assert.equal(api.cache.size, 0);
  assert.deepEqual(state.removed, [1]);
});
