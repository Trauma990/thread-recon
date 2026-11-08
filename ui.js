const identity = globalThis.facebookIdentity;
const field = id => document.getElementById(id);
const number = new Intl.NumberFormat("en");
const output = field("report");
const filter = field("filter");
const targetFilter = field("target-filter");
const mode = field("mode");
const search = field("findings-search");
const notify = field("notify");
let scan;
let displayed = "";
let submitting = false;
let connected = false;

function append(parent, tag, content, className) {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function link(parent, value, text) {
  const url = value && identity.facebookUrl(value);
  if (!url) return;
  const anchor = append(parent, "a", text);
  anchor.href = url.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
}

function showStatus(message, state = "idle") {
  field("activity").hidden = false;
  field("indicator").dataset.state = state;
  if (field("status").textContent !== message) field("status").textContent = message;
}

function setBusy(running) {
  for (const id of ["start", "post", "account", "current", "notify", "mode", "post-limit"]) field(id).disabled = running;
  field("stop").hidden = !running;
  field("stop").disabled = Boolean(scan?.stopping);
}

function connectionLost() {
  connected = false;
  setBusy(false);
  field("start").disabled = true;
  field("current").disabled = true;
  showStatus("Extension unavailable. Close this panel and reopen Thread Recon from the Chrome toolbar.", "error");
}

function render(current) {
  scan = current;
  setBusy(Boolean(scan?.running));
  if (!scan) return;
  const result = scan.result;
  const count = (result?.matches.length ?? 0) + (result?.nameMatches.length ?? 0);
  const coverage = result?.coverage;
  const batch = scan.batch;
  const outcome = {
    stopped: "Scan stopped. Findings are partial.",
    limited: "Scan limit reached. Findings are partial.",
    partial: "Scan ended with partial coverage."
  }[coverage?.outcome];
  const partialActivity = !batch && coverage && (coverage.reactions !== "checked" || coverage.postMentions !== "checked");
  const status = scan.error || (scan.stopping && scan.running ? "Stopping scan…" :
    scan.running ? (scan.phase === "discovering" ? "Discovering posts in the page feed…" :
      scan.phase === "opening" ? "Opening scan target…" : "Checking comments, replies, reactions and mentions…") :
      outcome || (partialActivity ? "Scan ended with partial activity coverage." :
        count ? "Scan complete." : "No matches in the activity scanned."));
  showStatus(status, scan.error ? "error" : scan.running ? "running" : count ? "found" : "idle");
  const work = field("scan-work");
  work.hidden = !batch && !Number.isFinite(coverage?.elapsedMs);
  if (!work.hidden) {
    const parts = [];
    if (batch) parts.push(`${batch.entries.length} / ${batch.posts.length} posts processed`);
    if (Number.isFinite(coverage?.elapsedMs)) {
      const seconds = Math.floor(coverage.elapsedMs / 1000);
      const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      parts.push(`${duration} scanning · ${number.format(coverage.actions)} comment load actions`);
    }
    work.textContent = parts.join(" · ");
  }
  field("stats").hidden = !result;
  field("coverage").hidden = !result && !batch?.entries.length;
  field("unopened").textContent = coverage ? number.format(coverage.unopenedBranches) : "—";
  field("pending-pages").textContent = coverage ? number.format(coverage.pendingPages) : "—";
  field("pending-text").textContent = coverage?.pendingText == null ? "—" : number.format(coverage.pendingText);
  field("reaction-profiles").textContent = coverage?.reactionProfiles == null ? "—" : number.format(coverage.reactionProfiles);
  const posts = field("post-coverage");
  posts.replaceChildren();
  if (batch) {
    for (const [index, entry] of batch.entries.entries()) {
      const item = append(posts, "li", "");
      link(item, entry.post, `Post ${index + 1}`);
      const c = entry.coverage;
      item.append(entry.error ? ` · ${entry.error}` :
        ` · Comments: ${c?.outcome ?? "unavailable"} · Reactions: ${c?.reactions ?? "unavailable"} · Post mentions: ${c?.postMentions ?? "unavailable"}`);
    }
    if (!scan.running) field("coverage").open = true;
  }
  if (result) {
    field("comments").textContent = number.format(result.totals.comment);
    field("replies").textContent = number.format(result.totals.reply);
    field("found").textContent = number.format(count);
    if (scan.running) {
      field("notes").replaceChildren();
    } else {
      const notes = [...result.warnings];
      if (batch) notes.push("Page coverage is limited to the posts discovered in the feed.");
      else {
        if (coverage?.reactions !== "checked") notes.push(`Reaction list coverage: ${coverage?.reactions ?? "unavailable"}.`);
        if (coverage?.postMentions !== "checked") notes.push(`Post text coverage for linked mentions: ${coverage?.postMentions ?? "unavailable"}.`);
      }
      if (scan.bulk) notes.push("Bulk matching uses the IDs, usernames, or display names supplied. Profile aliases are not fetched for bulk scans.");
      if (scan.error && coverage?.outcome === "running") notes.push("Counts are from the last snapshot before the scan was interrupted.");
      if (coverage?.outcome === "partial" && !coverage.unopenedBranches && !coverage.pendingPages && !coverage.pendingText && result.selectedAll) {
        notes.push("The scanner could not confirm the end of the comments list.");
      }
      if (result.totals.unknownIdentity) notes.push(`Entries without a comparable account ID or username: ${number.format(result.totals.unknownIdentity)}.`);
      if (result.totals.unknownName) notes.push(`Entries without a readable display name: ${number.format(result.totals.unknownName)}.`);
      if (!result.selectedAll) notes.push("Could not verify that Facebook was showing All comments.");
      const list = field("notes");
      list.replaceChildren();
      for (const note of notes) append(list, "li", note);
      if (!notes.length) append(list, "li", "Finished scanning the entries Facebook made available.");
      field("coverage").open = true;
    }
  } else field("notes").replaceChildren();
  const labels = identity.targets(scan.account).map(account => account.label);
  if (JSON.stringify(labels) !== targetFilter.dataset.labels) {
    targetFilter.dataset.labels = JSON.stringify(labels);
    targetFilter.replaceChildren();
    append(targetFilter, "option", "All targets").value = "";
    for (const label of labels) append(targetFilter, "option", label).value = label;
  }
  targetFilter.hidden = labels.length < 2;
  renderMatches();
}

function resultRows() {
  if (!scan?.result) return [];
  return [
    ...scan.result.matches.map(row => ({...row, confirmed: true})),
    ...scan.result.nameMatches.map(row => ({...row, confirmed: false}))
  ];
}

function visibleRows(rows) {
  const normalize = value => value?.normalize("NFKC").toLowerCase() ?? "";
  const query = normalize(search.value.trim());
  return rows.filter(row => (filter.value === "all" || filter.value === row.type) &&
    (!targetFilter.value || targetFilter.value === row.target) &&
    (!query || [row.target, row.mentionedName, row.name, row.text, row.url, row.parentName, row.parentText, row.parentUrl, row.reactionType]
      .some(value => normalize(value).includes(query))));
}

const kind = row => ({reply: "Reply", comment: "Top-level comment", reaction: "Reaction", mention: "Mention"}[row.type] ?? row.type);
const match = row => row.confirmed ? "Account match" : "Display name only";

function renderMatches() {
  const all = resultRows();
  const rows = visibleRows(all);
  field("results").hidden = !scan?.result;
  field("copy").disabled = !rows.length;
  field("export").disabled = !scan?.found;
  field("visible-count").textContent = `${number.format(rows.length)} of ${number.format(all.length)} findings shown`;
  const scoped = targetFilter.value ? all.filter(row => row.target === targetFilter.value) : all;
  const counts = ["comment", "reply", "mention", "reaction"].map(type =>
    `${number.format(scoped.filter(row => row.type === type).length)} ${type === "reply" ? "replies" : type + "s"}`);
  field("activity-counts").textContent = `Observed: ${counts.join(" · ")}`;
  const fingerprint = JSON.stringify(rows);
  if (fingerprint === displayed) return;
  displayed = fingerprint;
  output.replaceChildren();
  if (!rows.length) append(output, "p", "No findings for this filter.", "hint");
  for (const row of rows) {
    const card = append(output, "article", "", "surface result");
    const tags = append(card, "div", "", "tags");
    append(tags, "span", kind(row), "tag");
    if (row.type === "reaction") append(tags, "span", row.reactionType || "Type unavailable", "tag");
    append(tags, "span", match(row), row.confirmed ? "tag verified" : "tag");
    if (row.target) append(tags, "span", row.target, "tag").dir = "auto";
    append(card, "h3", (row.type === "mention" ? row.mentionedName : row.name) || kind(row));
    if (row.type === "mention") append(card, "p", `Mentioned in ${row.mentionSource}${row.name ? ` by ${row.name}` : ""}.`, "hint");
    const body = append(card, "p", row.text || (row.type === "reaction" ? "Profile shown in the post reaction list." : "Text unavailable."), "comment-text");
    body.dir = "auto";
    const links = append(card, "div", "", "result-links");
    link(links, row.url || row.postUrl, row.type === "reaction" || !row.url ? "Open post" : "Open on Facebook");
    link(links, row.authorUrl, "Author profile");
    if (row.type === "mention") link(links, row.subjectUrl, "Mentioned profile");
    if (row.type === "reply" || row.mentionSource === "reply") {
      const parent = append(card, "section", "", "parent-context");
      append(parent, "h4", "Parent comment");
      if (row.parentName) append(parent, "strong", row.parentName).dir = "auto";
      append(parent, "p", row.parentText || "Parent comment text unavailable.", "comment-text").dir = "auto";
      link(parent, row.parentUrl || row.url, "Jump to thread");
    }
  }
}

filter.addEventListener("change", renderMatches);
targetFilter.addEventListener("change", renderMatches);
search.addEventListener("input", renderMatches);
function findingsCsv(rows) {
  const headers = ["post_url", "message_type", "match_type", "author", "text", "direct_url",
    "author_profile_url", "parent_author", "parent_text", "parent_url", "target", "mentioned_name",
    "mentioned_profile_url", "mention_source", "reaction_type"];
  const records = rows.map(row => [row.postUrl || scan.post, row.type, row.confirmed ? "account" : "display_name",
    row.name, row.text, row.url, row.authorUrl, row.parentName, row.parentText, row.parentUrl, row.target,
    row.mentionedName, row.type === "mention" ? row.subjectUrl : undefined, row.mentionSource, row.reactionType]);
  const cell = value => {
    const text = String(value ?? "");
    const safe = /^(?:\s*[=+\-@＝＋－＠]|[\t\r\n])/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [headers, ...records].map(record => record.map(cell).join(",")).join("\r\n") + "\r\n";
}

field("export").addEventListener("click", () => {
  const rows = resultRows();
  if (!rows.length) return;
  const url = URL.createObjectURL(new Blob([findingsCsv(rows)], {type: "text/csv;charset=utf-8"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = "thread-recon-findings.csv";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  field("copy-status").textContent = "CSV export started for all findings.";
});

field("copy").addEventListener("click", async () => {
  const header = [`Thread Recon report — ${scan.account}`, scan.post].join("\n");
  const details = visibleRows(resultRows()).map(row => [
    `${kind(row)} · ${match(row)} · ${row.target || row.name || ""}`, row.reactionType, row.text, row.url || row.postUrl,
    row.parentUrl && `Parent comment: ${row.parentUrl}`
  ].filter(Boolean).join("\n"));
  try {
    await navigator.clipboard.writeText([header, ...details].join("\n\n"));
    field("copy-status").textContent = "Visible findings copied.";
  } catch {
    field("copy-status").textContent = "Could not copy the report.";
  }
});

notify.checked = localStorage.getItem("notify") !== "off";
notify.addEventListener("change", () => localStorage.setItem("notify", notify.checked ? "on" : "off"));

const normalizeUrl = (value, scope) => scope === "page" ? identity.pageUrl(value) : identity.postUrl(value);
function scopeChanged() {
  const page = mode.value === "page";
  field("url-label").textContent = page ? "Page or profile URL" : "Post URL";
  field("page-settings").hidden = !page;
}
mode.addEventListener("change", scopeChanged);

async function activePost(scope = mode.value) {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return tab?.url && normalizeUrl(tab.url, scope);
}

field("current").addEventListener("click", async () => {
  if (!connected) return;
  try {
    const post = await activePost();
    if (post) field("post").value = post;
    else showStatus("Open a Facebook URL that matches the selected scan scope.", "error");
  } catch {
    connectionLost();
  }
});

field("search").addEventListener("submit", async event => {
  event.preventDefault();
  if (!connected || submitting || scan?.running) return;
  const post = normalizeUrl(field("post").value, mode.value);
  const account = field("account").value.trim();
  if (!post || !identity.targets(account).length) {
    showStatus("Check the Facebook URL and enter up to 100 valid accounts, one per line.", "error");
    return;
  }
  submitting = true;
  filter.value = "all";
  targetFilter.value = "";
  search.value = "";
  field("copy-status").textContent = "";
  setBusy(true);
  showStatus("Opening target post…", "running");
  try {
    const {id: windowId} = await chrome.windows.getCurrent();
    const answer = await chrome.runtime.sendMessage({kind: "start", windowId, post, account,
      mode: mode.value, limit: field("post-limit").value, notify: notify.checked});
    if (answer?.error) showStatus(answer.error, "error");
  } catch {
    connectionLost();
  } finally {
    submitting = false;
    if (connected) setBusy(Boolean(scan?.running));
  }
});

field("stop").addEventListener("click", async () => {
  if (!connected || !scan?.running) return;
  try {
    const answer = await chrome.runtime.sendMessage({kind: "stop", runId: scan.id});
    if (answer?.error) showStatus(answer.error, "error");
  } catch {
    connectionLost();
  }
});

async function initialize() {
  const storage = globalThis.chrome?.storage;
  if (!storage?.session || !storage.onChanged) {
    connectionLost();
    return;
  }
  storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.scan) render(changes.scan.newValue);
  });
  const {scan: saved} = await storage.session.get("scan");
  const current = scan ?? saved;
  mode.value = current?.mode ?? "post";
  if (current?.limit) field("post-limit").value = current.limit;
  scopeChanged();
  const post = current?.post || await activePost();
  if (post && !field("post").value) field("post").value = post;
  if (current?.account && !field("account").value) field("account").value = current.account;
  connected = true;
  if (!scan && saved) render(saved);
}

initialize().catch(connectionLost);
