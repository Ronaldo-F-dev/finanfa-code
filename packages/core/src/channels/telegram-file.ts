import type { TelegramConfig } from "../tools/builtin/send-telegram-message.js";

// Downloads a Telegram-hosted file (a voice note's audio, in practice —
// see channels-telegram.ts) given its file_id: Telegram's Bot API is a
// two-step fetch — getFile resolves the id to a real, short-lived
// file_path, then the actual bytes live at a *different* base URL
// (api.telegram.org/file/..., not api.telegram.org/bot.../...).
export type FetchTelegramFileResult = { ok: true; bytes: Buffer; mimeType: string } | { ok: false; error: string };

interface TelegramGetFileResponse {
  ok: boolean;
  description?: string;
  result?: { file_path?: string };
}

function mimeTypeForFilePath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  // Telegram voice notes are always Opus-in-Ogg; other audio (forwarded
  // files, "Send as audio" instead of a voice note) can be mp3/m4a/etc.
  if (ext === ".oga" || ext === ".ogg") return "audio/ogg";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".wav") return "audio/wav";
  return "application/octet-stream";
}

export async function fetchTelegramFile(config: TelegramConfig, fileId: string, apiBaseUrl = "https://api.telegram.org"): Promise<FetchTelegramFileResult> {
  let getFileResponse: Response;
  try {
    getFileResponse = await fetch(`${apiBaseUrl}/bot${config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  } catch (err) {
    return { ok: false, error: `Failed to reach Telegram: ${err instanceof Error ? err.message : String(err)}` };
  }
  let getFileData: TelegramGetFileResponse;
  try {
    getFileData = (await getFileResponse.json()) as TelegramGetFileResponse;
  } catch {
    return { ok: false, error: `Telegram returned an unparseable getFile response (HTTP ${getFileResponse.status}).` };
  }
  if (!getFileData.ok || !getFileData.result?.file_path) {
    return { ok: false, error: getFileData.description ?? "Telegram's getFile call did not return a file_path." };
  }

  const filePath = getFileData.result.file_path;
  let downloadResponse: Response;
  try {
    downloadResponse = await fetch(`${apiBaseUrl}/file/bot${config.botToken}/${filePath}`);
  } catch (err) {
    return { ok: false, error: `Failed to download the file from Telegram: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!downloadResponse.ok) {
    return { ok: false, error: `Telegram file download returned HTTP ${downloadResponse.status}.` };
  }

  const bytes = Buffer.from(await downloadResponse.arrayBuffer());
  return { ok: true, bytes, mimeType: mimeTypeForFilePath(filePath) };
}
