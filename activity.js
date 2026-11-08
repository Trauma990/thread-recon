(() => {
  const {postUrl, postKeys, accountLink, pageUrl, targetMatcher} = globalThis.facebookIdentity;
  const article = 'article, [role="article"]';
  const headingLink = 'h1 a[href], h2 a[href], h3 a[href], h4 a[href], [role="heading"] a[href], strong a[href]';
  const message = '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]';
  const comment = '[aria-label^="Comment by " i], [aria-label^="Reply by " i], [aria-label^="نظر "], [aria-label^="پاسخ "]';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const shown = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible";
  const text = node => (node.innerText || node.textContent || "").trim();
  const label = node => [node.getAttribute("aria-label"), node.getAttribute("title"), text(node)]
    .filter(Boolean).map(value => value.replace(/[\u200b-\u200f\ufeff]/g, "").trim());
  const buttons = 'button, [role="button"], [role="tab"], a[role="button"]';
  const timestampLink = anchor => anchor.querySelector("time, abbr") ||
    label(anchor).some(value => /^(?:\d+\s*[mhdwy]|yesterday|just now|\d+\s+(?:minutes?|hours?|days?|weeks?) ago)$/i.test(value));
  const reactionTabs = '[role="tab"], [role="tablist"] [aria-pressed], [role="tablist"] [aria-selected]';
  const reactionNames = [
    ["Like", /^(?:like|پسندیدن|لایک)$/i], ["Love", /^(?:love|عاشقانه|عشق)$/i],
    ["Care", /^(?:care|مراقبت|همدلی)$/i], ["Haha", /^(?:haha|خنده)$/i],
    ["Wow", /^(?:wow|تعجب)$/i], ["Sad", /^(?:sad|غمگین|ناراحت)$/i],
    ["Angry", /^(?:angry|عصبانی|خشمگین)$/i]
  ];

  function reactionType(value) {
    const name = value.trim().replace(/^(?:reacted with|reaction:)\s*/i, "")
      .replace(/\s*[:(]?\s*\d[\d,.]*\s*[km]?\s*(?:people)?\s*\)?$/i, "")
      .replace(/\s+reactions?$/i, "").trim();
    return reactionNames.find(([, pattern]) => pattern.test(name))?.[0];
  }

  function sameAccount(a, b) {
    return Boolean((a?.id && a.id === b?.id) || (a?.name && a.name === b?.name));
  }

  globalThis.discoverFacebookPosts = async (page, limit, runId) => {
    globalThis.facebookScanControl = {runId, stopped: false};
    const stopped = () => globalThis.facebookScanControl?.runId !== runId || globalThis.facebookScanControl.stopped;
    const requested = accountLink(page);
    const landed = accountLink(pageUrl(location.href));
    if (!landed) return {posts: [], outcome: "unavailable"};
    const posts = [];
    const known = new Set();
    const accept = value => {
      const url = postUrl(value);
      const keys = url ? postKeys(url) : [];
      if (!keys.length || keys.some(key => known.has(key))) return;
      keys.forEach(key => known.add(key));
      posts.push(url);
    };
    for (let idle = 0, step = 0; idle < 8 && step < 100 && !stopped(); step++) {
      const before = posts.length;
      const feed = document.querySelector('[role="feed"]') ?? document.querySelector('main, [role="main"]');
      const cardSelector = feed?.querySelector(article) ? article : '[data-pagelet^="FeedUnit"]';
      for (const card of feed?.querySelectorAll(cardSelector) ?? []) {
        if (card.closest(comment) || card.parentElement?.closest(cardSelector) || !shown(card)) continue;
        const links = [...card.querySelectorAll("a[href]")].filter(a =>
          a.closest(cardSelector) === card && !a.closest(`${comment}, ${message}`) && shown(a));
        const header = links.find(a => a.matches(headingLink) && accountLink(a.href));
        const author = header && accountLink(header.href);
        const authorMatches = sameAccount(author, landed) || sameAccount(author, requested);
        const candidates = links.filter(a => {
          const url = postUrl(a.href);
          if (!url || !postKeys(url).length) return false;
          if (a.getAttribute("href")?.includes("comment_id=")) return false;
          const path = new URL(url).pathname;
          const owner = path.match(/^\/(.+)\/(?:posts|videos|photos)\//i)?.[1];
          const ownerAccount = owner && accountLink("/" + owner);
          return sameAccount(ownerAccount, requested) || sameAccount(ownerAccount, landed) ||
            Boolean(authorMatches && (timestampLink(a) ||
              /^\/[^/]+\/(?:posts|videos)\//i.test(path) || /^\/(?:permalink|story)\.php/i.test(path)));
        });
        const direct = candidates.find(timestampLink) ?? candidates[0];
        if (direct) accept(direct.href);
        if (posts.length >= limit) return {posts, outcome: "limit"};
      }
      idle = before === posts.length ? idle + 1 : 0;
      window.scrollBy(0, Math.floor(innerHeight * .85));
      await wait(650);
    }
    return {posts, outcome: stopped() ? "stopped" : "available"};
  };

  globalThis.readFacebookActivity = async ({post, targets, root, stopped, accountKeys}) => {
    const matchTargets = targetMatcher(targets);
    const postIds = new Set(postKeys(post));
    const main = root?.closest('[role="dialog"], main, [role="main"]') ?? root ??
      document.querySelector('main, [role="main"]');
    const matching = [...main?.querySelectorAll(article) ?? []].filter(card => !card.closest(comment) &&
      [...card.querySelectorAll("a[href]")].some(a =>
        a.closest(article) === card && !a.closest(message) && !a.href.includes("comment_id=") &&
        postUrl(a.href) && postKeys(a.href).some(key => postIds.has(key))));
    const top = [...main?.querySelectorAll(article) ?? []].filter(card =>
      !card.closest(comment) && !card.parentElement?.closest(article) && shown(card));
    const scope = matching[0] ?? (top.length === 1 ? top[0] : top.length === 0 ? main : null);
    const findings = [];
    const seen = new Map();
    const postBodies = () => [...scope?.querySelectorAll(message) ?? []].filter(node =>
      shown(node) && !node.closest(comment) && (!scope.matches(article) || node.closest(article) === scope));
    const captionMore = () => [...new Set(postBodies().flatMap(body => [...body.querySelectorAll(buttons)]))]
      .filter(button => shown(button) && label(button).some(value => /^(?:see more|show more|بیشتر ببینید)$/i.test(value)));
    if (!stopped()) {
      const expanders = captionMore();
      for (const button of expanders) button.click();
      if (expanders.length) await wait(400);
    }
    const bodies = postBodies();
    const author = [...scope?.querySelectorAll(headingLink) ?? []]
      .find(a => !a.closest(`${comment}, ${message}`) && accountLink(a.href));
    const add = (type, anchor, extra = {}, matches) => {
      const profile = accountKeys(anchor);
      const name = text(anchor);
      if (!profile || !name) return;
      for (const {account, match} of matches ?? matchTargets(profile, name)) {
        const key = [type, account.label, profile.id || profile.name].join("\0");
        const existing = seen.get(key);
        const finding = {type, target: account.label, confirmed: match === "account", postUrl: post,
          url: post, name, subjectUrl: anchor.href, ...extra};
        if (existing === undefined) {
          seen.set(key, findings.length);
          findings.push(finding);
        } else if ((finding.confirmed && !findings[existing].confirmed) ||
            (finding.reactionType && !findings[existing].reactionType)) {
          findings[existing] = finding;
        }
      }
    };
    for (const body of bodies) {
      for (const anchor of body.querySelectorAll("a[href]")) {
        if (shown(anchor)) add("mention", anchor, {name: author ? text(author) : "", mentionedName: text(anchor),
          authorUrl: author?.href, text: text(body), mentionSource: "post"});
      }
    }
    const postMentions = bodies.length ? (captionMore().length ? "partial" : "checked") : "unavailable";
    const unavailable = {findings, reactions: "unavailable", postMentions, reactionProfiles: 0};
    if (!scope || stopped()) return unavailable;

    // Only open a reaction summary. The post's Like control changes the user's reaction.
    const summary = [...scope.querySelectorAll(buttons)].find(button => shown(button) &&
      !button.closest(comment) && (!scope.matches(article) || button.closest(article) === scope) &&
      label(button).some(value => /^(?:all reactions\s*:|see who reacted\b|see reactions\b|[\d,.]+\s*[km]?\s+reactions\b)/i.test(value)));
    if (!summary) return unavailable;
    const existing = new Set([...document.querySelectorAll('[role="dialog"]')].filter(shown));
    summary.click();
    let dialog;
    for (let i = 0; i < 10 && !stopped(); i++) {
      dialog = [...document.querySelectorAll('[role="dialog"]')].find(node => shown(node) && !existing.has(node));
      if (dialog) break;
      await wait(250);
    }
    if (!dialog) return unavailable;
    const close = () => [...dialog.querySelectorAll(buttons)].find(button =>
      shown(button) && label(button).some(value => /^(?:close(?: dialog| reactions.*)?|بستن)$/i.test(value)))?.click();
    try {
      const tabs = () => [...dialog.querySelectorAll(reactionTabs)].filter(shown);
      const allTab = () => tabs().find(button => label(button).some(value =>
        /^(?:all|همه)(?:\s+reactions?)?(?:\s*[:(]?\s*[\d,.]+\s*[km]?\s*\)?)?$/i.test(value)));
      const selected = button => button && (button.getAttribute("aria-selected") === "true" ||
        button.getAttribute("aria-pressed") === "true");
      const reactionAnchors = () => [...dialog.querySelectorAll("a[href]")].filter(anchor =>
        shown(anchor) && !anchor.closest('header, footer, nav, [role="tablist"]') && text(anchor) && accountKeys(anchor));
      const signature = () => reactionAnchors().map(anchor => anchor.href).join("\n");
      const countFor = button => {
        for (const value of button ? label(button) : []) {
          const count = value.match(/(?:^|\s|[:(])(\d[\d,]*)\s*(?:people)?\)?$/i);
          if (count) return Number(count[1].replace(/,/g, ""));
        }
        return null;
      };
      const budget = Date.now() + 80_000;
      const active = () => !stopped() && dialog.isConnected && Date.now() < budget;
      async function activate(findTab, equivalent = false) {
        const tab = findTab();
        if (!tab || !active()) return false;
        if (selected(tab)) return true;
        const previous = signature();
        tab.click();
        // A selected tab can appear before its async list replaces the All results.
        const switched = () => {
          if (!selected(findTab())) return false;
          const current = signature();
          return equivalent || (current !== previous && (current.length > 0 || countFor(findTab()) === 0));
        };
        for (let i = 0; i < 16 && !switched() && active(); i++) await wait(250);
        if (!switched() || !active()) return false;
        await wait(350);
        return active() && Boolean(selected(findTab()));
      }

      function iconReaction(anchor) {
        const profile = accountKeys(anchor);
        for (let row = anchor.parentElement, depth = 0; row && row !== dialog && depth < 7; row = row.parentElement, depth++) {
          const other = [...row.querySelectorAll("a[href]")].some(link => {
            const candidate = accountKeys(link);
            return candidate && !sameAccount(profile, candidate);
          });
          if (other) break;
          const icons = row.querySelectorAll('img, svg, [role="img"], [data-reaction-type]');
          const types = new Set([...icons].flatMap(icon =>
            [icon.getAttribute("data-reaction-type"), icon.getAttribute("alt"), ...label(icon)]
              .filter(Boolean).map(reactionType).filter(Boolean)));
          if (types.size) return types.size === 1 ? [...types][0] : undefined;
        }
      }

      const profiles = new Set();
      async function readList(findTab, type) {
        const entries = new Set();
        const pagination = new WeakMap();
        const expected = countFor(findTab());
        const maxSteps = type ? 20 : 80;
        for (let idle = 0, step = 0; idle < 4 && step < maxSteps && active() && selected(findTab()); step++) {
          const before = entries.size;
          const anchors = reactionAnchors();
          for (const anchor of anchors) {
            const profile = accountKeys(anchor);
            entries.add(profile.id || profile.name);
            profiles.add(profile.id || profile.name);
            const matches = matchTargets(profile, text(anchor));
            if (matches.length) add("reaction", anchor, {authorUrl: anchor.href, reactionType: type || iconReaction(anchor)}, matches);
          }
          if (expected !== null && entries.size >= expected) return true;
          const more = [...dialog.querySelectorAll(buttons)].find(button => shown(button) && !button.disabled &&
            pagination.get(button) !== entries.size &&
            label(button).some(value => /^(?:view|see|load|show) more(?: (?:people|reactions))?$/i.test(value)));
          if (more) {
            pagination.set(more, entries.size);
            more.click();
            await wait(600);
            continue;
          }
          let scroller = anchors.at(-1)?.parentElement;
          while (scroller && dialog.contains(scroller) &&
            !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
            scroller = scroller.parentElement;
          }
          const previous = scroller?.scrollTop;
          if (scroller && dialog.contains(scroller)) scroller.scrollTop += Math.max(100, scroller.clientHeight * .8);
          idle = before !== entries.size || previous !== scroller?.scrollTop ? 0 : idle + 1;
          await wait(500);
        }
        return false;
      }

      if (!allTab()) await wait(650);
      if (!await activate(allTab)) return unavailable;
      const expectedAll = countFor(allTab());
      const complete = await readList(allTab);
      for (const [type] of reactionNames) {
        const reactions = findings.filter(finding => finding.type === "reaction");
        const unknown = reactions.some(finding => !finding.reactionType);
        const missing = !complete && targets.some(account =>
          !reactions.some(finding => finding.target === account.label && finding.confirmed && finding.reactionType));
        if (!active() || (!unknown && !missing)) break;
        const tab = () => tabs().find(button => label(button).some(value => reactionType(value) === type));
        const previousAll = selected(allTab());
        if (await activate(tab, previousAll && expectedAll !== null && expectedAll === countFor(tab()))) {
          await readList(tab, type);
        }
      }
      const unresolved = findings.some(finding => finding.type === "reaction" && !finding.reactionType);
      return {findings, reactions: complete && !unresolved ? "checked" : "partial", postMentions,
        reactionProfiles: profiles.size};
    } finally {
      close();
    }
  };
})();
