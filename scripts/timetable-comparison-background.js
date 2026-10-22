(function () {
  "use strict";
  const C = globalThis.EEComparison;
  const cache = new Map();
  const pending = new Map();
  const activeTabs = new Set();
  const TTL = 10 * 60 * 1000;
  let revision = 0;

  function schoolOrigin(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.edupage\.org$/i.test(url.hostname) || url.port || url.username || url.password) throw new Error("eeCompareLiveUnavailable");
    return url.origin;
  }

  async function request(message, sender) {
    const extensionUrl = chrome.runtime.getURL("");
    const fromSettings = sender.url === `${extensionUrl}menu/settings.html`;
    if (sender.id !== chrome.runtime.id || (!fromSettings && sender.frameId !== 0)) throw new Error("eeCompareLiveUnavailable");
    const settings = await storageGet([C.ENABLED_KEY]);
    if (settings[C.ENABLED_KEY] !== true) throw new Error("eeCompareDisabled");
    const origin = fromSettings
      ? schoolOrigin(message.origin || (await storageGet([LAST_EDUPAGE_ORIGIN_KEY]))[LAST_EDUPAGE_ORIGIN_KEY])
      : schoolOrigin(sender.url);
    const isList = message.type === "ee-comparison-classes";
    const ownerId = isList ? "classes" : C.clean(message.ownerId, 100);
    if (!isList && (!ownerId || C.monday(message.weekStart) !== message.weekStart)) throw new Error("eeCompareInvalidDate");
    const key = JSON.stringify([origin, isList ? "list" : "week", ownerId, isList ? "" : message.weekStart]);
    const cached = cache.get(key);
    if (!message.force && cached && Date.now() - cached.fetchedAt < TTL) return { ...cached, origin };
    if (pending.has(key)) return pending.get(key);
    const requestRevision = revision;
    const job = (async () => {
      let tab;
      let timer;
      try {
        const operation = (async () => {
          tab = await createTab(`${origin}/dashboard/eb.php?mode=timetable&eeComparison=1`);
          activeTabs.add(tab.id);
          if (requestRevision !== revision) throw new Error("eeCompareDisabled");
          await waitForTabComplete(tab.id, 20000);
          const response = await sendTabMessageRetry(tab.id, {
            type: isList ? "ee-comparison-classes" : "ee-comparison-read",
            ownerId, weekStart: message.weekStart,
          }, 10);
          if (!response?.ok) throw new Error("eeCompareLiveUnavailable");
          let data;
          if (isList) {
            if (!Array.isArray(response.data?.classes) || response.data.classes.length > 300) throw new Error("eeCompareLiveUnavailable");
            data = { classes: response.data.classes.map((entry) => ({ id: C.clean(entry.id, 100), label: C.clean(entry.label) })).filter((entry) => entry.id && entry.label) };
          } else {
            const raw = response.data;
            if (!Array.isArray(raw?.lessons) || raw.lessons.length > C.MAX_LESSONS || !Array.isArray(raw.dayHeaders)) throw new Error("eeCompareLiveUnavailable");
            const dates = [...new Set(raw.dayHeaders.map((day) => day.date))];
            if (!dates.length || dates.some((date) => !Number.isFinite(C.dayNumber(date)) || C.monday(date) !== message.weekStart)) throw new Error("eeCompareLiveUnavailable");
            if (ownerId !== "self" && raw.classLabel !== ownerId) throw new Error("eeCompareLiveUnavailable");
            const lessons = raw.lessons.map((lesson) => C.normalizeLesson(lesson));
            if (lessons.some((lesson) => !dates.includes(lesson.date))) throw new Error("eeCompareLiveUnavailable");
            data = { lessons, dates };
          }
          const entry = { data, fetchedAt: Date.now(), origin };
          for (const [oldKey, old] of cache) if (Date.now() - old.fetchedAt >= TTL) cache.delete(oldKey);
          if (cache.size >= 24) cache.delete(cache.keys().next().value);
          if (requestRevision === revision) cache.set(key, entry);
          return entry;
        })();
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("eeCompareLiveUnavailable")), 60000);
        })]);
      } finally {
        clearTimeout(timer);
        if (tab?.id && activeTabs.delete(tab.id)) await removeTab(tab.id);
      }
    })();
    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!["ee-comparison-week", "ee-comparison-classes"].includes(message?.type)) return false;
    request(message, sender).then((result) => respond({ ok: true, ...result }))
      .catch((error) => respond({ ok: false, error: error?.message === "eeCompareDisabled" ? "eeCompareDisabled" : "eeCompareLiveUnavailable" }));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[C.KEY] || changes[C.ENABLED_KEY] || changes.eeTimetableSyncCache)) { revision++; cache.clear(); }
    if (area === "local" && ((changes[C.ENABLED_KEY] && changes[C.ENABLED_KEY].newValue !== true)
      || (changes[C.KEY] && !changes[C.KEY].newValue))) {
      for (const tabId of activeTabs) {
        activeTabs.delete(tabId);
        removeTab(tabId).catch(() => {});
      }
    }
  });
  if (globalThis.__EE_TEST__) globalThis.__eeComparisonBackgroundTest = { request, cache, schoolOrigin };
})();
