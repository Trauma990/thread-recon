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
  const post = identity.postUrl(message.post);
  const account = identity.target(message.account);
  if (!post || !account || !Number.isInteger(message.windowId)) {
    return {error: "Check the post URL and the account or display name."};
  }
  const id = crypto.randomUUID();
  const claimed = await update(scan => scan?.running ? null : {
    id, post, account: message.account, running: true, phase: "opening", notify: message.notify === true
  });
  if (!claimed) return {error: "A scan is already running."};
  await chrome.action.setBadgeText({text: ""});
  try {
    const target = await aliases(account);
    const opening = (await chrome.storage.session.get("scan")).scan;
    if (opening?.id !== id || !opening.running) return {ok: true};
    const tab = await openPost(post, message.windowId);
    await ready(tab.id);
    const current = await change(id, {tabId: tab.id, phase: "scanning"});
    if (!current) return {ok: true};
    const destination = {tabId: tab.id};
    await chrome.scripting.executeScript({target: destination, files: ["identity.js", "scanner.js"]});
    const {scan} = await chrome.storage.session.get("scan");
    if (scan?.id !== id || !scan.running) return {ok: true};
    await chrome.scripting.executeScript({
      target: destination, args: [id, target, post],
      func: (runId, target, post) => {
        globalThis.scanFacebookComments(runId, target, post).then(
          result => chrome.runtime.sendMessage({kind: "report", runId, result, final: true}),
          () => chrome.runtime.sendMessage({kind: "report", runId, final: true,
            result: {error: "The scan could not continue on this post."}})
        ).catch(() => {});
      }
    });
    const latest = (await chrome.storage.session.get("scan")).scan;
    if (latest?.id === id && latest.stopping) await stopScript(latest);
  } catch {
    await change(id, {running: false, error: "Could not access the post tab. Check that the post opens in Facebook."});
  }
  return {ok: true};
}

function stopScript(scan) {
  return chrome.scripting.executeScript({
    target: {tabId: scan.tabId}, args: [scan.id],
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

async function saveReport(message, tabId) {
  let first = false;
  const result = message.result;
  const count = (result.matches?.length ?? 0) + (result.nameMatches?.length ?? 0);
  const scan = await update(current => {
    if (!current?.running || current.id !== message.runId || current.tabId !== tabId) return null;
    first = count > 0 && !current.found;
    return {...current, running: !message.final, result: result.error ? current.result : result,
      error: result.error, found: Math.max(current.found ?? 0, count)};
  });
  if (scan && count) {
    await chrome.action.setBadgeText({text: count > 99 ? "99+" : String(count)});
    if (first && scan.notify) {
      await chrome.notifications.create(`found-${scan.id}`, {
        type: "basic", iconUrl: chrome.runtime.getURL("icon-128.png"),
        title: "Thread Recon — Match found",
        message: "Open the side panel to review the first match."
      }).catch(() => {});
    }
  }
}

function interrupted(tabId) {
  update(scan => scan?.running && scan.tabId === tabId ? {
    ...scan, running: false, error: "The post tab closed or reloaded. Partial findings are still in the panel."
  } : null).catch(console.error);
}
chrome.tabs.onRemoved.addListener(interrupted);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") interrupted(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  let work;
  if (message.kind === "report" && sender.tab && identity.facebookUrl(sender.url)) {
    work = saveReport(message, sender.tab.id);
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
    if (tab.status === "complete" && tab.url && tab.url !== "about:blank") return tab;
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
