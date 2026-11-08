![Thread Recon — Facebook OSINT](docs/banner.png)

# Thread Recon

Thread Recon is a Chrome side panel for finding comments, replies, post reactions, and linked mentions for multiple Facebook accounts. Scan one post or work through a Facebook Page or profile feed using your signed-in browser session.

**[Download the current source ZIP](https://github.com/Trauma990/thread-recon/archive/refs/heads/main.zip)** · **[Browse releases](https://github.com/Trauma990/thread-recon/releases)**

## Install in Chrome

1. Clone this repository or download and extract the current source ZIP.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Select **Load unpacked** and choose the folder containing `manifest.json`.
4. Click the Thread Recon icon to open the side panel. Chrome 114 or later is required.

## Run a scan

1. Choose **Single Facebook post** or **Facebook page or profile**. Paste the corresponding URL or select **Use current tab**.
2. Enter up to 100 targets, one per line. Use a numeric ID, `@username`, profile URL, or display name. Enter display names without the `@` prefix. Scans with more than 10 targets use the supplied identifiers directly.
3. For a page scan, choose a limit from 1 to 100 posts (default 10). Posts are discovered in feed order. Each post in a page scan has a four-minute scan budget. Keep the scan tab open.
4. Filter live findings by target or activity, or select **Stop** to keep partial results. **Scan coverage** reports which posts and reaction lists could be read and shows remaining comment controls.

An **Account match** uses an ID or username. **Display name only** means the names match and the account still needs to be verified. Reactions are read from the **All** tab. When a row has no readable reaction badge, the scanner can check the named reaction filters and reports **Type unavailable** if it cannot verify the reaction. A **Mention** requires a profile link in the text of a post, comment, or reply. Reply cards show the parent comment when its text is available.

Search and filter findings in the panel, copy the visible results, or select **Export CSV** to download all findings from the scan. CSV includes the target, activity type, reaction type when available, match type, source post, and direct evidence links.

## Data handling

The extension reads Facebook in your browser and keeps the active scan in browser session storage. Coverage depends on what Facebook displays to the signed-in session. A zero-match report applies to the entries scanned. The extension does not post comments or add reactions.
