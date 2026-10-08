import {
  Box,
  CircleUserRound,
  Cpu,
  Globe,
  KeyRound,
  type LucideIcon,
  MonitorSmartphone,
  Package,
  Plug,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';

export interface SettingsSection {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Words the command palette also finds it by. */
  keywords: string;
}

/** The settings, in the order the section list shows them. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    path: 'models',
    label: 'Models',
    icon: Cpu,
    keywords: 'providers api keys prices llm default fast embedding',
  },
  { path: 'general', label: 'General', icon: SlidersHorizontal, keywords: 'timezone concurrency limits' },
  { path: 'profile', label: 'Your profile', icon: CircleUserRound, keywords: 'me about preferences memory' },
  {
    path: 'devices',
    label: 'Devices',
    icon: MonitorSmartphone,
    keywords: 'tokens sign in phone browser revoke',
  },
  { path: 'secrets', label: 'Secrets', icon: KeyRound, keywords: 'vault credentials keys' },
  { path: 'mcp', label: 'MCP servers', icon: Plug, keywords: 'tools servers integrations' },
  { path: 'plugins', label: 'Plugins', icon: Package, keywords: 'install skills servers github' },
  { path: 'skills', label: 'Skills', icon: Sparkles, keywords: 'instructions plugins' },
  {
    path: 'browsers',
    label: 'Browsers',
    icon: Globe,
    keywords: 'identities sign in cookies chromium live view',
  },
  { path: 'sandboxes', label: 'Sandboxes', icon: Box, keywords: 'containers workspaces shell commands' },
];
