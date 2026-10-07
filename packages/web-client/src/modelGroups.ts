export interface PickerModel {
  id: string;
  family: string;
  configured: boolean;
  baseUrl?: string;
  localModelId?: string;
  provider?: string;
  /** A model with a launch command in the config; `running` says whether its server is up right now. */
  local?: boolean;
  running?: boolean;
}

export interface ModelGroup<T extends PickerModel = PickerModel> {
  /** Stable key; also the i18n suffix for the built-in groups. */
  key: string;
  /** Set for a cloud provider, whose name is not translated. */
  label?: string;
  items: T[];
}

const isLocalUrl = (url: string | undefined): boolean => Boolean(url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url));

/** Claude first, then each cloud provider in the order it appears, then the models on this machine, then whatever else is configured. */
export function groupModels<T extends PickerModel>(models: T[], query = ""): ModelGroup<T>[] {
  const q = query.trim().toLowerCase();
  const visible = q ? models.filter((m) => `${m.id} ${m.provider ?? ""}`.toLowerCase().includes(q)) : models;
  const groups: ModelGroup<T>[] = [];
  const bucket = (key: string, label?: string): ModelGroup<T> => {
    let group = groups.find((g) => g.key === key);
    if (!group) groups.push((group = { key, label, items: [] }));
    return group;
  };
  const claude = bucket("claude");
  for (const m of visible) {
    if (m.family === "anthropic") claude.items.push(m);
    else if (m.provider) bucket(`cloud:${m.provider}`, m.provider).items.push(m);
  }
  const local = bucket("local");
  const configured = bucket("configured");
  for (const m of visible) {
    if (m.family === "anthropic" || m.provider) continue;
    (m.localModelId || m.local || isLocalUrl(m.baseUrl) ? local : configured).items.push(m);
  }
  return groups.filter((g) => g.items.length > 0);
}
