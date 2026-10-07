import { siDiscord, siGithub, siGmail, siGoogledrive, siHostinger, siLine, siMatrix, siNotion, siSupabase, siTelegram, siVercel, siWhatsapp } from "simple-icons";

export interface Brand {
  /** Display name: "Notion", not the server's id. */
  label: string;
  /** Brand colour, 6 hex digits without "#". */
  color: string;
  /** SVG path (24x24 viewBox) of the brand's mark, when we have it. */
  path?: string;
  /** URL of the brand's own full-colour logo file, when one was dropped into src/assets/brands/. */
  image?: string;
}

// Official logo files, named after the brand key (slack.svg, microsoft-365.svg...). Any file found here is shown in
// place of the initials tile; see src/assets/brands/README.md.
const LOGO_FILES = import.meta.glob("./assets/brands/*.{svg,png}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const logoFor = (key: string): string | undefined => Object.entries(LOGO_FILES).find(([file]) => file.replace(/^.*\/|\.[a-z]+$/g, "") === key)?.[1];

const fromIcon = (icon: { title: string; hex: string; path: string }, label = icon.title): Brand => ({ label, color: icon.hex, path: icon.path });

// Marks come from the simple-icons package, bundled into the app (no network at runtime). A few brands asked their
// logo be removed from it — Slack, Canva, Microsoft Teams/365, Feishu, Twilio, Gamma — so those get a tile in the
// brand's colour with its initials instead. Logos are trademarks of their owners and only identify the service.
const BRANDS: Record<string, Brand> = {
  notion: fromIcon(siNotion),
  supabase: fromIcon(siSupabase),
  vercel: fromIcon(siVercel),
  hostinger: fromIcon(siHostinger),
  discord: fromIcon(siDiscord),
  telegram: fromIcon(siTelegram),
  whatsapp: fromIcon(siWhatsapp),
  matrix: fromIcon(siMatrix),
  line: fromIcon(siLine, "LINE"),
  github: fromIcon(siGithub, "GitHub"),
  gmail: fromIcon(siGmail),
  drive: fromIcon(siGoogledrive, "Google Drive"),
  canva: { label: "Canva", color: "00C4CC" },
  slack: { label: "Slack", color: "4A154B" },
  teams: { label: "Microsoft Teams", color: "6264A7" },
  "microsoft-365": { label: "Microsoft 365", color: "D83B01" },
  feishu: { label: "Feishu", color: "3370FF" },
  twilio: { label: "Twilio", color: "F22F46" },
  gamma: { label: "Gamma", color: "7C5CFC" },
};

/** "hostinger-hosting" -> "hostinger"; ids that are not a known service's own name keep matching exactly. */
function brandKey(id: string): string {
  const lower = id.toLowerCase();
  if (lower in BRANDS) return lower;
  const family = lower.split("-")[0] ?? lower;
  return family in BRANDS ? family : lower;
}

/** "hostinger-hosting" -> "Hostinger hosting"; an unknown id is title-cased so it still reads as a name. */
function prettify(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

export interface ResolvedBrand extends Brand {
  /** True for a service we know; false for a custom connector, which gets a neutral tile. */
  known: boolean;
  /** One or two letters for the tile when there is no mark. */
  initials: string;
}

function luminanceOf(hex: string): number {
  const n = Number.parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Is white or black text readable on this colour? */
export function readableTextOn(hex: string): "#fff" | "#111" {
  return luminanceOf(hex) > 0.4 ? "#111" : "#fff";
}

/**
 * Colours for the tile a mark sits on. Normally the brand colour with a mark readable on it; but brands whose own
 * colour is (nearly) black — Notion, Vercel, Matrix — would vanish on the dark theme, so they get a light tile.
 */
export function tileColors(hex: string): { background: string; color: string } {
  if (luminanceOf(hex) < 0.04) return { background: "#f4f4f5", color: `#${hex}` === "#000000" ? "#111" : `#${hex}` };
  return { background: `#${hex}`, color: readableTextOn(hex) };
}

function initialsOf(label: string): string {
  const words = label.split(/[\s\-_]+/).filter(Boolean);
  // Two words -> two capitals ("Microsoft 365" -> "M3"); one word -> a single capital, like an app icon.
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0]?.[0] ?? "?").toUpperCase();
}

/** What to draw for a connector or channel id: its brand if known, else a neutral tile with the name's initials. */
export function resolveBrand(id: string): ResolvedBrand {
  const known = BRANDS[brandKey(id)];
  if (known) {
    // A sub-service (hostinger-hosting) keeps the family's mark but says which part it is.
    const label = id.toLowerCase() === brandKey(id) ? known.label : `${known.label} ${id.slice(brandKey(id).length + 1).replace(/[-_]+/g, " ")}`;
    return { ...known, label, known: true, initials: initialsOf(known.label), image: logoFor(brandKey(id)) };
  }
  const label = prettify(id);
  return { label, color: "6E6E73", known: false, initials: initialsOf(label) };
}
