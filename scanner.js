globalThis.scanFacebookComments = async (runId, account, requestedPost) => {
  const {facebookUrl, accountLink, postKeys, postUrl} = globalThis.facebookIdentity;
  const rows = new Map();
  const rowKeys = new WeakMap();
  const branchKeys = new WeakMap();
  const unopened = new Set();
  const warnings = new Set();
  const controlAttempts = new WeakMap();
  const threadAttempts = new Map();
  const repliesPerThread = new Map();
  const knownPost = new Set(postKeys(requestedPost));
  const rowSelector = '[role="article"], article, [aria-label^="Comment by " i], [aria-label^="Reply by " i], [aria-label^="نظر "], [aria-label^="پاسخ "]';
  const controls = 'button, [role="button"], [role="combobox"], [role="menuitem"], [role="menuitemradio"], [role="option"], [tabindex="0"], a[href="#"]';
  const replyControl = /^(?:(?:view|see|show|load)\s+(?:(?:all|\d[\d,.]*|more|previous|earlier|other|\S+’s|\S+'s)\s+)*(?:reply|replies)(?:\s+.*)?|\d[\d,.]*\s+repl(?:y|ies)|(?:مشاهده|نمایش|دیدن|بارگیری)\s+.*پاسخ.*)$/i;
  const moreControl = /^(?:(?:view|see|show|load)\s+(?:(?:\d[\d,.]*|more|previous|earlier|older|other|all)\s+)+comments?|(?:مشاهده|نمایش|دیدن|بارگیری)\s+.*(?:نظر|دیدگاه|کامنت).*)$/i;
  const allComments = /^(?:all comments|همه[ٔ‌ی\s]*\s*(?:نظرها|نظرات|دیدگاه‌ها|کامنت‌ها))$/i;
  const sort = /^(?:most relevant|newest(?: first)?|oldest(?: first)?|most recent|مرتبط‌ترین|بیشترین ارتباط|جدیدترین|قدیمی‌ترین)(?:\s+(?:comments|نظرها|نظرات))?$/i;
  const commentsTab = /^(?:comments|نظرها|نظرات|دیدگاه‌ها|کامنت‌ها)$/i;
  const digits = value => value.replace(/[۰-۹٠-٩]/g, digit => String(digit.charCodeAt(0) & 15));
  const clean = value => (value ?? "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  const visible = element => element.getClientRects().length && getComputedStyle(element).visibility === "visible";
  const normalizedName = value => clean(value).normalize("NFKC").toLowerCase();
  const displayName = normalizedName(account.displayName);
  const controlText = element => [
    element.getAttribute("aria-label"), element.innerText, element.innerText?.split("\n")[0]
  ].map(value => digits(clean(value))).filter(Boolean);
  const controlMatches = (element, pattern) => controlText(element).some(value => pattern.test(value));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const enabled = element => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true";
  const started = Date.now();
  const initialPage = location.pathname + location.search;
  let selectedAll = false;
  let root;
  let lastRow;
  let lastProgress = 0;
  let pendingPages = 0;
  let lastBranchAction;
  let nextBranch = 0;
  let repliesSeen = 0;
  let commentsSeen = 0;

  globalThis.facebookScanControl = {runId, stopped: false};
  const stopped = () => globalThis.facebookScanControl?.runId !== runId || globalThis.facebookScanControl.stopped;

  function classify(element) {
    const title = clean(element.getAttribute("aria-label"));
    if (/^(?:reply by\s+|پاسخ\s+(?:از\s+)?)/i.test(title)) return "reply";
    if (/^(?:comment by\s+|نظر\s+(?:از\s+)?)/i.test(title)) return "comment";
    return "";
  }

  function owned(row, selector) {
    return [...row.querySelectorAll(selector)].filter(node => node.closest(rowSelector) === row);
  }

  function links(row) {
    return owned(row, "a[href]").filter(visible);
  }

  function permalink(anchors) {
    let alternative = null;
    for (const anchor of anchors) {
      const url = facebookUrl(anchor.href);
      if (url && postUrl(url.href) &&
          (url.searchParams.has("comment_id") || url.searchParams.has("reply_comment_id"))) {
        if (postMatches(url)) return url;
        alternative ??= url;
      }
    }
    return alternative;
  }

  function postMatches(url) {
    const keys = url ? postKeys(url.href) : [];
    return !knownPost.size || !keys.length || keys.some(key => knownPost.has(key));
  }

  function accountKeys(anchor) {
    const profile = accountLink(anchor.href);
    if (!profile) return null;
    const hover = anchor.getAttribute("data-hovercard");
    if (!profile.id && hover?.startsWith("/ajax/hovercard/")) {
      const id = facebookUrl(hover)?.searchParams.get("id");
      if (id && /^\d+$/.test(id)) profile.id = id;
    }
    return profile;
  }

  function authorDetails(row, anchors, type) {
    const title = clean(row.getAttribute("aria-label"));
    const byline = type ? title
      .replace(/^(?:comment by\s+|reply by\s+|نظر\s+(?:از\s+)?|پاسخ\s+(?:از\s+)?)/i, "")
      .replace(/\s+(?:\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago|just now|yesterday)$/i, "") : "";
    const profiles = anchors.filter(anchor => accountKeys(anchor) && clean(anchor.innerText));
    const author = byline ? profiles.find(anchor => {
      const name = normalizedName(anchor.innerText);
      const announced = normalizedName(byline);
      return announced === name || (type === "reply" && announced.startsWith(`${name} to `));
    }) ?? profiles.find(anchor => facebookUrl(anchor.href)?.searchParams.has("comment_id")) : profiles[0];
    const fallbackName = type === "reply" ? byline.replace(/\s+to\s+.+[’']s\s+comment$/i, "") : byline;
    const authorUrl = author && facebookUrl(author.href);
    for (const key of ["comment_id", "reply_comment_id", "__tn__"]) authorUrl?.searchParams.delete(key);
    return {author, name: clean(author?.innerText) || fallbackName, authorUrl: authorUrl?.href};
  }

  function container() {
    const main = document.querySelector('main, [role="main"]');
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const regions = [...dialogs, main].filter(Boolean);
    for (const region of regions) {
      const entries = [...region.querySelectorAll(rowSelector)].filter(element =>
        visible(element) && (classify(element) || permalink(links(element))) &&
        postMatches(permalink(links(element))));
      if (entries.length && region !== main) return region;
      if (entries.length) {
        const outer = entries[0].parentElement?.closest(rowSelector);
        if (outer && !classify(outer) && entries.every(row => outer.contains(row))) return outer;
        return main;
      }
    }
    return dialogs.find(dialog => [...dialog.querySelectorAll(controls)].some(element =>
      enabled(element) && (controlMatches(element, moreControl) || controlMatches(element, sort)))) ?? main;
  }

  function collect() {
    const mounted = new Set();
    if (!root?.isConnected) return mounted;
    for (const row of root.querySelectorAll(rowSelector)) {
      if (!visible(row)) continue;
      const anchors = links(row);
      const url = permalink(anchors);
      const declaredType = classify(row);
      if ((!declaredType && !url) || !postMatches(url)) continue;
      lastRow = row;
      const replyId = url?.searchParams.get("reply_comment_id");
      const commentId = url?.searchParams.get("comment_id");
      const parent = row.parentElement?.closest(rowSelector);
      const nested = parent && root.contains(parent) && parent !== root &&
        (classify(parent) || permalink(links(parent)));
      const type = replyId || nested ? "reply" : declaredType || "comment";
      const {author, name, authorUrl} = authorDetails(row, anchors, declaredType);
      const profile = author ? accountKeys(author) : null;
      const content = owned(row, '[dir="auto"]').filter(element =>
        visible(element) && clean(element.innerText) && !element.closest(controls) &&
        !element.closest("a") && (!author || Boolean(author.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)));
      const text = content.filter(element => !content.some(other => other !== element && element.contains(other)))
        .map(element => element.innerText.trim()).join("\n");
      const parentUrl = nested ? permalink(links(parent)) : null;
      const parentId = type === "reply" ? (replyId ? commentId : parentUrl?.searchParams.get("comment_id")) : null;
      const parentKey = type === "reply" && nested ? rowKeys.get(parent) : null;
      const id = replyId || commentId;
      const fingerprint = [type, parentId, profile?.id ?? profile?.name ?? name, text, url?.href].join("\u001f");
      const key = id ? `id:${id}` : `text:${fingerprint}`;
      if (!id) warnings.add("Some entries lacked direct links. Identical entries may have been counted once.");
      const previous = rows.get(key);
      if (!previous) {
        if (type === "reply") repliesSeen++;
        else commentsSeen++;
      }
      const thread = type === "reply" && (parentKey || (parentId && `id:${parentId}`));
      if (thread && !previous?.thread) repliesPerThread.set(thread, (repliesPerThread.get(thread) ?? 0) + 1);
      rowKeys.set(row, key);
      mounted.add(key);
      rows.set(key, {
        type, name: name || previous?.name, profile: profile ?? previous?.profile, text: text || previous?.text || "",
        authorUrl: authorUrl || previous?.authorUrl,
        url: url?.href || previous?.url, parentId: parentId || previous?.parentId,
        thread: previous?.thread || thread,
        parentKey: parentKey || previous?.parentKey,
        parentUrl: parentUrl?.href || (replyId && commentId ? withoutReply(url) : previous?.parentUrl)
      });
    }
    return mounted;
  }

  function withoutReply(url) {
    const parent = new URL(url.href);
    parent.searchParams.delete("reply_comment_id");
    return parent.href;
  }

  function withParent(row) {
    if (row.type !== "reply") return row;
    const parent = rows.get(row.parentKey) ?? (row.parentId && rows.get(`id:${row.parentId}`));
    return {...row, parentName: parent?.name, parentText: parent?.text,
      parentUrl: parent?.url || row.parentUrl};
  }

  function report(outcome = "running") {
    const totals = {comment: 0, reply: 0, unknownIdentity: 0, unknownName: 0};
    const matches = [];
    const nameMatches = [];
    for (const row of rows.values()) {
      totals[row.type]++;
      const profile = row.profile;
      if (profile && ((account.id && account.id === profile.id) ||
                      ((!account.id || !profile.id) && account.name && account.name === profile.name))) {
        matches.push(withParent(row));
      } else {
        if ((account.id || account.name) && !((account.id && profile?.id) || (account.name && profile?.name))) {
          totals.unknownIdentity++;
        }
        if (displayName && !row.name) totals.unknownName++;
        if (displayName && normalizedName(row.name) === displayName) nameMatches.push(withParent(row));
      }
    }
    return {totals, matches, nameMatches, warnings: [...warnings], selectedAll,
      coverage: {outcome, unopenedBranches: unopened.size, pendingPages,
        elapsedMs: Date.now() - started, actions}};
  }

  function publish() {
    if (Date.now() - lastProgress < 1000) return;
    lastProgress = Date.now();
    chrome.runtime.sendMessage({kind: "report", runId, result: report()}).catch(() => {});
  }

  function candidates() {
    return root ? [...root.querySelectorAll(controls)].filter(enabled) : [];
  }

  function observeControls(mounted) {
    const visibleControls = [...root.querySelectorAll(controls)].filter(visible);
    const replyButtons = visibleControls.filter(element => controlMatches(element, replyControl));
    const pageButtons = visibleControls.filter(element => controlMatches(element, moreControl) && !replyButtons.includes(element));
    const innermost = buttons => buttons.filter(element =>
      !buttons.some(other => other !== element && element.contains(other)));
    const branches = innermost(replyButtons);
    const pages = innermost(pageButtons);
    const keys = new Map();
    for (const element of branches) {
      const owner = rowKeys.get(element.closest(rowSelector));
      if (!owner && !branchKeys.has(element)) branchKeys.set(element, `control:${++nextBranch}`);
      keys.set(element, owner || branchKeys.get(element));
    }
    const active = new Set(keys.values());
    for (const key of mounted) if (!active.has(key)) unopened.delete(key);
    if (lastBranchAction && !active.has(lastBranchAction.key) && repliesSeen > lastBranchAction.before) {
      unopened.delete(lastBranchAction.key);
    }
    for (const key of active) unopened.add(key);
    pendingPages = pages.length;
    return {pending: [...branches, ...pages].filter(enabled), keys};
  }

  function chooseAction(pending, keys, pane) {
    let retry;
    for (const element of pending) {
      if (!inPane(element, pane)) continue;
      const branch = keys.get(element);
      const knownThread = branch && rows.has(branch);
      const history = knownThread ? threadAttempts : controlAttempts;
      const key = knownThread ? branch : element;
      const progress = knownThread ? repliesPerThread.get(branch) ?? 0 : branch ? 0 : commentsSeen;
      const label = controlText(element).join("|");
      const previous = history.get(key);
      const times = previous?.progress === progress && previous.label === label ? previous.times : 0;
      const action = {element, branch, history, key, progress, label, times};
      if (!times) return action;
      if (times === 1) retry ??= action;
    }
    return retry;
  }

  function sortControls() {
    for (let region = root; region && region !== document.body; region = region.parentElement) {
      const found = [...region.querySelectorAll(controls)].filter(element =>
        enabled(element) && (controlMatches(element, allComments) || controlMatches(element, sort)));
      const innermost = found.filter(element => !found.some(other => other !== element && element.contains(other)));
      if (innermost.length) return innermost;
    }
    return [];
  }

  async function chooseAll() {
    const list = sortControls();
    if (list.length !== 1) return false;
    const [trigger] = list;
    if (controlMatches(trigger, allComments)) return true;
    const previous = new Set([...document.querySelectorAll(controls)].filter(enabled));
    trigger.click();
    for (let attempt = 0; attempt < 8 && !stopped(); attempt++) {
      await pause(250);
      const options = [...document.querySelectorAll(controls)].filter(element =>
        !previous.has(element) && enabled(element) && controlMatches(element, allComments));
      const option = options.find(element => !options.some(other => other !== element && element.contains(other)));
      if (option) {
        option.click();
        await pause(1300);
        return sortControls().some(element => controlMatches(element, allComments));
      }
    }
    if (trigger.getAttribute("aria-expanded") === "true") trigger.click();
    return false;
  }

  function scrollPane() {
    const from = lastRow?.isConnected && root.contains(lastRow) ? lastRow.parentElement : root;
    for (let element = from; element && element !== document.body; element = element.parentElement) {
      if (element.clientHeight >= 100 && element.scrollHeight > element.clientHeight &&
          /auto|scroll/.test(getComputedStyle(element).overflowY)) return element;
    }
    return document.scrollingElement;
  }

  function scrollForward(pane) {
    if (!pane || pane.scrollTop + pane.clientHeight + 3 >= pane.scrollHeight) return false;
    const before = pane.scrollTop;
    pane.scrollTop += Math.floor(pane.clientHeight * 0.75);
    return pane.scrollTop > before;
  }

  function inPane(element, pane) {
    if (!pane || pane === document.scrollingElement || !pane.contains(element)) return true;
    const bounds = pane.getBoundingClientRect();
    const item = element.getBoundingClientRect();
    return item.bottom > bounds.top && item.top < bounds.bottom;
  }

  const isLogin = () => /^\/(?:login(?:\.php)?|checkpoint)(?:\/|$)/.test(location.pathname) ||
    Boolean(document.querySelector('form[action*="/login"] input[type="password"]'));
  if (isLogin()) return {error: "Sign in to Facebook in the post tab and run the scan again."};

  const resolved = postUrl(location.href) && postKeys(location.href);
  if (!resolved?.length) return {error: "The page did not resolve to a single post. Enter a direct post URL."};
  for (const url of [location.href, document.querySelector('link[rel="canonical"]')?.href,
    document.querySelector('meta[property="og:url"]')?.content]) {
    if (url && postUrl(url)) for (const key of postKeys(url)) knownPost.add(key);
  }

  let openedCommentsTab = false;
  for (let attempt = 0; attempt < 28 && !stopped(); attempt++) {
    root = container();
    if (!openedCommentsTab && /^\/(?:watch|reel)(?:\/|$)|\/videos\//i.test(location.pathname)) {
      const tabs = [...document.querySelectorAll('[role="tab"]')].filter(element =>
        enabled(element) && controlMatches(element, commentsTab));
      if (tabs.length === 1) {
        openedCommentsTab = true;
        if (tabs[0].getAttribute("aria-selected") !== "true") {
          tabs[0].click();
          await pause(650);
          continue;
        }
      }
    }
    if (root && (root.querySelector('[aria-label^="Comment by " i], [aria-label^="Reply by " i], a[href*="comment_id="]') ||
      candidates().some(element => controlMatches(element, sort) || controlMatches(element, allComments) ||
        controlMatches(element, moreControl)))) break;
    await pause(400);
  }
  if (!root || isLogin()) return {error: "Could not find the comments section. Check your access to the post and your Facebook session."};
  selectedAll = await chooseAll();
  root = container() ?? root;

  let idle = 0;
  let actions = 0;
  let pageLost = false;
  while (!stopped() && idle < 4 && actions < 1800 && Date.now() - started < 25 * 60_000) {
    const currentPage = location.pathname + location.search;
    if (currentPage !== initialPage && !postKeys(location.href).some(key => knownPost.has(key))) {
      warnings.add("The post tab navigated during the scan.");
      pageLost = true;
      break;
    }
    if (!root?.isConnected) root = container();
    if (!root) break;
    const previousCount = rows.size;
    const {pending, keys} = observeControls(collect());
    publish();
    const pane = scrollPane();
    const action = chooseAction(pending, keys, pane);
    if (action) {
      const {element, branch, history, key, progress, label, times} = action;
      lastBranchAction = branch ? {key: branch, before: repliesSeen} : null;
      history.set(key, {progress, label, times: times + 1});
      actions++;
      element.scrollIntoView({block: "nearest"});
      element.click();
      await pause(times === 0 ? 650 : 1300);
      idle = 0;
    } else {
      const moved = scrollForward(pane);
      idle = moved || previousCount !== rows.size ? 0 : idle + 1;
      await pause(700);
    }
  }
  if (!pageLost && root?.isConnected) observeControls(collect());
  const limited = actions >= 1800 || Date.now() - started >= 25 * 60_000;
  if (stopped()) warnings.add("Scan stopped. Findings are partial.");
  if (limited) warnings.add("The scan reached its time or action limit.");
  if (!rows.size) warnings.add("No comment entries could be detected. Check post access and the comments panel.");
  const partial = pageLost || !root?.isConnected || !rows.size || !selectedAll || unopened.size || pendingPages;
  return report(stopped() ? "stopped" : limited ? "limited" : partial ? "partial" : "complete");
};
