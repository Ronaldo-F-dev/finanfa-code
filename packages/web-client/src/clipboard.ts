/**
 * Copies `text` through the Clipboard API and reports whether it actually
 * worked, instead of assuming it did. `navigator.clipboard` is undefined in
 * a non-secure context (plain http on a LAN address, an embedded webview),
 * and `writeText` itself rejects when the document isn't focused or the
 * user denies permission — both previously left the code-copy button
 * silently doing nothing, plus an unhandled rejection in the console.
 * Taking the clipboard-like object as a parameter keeps this testable
 * without a DOM, same shape as urlState.ts.
 */
export async function copyTextToClipboard(
  text: string,
  clipboard: { writeText?: (text: string) => Promise<void> } | undefined,
): Promise<boolean> {
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
