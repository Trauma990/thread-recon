importScripts("identity.js");

const identity = globalThis.facebookIdentity;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const panel = () => chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(console.error);
chrome.runtime.onInstalled.addListener(panel);
chrome.runtime.onStartup.addListener(panel);

let pendingUpdate = Promise.resolve();
function update(mutator) {
  const operation = pendingUpdate.then(async () => {
    const {scan} = await chrome.storage.session.get("scan");
    const next = mutator(scan);
    if (next) await chrome.storage.session.set({scan: next});
    return next;
  });
  pendingUpdate = operation.catch(console.error);
  return operation;
}

function change(id, edits) {
  return update(scan => scan?.id === id && scan.running ? {...scan, ...edits} : null);
}

async function openPost(post, windowId) {
  const keys = identity.postKeys(post);
  const tabs = await chrome.tabs.query({windowId});
  const matches = tabs.filter(tab => {
    const candidate = tab.url && identity.postUrl(tab.url);
    return candidate && (candidate === post || identity.postKeys(candidate).some(key => keys.includes(key)));
  });
  const existing = matches.find(tab => tab.active) ?? matches[0];
  return existing ? chrome.tabs.update(existing.id, {active: true}) : chrome.tabs.create({windowId, url: post});
}

async function start(message) {
  const mode = message.mode === "page" ? "page" : "post";
  const post = mode === "page" ? identity.pageUrl(message.post) : identity.postUrl(message.post);
  const accounts = identity.targets(message.account);
  const limit = Number(message.limit ?? 10);
  if (!post || !accounts.length || !Number.isInteger(message.windowId) ||
      (mode === "page" && (!Number.isInteger(limit) || limit < 1 || limit > 100))) {
    return {error: "Check the Facebook URL, the post limit, and the list of accounts."};
  }
  const id = crypto.randomUUID();
  const claimed = await update(scan => scan?.running ? null : {
    id, post, mode, limit, account: message.account, running: true, phase: "opening",
    bulk: accounts.length > 10, notify: message.notify === true
  });
  if (!claimed) return {error: "A scan is already running."};
  await chrome.action.setBadgeText({text: ""});
  try {
    const targets = claimed.bulk ? accounts : [];
    if (!claimed.bulk) {
      for (let i = 0; i < accounts.length; i += 3) {
        const current = (await chrome.storage.session.get("scan")).scan;
        if (current?.id !== id || !current.running) return {ok: true};
        targets.push(...await Promise.all(accounts.slice(i, i + 3).map(aliases)));
      }
    }
    const opening = (await chrome.storage.session.get("scan")).scan;
    if (opening?.id !== id || !opening.running) return {ok: true};
    const tab = mode === "page" ? await chrome.tabs.create({windowId: message.windowId, url: post}) :
      await openPost(post, message.windowId);
    await ready(tab.id);
    if (mode === "page") {
      await discoverPage(id, tab.id, post, limit, targets);
    } else {
      await launchPost(id, tab.id, post, targets, 25 * 60_000);
    }
  } catch {
    await change(id, {running: false, error: "Could not access the post tab. Check that the post opens in Facebook."});
  }
  return {ok: true};
}

async function discoverPage(id, tabId, page, limit, targets) {
  const current = await change(id, {tabId, stepId: id, workTabId: tabId, phase: "discovering", targets});
  if (!current) return;
  const target = {tabId};
  await chrome.scripting.executeScript({target, files: ["identity.js", "activity.js"]});
  const scan = (await chrome.storage.session.get("scan")).scan;
  if (scan?.id !== id || !scan.running) return;
  if (scan.stopping) {
    await change(id, {running: false, error: "Scan stopped during post discovery."});
    return;
  }
  await chrome.scripting.executeScript({
    target, args: [id, page, limit],
    func: (runId, url, count) => {
      globalThis.discoverFacebookPosts(url, count, runId).then(
        result => chrome.runtime.sendMessage({kind: "discovered", runId, result}),
        () => chrome.runtime.sendMessage({kind: "discovered", runId, result: {posts: [], outcome: "unavailable"}})
      ).catch(() => {});
    }
  });
  const latest = (await chrome.storage.session.get("scan")).scan;
  if (latest?.id === id && latest.stopping) await stopScript(latest);
}

async function launchPost(id, tabId, post, targets, maxMs) {
  const stepId = crypto.randomUUID();
  const current = await change(id, {tabId, stepId, phase: "scanning"});
  if (!current) return;
  const target = {tabId};
  await chrome.scripting.executeScript({target, files: ["identity.js", "activity.js", "scanner.js"]});
  const scan = (await chrome.storage.session.get("scan")).scan;
  if (scan?.stepId !== stepId || !scan.running) return;
  await chrome.scripting.executeScript({
    target, args: [stepId, targets, post, maxMs],
    func: (runId, targets, url, timeout) => {
      globalThis.scanFacebookComments(runId, targets, url, timeout).then(
        result => chrome.runtime.sendMessage({kind: "report", runId, result, final: true}),
        () => chrome.runtime.sendMessage({kind: "report", runId, final: true,
          result: {error: "The scan could not continue on this post."}})
      ).catch(() => {});
    }
  });
  const latest = (await chrome.storage.session.get("scan")).scan;
  if (latest?.stepId === stepId && latest.stopping) await stopScript(latest);
}

async function acceptPosts(message, tabId) {
  const scan = await update(current => {
    if (!current?.running || current.phase !== "discovering" ||
        current.stepId !== message.runId || current.tabId !== tabId) return null;
    if (current.stopping || message.result.outcome === "stopped") {
      return {...current, running: false, error: "Scan stopped during post discovery."};
    }
    const posts = message.result.posts.slice(0, current.limit).map(identity.postUrl).filter(Boolean);
    if (!posts.length) return {...current, running: false, error: "No posts from this page could be discovered. Check the page URL, access, and Posts feed."};
    return {...current, tabId: null, phase: "opening", batch: {posts, index: 0, entries: [], discovery: message.result.outcome}};
  });
  if (scan?.running) await nextPost(scan);
}

async function nextPost(scan) {
  const {id, workTabId, batch, targets} = scan;
  const post = batch.posts[batch.index];
  try {
    const active = (await chrome.storage.session.get("scan")).scan;
    if (active?.id !== id || !active.running) return;
    await chrome.tabs.update(workTabId, {url: post});
    await ready(workTabId);
    await launchPost(id, workTabId, post, targets, 4 * 60_000);
  } catch {
    const stepId = crypto.randomUUID();
    const current = await change(id, {tabId: workTabId, stepId});
    if (current) await saveReport({runId: stepId, final: true, result: {error: "Could not open this post."}}, workTabId);
  }
}

function stopScript(scan) {
  return chrome.scripting.executeScript({
    target: {tabId: scan.tabId}, args: [scan.stepId],
    func: runId => {
      if (globalThis.facebookScanControl?.runId === runId) globalThis.facebookScanControl.stopped = true;
    }
  });
}

async function stop(id) {
  const scan = await update(current => {
    if (!current?.running || current.id !== id) return null;
    if (current.tabId) return {...current, stopping: true};
    return {...current, running: false, error: "Scan stopped."};
  });
  if (scan?.tabId && scan.running) {
    await stopScript(scan).catch(() => change(id, {running: false, error: "The post tab is no longer available."}));
  }
  return {ok: true};
}

function combined(base, result) {
  if (!base) return result;
  if (!result) return base;
  const sum = (a, b, fields) => Object.fromEntries(fields.map(key => [key, (a[key] ?? 0) + (b[key] ?? 0)]));
  return {
    matches: [...base.matches, ...result.matches], nameMatches: [...base.nameMatches, ...result.nameMatches],
    totals: sum(base.totals, result.totals, ["comment", "reply", "unknownIdentity", "unknownName"]),
    selectedAll: base.selectedAll && result.selectedAll,
    warnings: [...new Set([...base.warnings, ...result.warnings])],
    coverage: {...sum(base.coverage, result.coverage, ["unopenedBranches", "pendingPages", "pendingText", "elapsedMs", "actions", "reactionProfiles"]),
      outcome: base.coverage.outcome === "complete" ? result.coverage.outcome : "partial"}
  };
}

async function saveReport(message, tabId) {
  let first = false;
  let advance = false;
  const result = message.result;
  const scan = await update(current => {
    if (!current?.running || current.stepId !== message.runId || current.tabId !== tabId) return null;
    const batch = current.batch;
    const evidence = result.error ? current.result : combined(batch?.base, result);
    const count = (evidence?.matches.length ?? 0) + (evidence?.nameMatches.length ?? 0);
    first = count > 0 && !current.found;
    const next = {...current, running: !message.final, result: evidence,
      error: batch ? undefined : result.error, found: count};
    if (batch && message.final) {
      const entry = {post: batch.posts[batch.index], error: result.error, coverage: result.coverage};
      const entries = [...batch.entries, entry];
      advance = !current.stopping && batch.index + 1 < batch.posts.length;
      const outcome = current.stopping ? "stopped" : entries.some(item =>
        item.error || item.coverage?.outcome !== "complete" || item.coverage.reactions !== "checked" ||
        item.coverage.postMentions !== "checked") ? "partial" : "complete";
      if (!advance && evidence) next.result = {...evidence, coverage: {...evidence.coverage, outcome}};
      if (!advance && !evidence) next.error = "None of the discovered posts could be scanned.";
      Object.assign(next, {running: advance, tabId: null, phase: advance ? "opening" : "done",
        batch: {...batch, index: advance ? batch.index + 1 : batch.index, entries, base: advance ? evidence : undefined}});
    }
    return next;
  });
  const count = scan?.found;
  if (count) {
    await chrome.action.setBadgeText({text: count > 99 ? "99+" : String(count)}).catch(() => {});
    if (first && scan.notify) {
      await chrome.notifications.create(`found-${scan.id}`, {
        type: "basic", iconUrl: chrome.runtime.getURL("icon-128.png"),
        title: "Thread Recon — Match found",
        message: "Open the side panel to review the first match."
      }).catch(() => {});
    }
  }
  if (scan && advance) await nextPost(scan);
}

function interrupted(tabId, removed = false) {
  update(scan => scan?.running && (scan.tabId === tabId || (removed && scan.workTabId === tabId)) ? {
    ...scan, running: false, error: "The post tab closed or reloaded. Partial findings are still in the panel."
  } : null).catch(console.error);
}
chrome.tabs.onRemoved.addListener(tabId => interrupted(tabId, true));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") interrupted(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  let work;
  if (message.kind === "report" && sender.tab && identity.facebookUrl(sender.url)) {
    work = saveReport(message, sender.tab.id);
  } else if (message.kind === "discovered" && sender.tab && identity.facebookUrl(sender.url)) {
    work = acceptPosts(message, sender.tab.id);
  } else if (sender.url === chrome.runtime.getURL("index.html")) {
    if (message.kind === "start") work = start(message);
    if (message.kind === "stop") work = stop(message.runId);
  }
  if (!work) return;
  work.then(reply, () => reply({error: "Extension connection lost. Try again."}));
  return true;
});

async function ready(tabId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && !tab.pendingUrl && tab.url && tab.url !== "about:blank") return tab;
    await wait(250);
  }
  throw new Error("The page took too long to load. Check your connection and try again.");
}

async function aliases(account) {
  if (!account.id && !account.name) return account;
  let tab;
  try {
    tab = await chrome.tabs.create({url: identity.profileUrl(account), active: false});
    const loaded = await ready(tab.id, 9000);
    if (!identity.accountLink(loaded.url)) return account;
    const [result] = await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: () => ({
        urls: [location.href, document.querySelector('link[rel="canonical"]')?.href,
          document.querySelector('meta[property="og:url"]')?.content],
        profileId: document.querySelector('meta[property="fb:profile_id"]')?.content,
        appUrls: [...document.querySelectorAll('meta[property="al:android:url"], meta[property="al:ios:url"]')]
          .map(tag => tag.content)
      })
    });
    const {urls, profileId, appUrls} = result.result;
    const links = urls.filter(Boolean).map(identity.accountLink).filter(Boolean);
    if (!links.some(link => (account.id && link.id === account.id) ||
                            (account.name && link.name === account.name))) return account;
    const ids = new Set(links.map(link => link.id).filter(Boolean));
    const names = new Set(links.map(link => link.name).filter(Boolean));
    for (const value of [profileId, ...appUrls.map(url => /^fb:\/\/(?:profile|page)\/(\d+)(?:[/?#]|$)/.exec(url)?.[1])]) {
      if (value && /^\d+$/.test(value)) ids.add(value);
    }
    if (account.id) ids.add(account.id);
    if (account.name) names.add(account.name);
    return {...account, id: ids.size === 1 ? [...ids][0] : account.id, name: names.size === 1 ? [...names][0] : account.name};
  } catch {
    return account;
  } finally {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
