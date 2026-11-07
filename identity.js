globalThis.facebookIdentity = (() => {
  const reserved = new Set([
    "about", "checkpoint", "comment", "events", "friends", "groups", "help", "home",
    "l.php", "login", "marketplace", "messages", "notifications", "pages", "people",
    "permalink.php", "photo", "photo.php", "photos", "profile.php", "reel", "reels",
    "search", "settings", "share", "stories", "story.php", "watch"
  ]);

  function facebookUrl(value) {
    try {
      const url = new URL(value, "https://www.facebook.com/");
      if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
          /^(?:[a-z0-9-]+\.)*facebook\.com$/i.test(url.hostname)) return url;
    } catch {}
    return null;
  }

  function username(value) {
    const name = value.toLowerCase();
    return /^[a-z\d][a-z\d.]*$/i.test(name) && !reserved.has(name)
      ? name.replace(/\./g, "") : null;
  }

  function accountLink(value) {
    const url = value && facebookUrl(value);
    if (!url) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const id = (parts[0] === "profile.php" && parts.length === 1 && url.searchParams.get("id")) ||
      (parts.length === 3 && parts[0] === "people" && parts[2]) ||
      (parts.length === 4 && parts[0] === "groups" && parts[2] === "user" && parts[3]) ||
      (parts.length === 1 && parts[0]);
    if (id && /^\d+$/.test(id)) return {id};
    const name = parts.length === 1 && username(parts[0]);
    return name ? {name} : null;
  }

  function target(value) {
    const input = value.trim();
    const digits = input.replace(/[۰-۹٠-٩]/g, digit => String(digit.charCodeAt(0) & 15));
    if (/^\d+$/.test(digits)) return {id: digits};
    if (/^(?:https:\/\/|(?:[\w-]+\.)*facebook\.com\/)/i.test(input)) {
      return accountLink(/^https:\/\//i.test(input) ? input : `https://${input}`);
    }
    if (input.startsWith("@")) {
      const name = username(input.slice(1));
      return name ? {name} : null;
    }
    if (!input || input.length > 120 || /[:/\\@]/.test(input)) return null;
    return {name: username(input) ?? undefined, displayName: input};
  }

  function postKeys(value) {
    const url = facebookUrl(value);
    if (!url) return [];
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.findIndex(part => /^(posts|videos|reel|photos)$/i.test(part));
    const pathId = index >= 0 && parts[index + 1] ? parts.at(-1) : null;
    return [...new Set([
      pathId, url.searchParams.get("story_fbid"), url.searchParams.get("fbid"),
      url.searchParams.get("v")
    ].filter(Boolean))];
  }

  function postUrl(value) {
    if (!/^https:\/\//i.test(value.trim())) return null;
    const url = facebookUrl(value.trim());
    if (!url) return null;
    const shared = /^\/share\/(?:[prv]\/)?[\w-]+\/?$/.test(url.pathname);
    const direct = /^\/(?:.*\/(?:posts|photos|videos)\/[^/]+|(?:posts|reel)\/[^/]+|permalink\.php|story\.php|photo(?:\.php)?|watch|video\.php)\/?$/i.test(url.pathname);
    if (!shared && (!direct || !postKeys(url.href).length)) return null;
    url.hash = "";
    for (const key of ["comment_id", "reply_comment_id", "notif_id", "notif_t"]) {
      url.searchParams.delete(key);
    }
    return url.href;
  }

  function profileUrl(account) {
    return account.id
      ? `https://www.facebook.com/profile.php?id=${account.id}`
      : `https://www.facebook.com/${account.name}`;
  }

  return {facebookUrl, accountLink, target, postKeys, postUrl, profileUrl};
})();
