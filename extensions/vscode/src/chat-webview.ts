export interface ChatWebviewHtmlOptions {
  scriptUri: string;
  styleUri: string;
  cspSource: string;
}

export function chatWebviewHtml({ scriptUri, styleUri, cspSource }: ChatWebviewHtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource}; script-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Shizuha Chat</title>
</head>
<body>
  <main class="shell">
    <header class="header">
      <div>
        <h1>Shizuha Chat</h1>
        <p>Local in-memory conversation; messages stream from the local core.</p>
      </div>
      <div id="status" class="status">idle</div>
    </header>
    <section id="turns" class="turns" aria-live="polite"></section>
    <form id="composer" class="composer">
      <div class="routing">
        <input id="model" type="text" autocomplete="off" placeholder="model (optional)" aria-label="Model">
        <input id="provider" type="text" autocomplete="off" placeholder="provider (optional)" aria-label="Provider">
      </div>
      <textarea id="message" rows="4" placeholder="Ask Shizuha…" aria-label="Message"></textarea>
      <div class="actions">
        <button id="cancel" type="button" disabled>Cancel</button>
        <button id="send" type="submit">Send</button>
      </div>
    </form>
  </main>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
