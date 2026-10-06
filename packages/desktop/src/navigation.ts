// What the window may load, and what is handed to the user's real browser instead. The window shows
// ONE origin — the local server — and never navigates anywhere else: a link in an agent's reply (which
// can contain anything a web page or a tool returned) must not turn this window into a browser.

/** True when `url` is on the server the window belongs to. */
export function isInternalUrl(url: string, serverOrigin: string): boolean {
  try {
    return new URL(url).origin === new URL(serverOrigin).origin;
  } catch {
    return false;
  }
}

/** Only web links and mail links are ever opened outside the app; file:, javascript:, custom schemes and the like are dropped. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}
