# Thread Recon — Facebook OSINT

Thread Recon is a Chrome side panel for finding comments and replies from a specific account on a Facebook post. It scans the comments available to your signed-in browser session.

## Install in Chrome

1. Clone this repository or download and extract the ZIP from GitHub.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Select **Load unpacked** and choose the folder containing `manifest.json`.
4. Click the Thread Recon icon to open the side panel. Chrome 114 or later is required.

## Run a scan

1. Paste a direct Facebook post URL or open the post and select **Use current tab**.
2. Enter a numeric account ID, `@username`, profile URL, or display name. Enter a display name without the `@` prefix.
3. Select **Run scan**. Keep the post tab open while the extension loads comments and expands reply branches.
4. Review the live findings or select **Stop** to keep the partial results. The coverage report shows what the scan observed, including remaining reply branches and comment loading controls.

An **Account match** uses an ID or username. **Display name only** means the names match and the account still needs to be verified. Reply cards show the parent comment when its text is available.

Search and filter findings in the panel, copy the visible results, or select **Export CSV** to download all findings from the scan. CSV includes the message type, match type, text, and direct links when available.

## Data handling

The extension reads the Facebook page in your browser and keeps the active scan in browser session storage. A scan can only cover comments and replies your Facebook session can load. A zero-match report applies to the entries scanned.
