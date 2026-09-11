import { useRef } from "react";
import type { Attachment, EffortNeedsDownload, EffortTierInfo, ModelOption, OllamaPullState } from "../hooks/useAgentBridge";
import { ModelPicker } from "./ModelPicker";
import { EffortSelector } from "./EffortSelector";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Extracted from web-client's App.tsx composer JSX (see the plan's §4 step
 * 5). Deliberately simpler than the web version — no non-image upload
 * path (there's no /api/upload server here; image attachments are sent
 * inline as base64, same as the web UI already does for those), and no
 * web-search/image-gen/deep-research toggles or tools "+" menu (those are
 * tied to the out-of-scope Tools/MCP panels).
 */
export function Composer({
  input,
  setInput,
  onSend,
  onInterrupt,
  busy,
  connected,
  pendingImages,
  setPendingImages,
  models,
  model,
  onSwitchModel,
  effortTiers,
  currentEffort,
  effortNeedsDownload,
  ollamaPull,
  onSetEffort,
  onPullOllamaModel,
  onDismissEffortNeedsDownload,
  onNeedsApiKey,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
  busy: boolean;
  connected: boolean;
  pendingImages: Attachment[];
  setPendingImages: (update: (imgs: Attachment[]) => Attachment[]) => void;
  models: ModelOption[];
  model: string;
  onSwitchModel: (model: string, family: string, baseUrl?: string) => void;
  effortTiers: EffortTierInfo[];
  currentEffort?: string;
  effortNeedsDownload: EffortNeedsDownload | null;
  ollamaPull: OllamaPullState | null;
  onSetEffort: (level: string) => void;
  onPullOllamaModel: (ollamaModel: string) => void;
  onDismissEffortNeedsDownload: () => void;
  onNeedsApiKey: (model: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (!IMAGE_TYPES.includes(file.type)) continue; // Non-image attachments aren't supported in Phase 1 — no upload server to hand them to.
      const base64 = await readFileAsBase64(file);
      setPendingImages((imgs) => [...imgs, { mimeType: file.type, base64 }]);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <footer className="composer">
      <div className="composer-box">
        {pendingImages.length > 0 && (
          <div className="attachment-chips">
            {pendingImages.map((img, i) => (
              <div className="attachment-chip" key={i}>
                <img src={`data:${img.mimeType};base64,${img.base64}`} alt="pièce jointe" />
                <button onClick={() => setPendingImages((imgs) => imgs.filter((_, idx) => idx !== i))}>×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          className="composer-input"
          placeholder={connected ? "Écrivez à finanfa-code…" : "Connexion…"}
          value={input}
          disabled={!connected}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
            <button
              className="btn btn-ghost attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected}
              title="Joindre une image"
            >
              📎
            </button>
            <ModelPicker models={models} model={model} onChange={onSwitchModel} onNeedsKey={onNeedsApiKey} />
            <EffortSelector
              currentEffort={currentEffort}
              tiers={effortTiers}
              needsDownload={effortNeedsDownload}
              pullState={ollamaPull}
              onSelect={onSetEffort}
              onPull={onPullOllamaModel}
              onDismissNeedsDownload={onDismissEffortNeedsDownload}
            />
          </div>
          {busy ? (
            <button className="btn btn-stop" onClick={onInterrupt}>
              Arrêter
            </button>
          ) : (
            <button className="btn btn-send" onClick={onSend} disabled={!connected || (!input.trim() && pendingImages.length === 0)}>
              Envoyer
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">Entrée pour envoyer · Maj+Entrée pour un saut de ligne</div>
    </footer>
  );
}
