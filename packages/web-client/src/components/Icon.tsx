import { Brain, FilePen, Terminal, Cpu, FolderOpen, Globe, Image as ImageIcon, ListChecks, Paperclip, Plug, Radio, Search, Settings, ShieldCheck, SquarePen, Wrench, type LucideIcon } from "lucide-react";

/** The app's navigation icons, one consistent set instead of a mix of emoji (which render at different sizes and styles per platform). */
const ICONS = {
  newChat: SquarePen,
  projects: FolderOpen,
  memory: Brain,
  connectors: Plug,
  models: Cpu,
  tools: Wrench,
  approvals: ShieldCheck,
  tasks: ListChecks,
  channels: Radio,
  settings: Settings,
  web: Globe,
  image: ImageIcon,
  research: Search,
  attach: Paperclip,
  edits: FilePen,
  terminal: Terminal,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const Component = ICONS[name];
  return <Component className="icon" size={size} strokeWidth={1.8} aria-hidden="true" />;
}
