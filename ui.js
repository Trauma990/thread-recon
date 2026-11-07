const identity = globalThis.facebookIdentity;
const field = id => document.getElementById(id);
const number = new Intl.NumberFormat("en");
const output = field("report");
const filter = field("filter");
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
  for (const id of ["start", "post", "account", "current", "notify"]) field(id).disabled = running;
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
  const outcome = {
    stopped: "Scan stopped. Findings are partial.",
    limited: "Scan limit reached. Findings are partial.",
    partial: "Scan ended with partial coverage."
  }[coverage?.outcome];
  const status = scan.error || (scan.stopping && scan.running ? "Stopping scan…" :
    scan.running ? (scan.phase === "opening" ? "Opening target post…" : "Scanning comments and replies…") :
      outcome || (count ? "Scan complete." : "No matches in the scanned comments and replies."));
  showStatus(status, scan.error ? "error" : scan.running ? "running" : count ? "found" : "idle");
  const work = field("scan-work");
  work.hidden = !Number.isFinite(coverage?.elapsedMs);
  if (!work.hidden) {
    const seconds = Math.floor(coverage.elapsedMs / 1000);
    const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    work.textContent = `${duration} elapsed · ${number.format(coverage.actions)} load actions`;
  }
  field("stats").hidden = !result;
  field("coverage").hidden = !result;
  if (result) {
    field("comments").textContent = number.format(result.totals.comment);
    field("replies").textContent = number.format(result.totals.reply);
    field("found").textContent = number.format(count);
    field("unopened").textContent = coverage ? number.format(coverage.unopenedBranches) : "—";
    field("pending-pages").textContent = coverage ? number.format(coverage.pendingPages) : "—";
    if (scan.running) {
      field("notes").replaceChildren();
    } else {
      const notes = [...result.warnings];
      if (scan.error && coverage?.outcome === "running") notes.push("Counts are from the last snapshot before the scan was interrupted.");
      if (coverage?.outcome === "partial" && !coverage.unopenedBranches && !coverage.pendingPages && result.selectedAll) {
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
  }
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
    (!query || [row.name, row.text, row.url, row.parentName, row.parentText, row.parentUrl]
      .some(value => normalize(value).includes(query))));
}

const kind = row => row.type === "reply" ? "Reply" : "Top-level comment";
const match = row => row.confirmed ? "Account match" : "Display name only";

function renderMatches() {
  const all = resultRows();
  const rows = visibleRows(all);
  field("results").hidden = !scan?.found;
  field("copy").disabled = !rows.length;
  field("export").disabled = !scan?.found;
  field("visible-count").textContent = `${number.format(rows.length)} of ${number.format(all.length)} findings shown`;
  const fingerprint = JSON.stringify(rows);
  if (fingerprint === displayed) return;
  displayed = fingerprint;
  output.replaceChildren();
  if (!rows.length) append(output, "p", "No findings for this filter.", "hint");
  for (const row of rows) {
    const card = append(output, "article", "", "surface result");
    const tags = append(card, "div", "", "tags");
    append(tags, "span", kind(row), "tag");
    append(tags, "span", match(row), row.confirmed ? "tag verified" : "tag");
    append(card, "h3", row.name || kind(row));
    const body = append(card, "p", row.text || "Comment text unavailable.", "comment-text");
    body.dir = "auto";
    const links = append(card, "div", "", "result-links");
    link(links, row.url, "Open on Facebook");
    link(links, row.authorUrl, "Author profile");
    if (row.type === "reply") {
      const parent = append(card, "section", "", "parent-context");
      append(parent, "h4", "Parent comment");
      if (row.parentName) append(parent, "strong", row.parentName).dir = "auto";
      append(parent, "p", row.parentText || "Parent comment text unavailable.", "comment-text").dir = "auto";
      link(parent, row.parentUrl || row.url, "Jump to thread");
    }
  }
}

filter.addEventListener("change", renderMatches);
search.addEventListener("input", renderMatches);
function findingsCsv(rows) {
  const headers = ["post_url", "message_type", "match_type", "author", "text", "direct_url",
    "author_profile_url", "parent_author", "parent_text", "parent_url"];
  const records = rows.map(row => [scan.post, row.type, row.confirmed ? "account" : "display_name",
    row.name, row.text, row.url, row.authorUrl, row.parentName, row.parentText, row.parentUrl]);
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
    `${kind(row)} · ${match(row)} · ${row.name || ""}`, row.text, row.url,
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

async function activePost() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return tab?.url && identity.postUrl(tab.url);
}

field("current").addEventListener("click", async () => {
  if (!connected) return;
  try {
    const post = await activePost();
    if (post) field("post").value = post;
    else showStatus("Open a Facebook post in the current tab first.", "error");
  } catch {
    connectionLost();
  }
});

field("search").addEventListener("submit", async event => {
  event.preventDefault();
  if (!connected || submitting || scan?.running) return;
  const post = identity.postUrl(field("post").value);
  const account = field("account").value.trim();
  if (!post || !identity.target(account)) {
    showStatus("Check the post URL and the account or display name.", "error");
    return;
  }
  submitting = true;
  filter.value = "all";
  search.value = "";
  field("copy-status").textContent = "";
  setBusy(true);
  showStatus("Opening target post…", "running");
  try {
    const {id: windowId} = await chrome.windows.getCurrent();
    const answer = await chrome.runtime.sendMessage({kind: "start", windowId, post, account, notify: notify.checked});
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
  const post = current?.post || await activePost();
  if (post && !field("post").value) field("post").value = post;
  if (current?.account && !field("account").value) field("account").value = current.account;
  connected = true;
  if (!scan && saved) render(saved);
}

initialize().catch(connectionLost);
