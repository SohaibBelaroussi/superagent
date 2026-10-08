import type { AttentionItem } from '@superagent/shared';
import {
  CircleHelp,
  HeartPulse,
  type LucideIcon,
  ScanEye,
  ShieldQuestion,
  TriangleAlert,
} from 'lucide-react';
import type { Tone } from '../../lib/tones';

export type AttentionKind = AttentionItem['kind'];

/** How each kind of thing that needs you looks, and what the inbox calls it. */
export const KINDS: Record<AttentionKind, { icon: LucideIcon; tone: Tone; label: string; plural: string }> = {
  approval: { icon: ShieldQuestion, tone: 'orange', label: 'Approval', plural: 'Approvals' },
  question: { icon: CircleHelp, tone: 'orange', label: 'Question', plural: 'Questions' },
  review: { icon: ScanEye, tone: 'purple', label: 'Review', plural: 'Reviews' },
  problem: { icon: TriangleAlert, tone: 'red', label: 'Problem', plural: 'Problems' },
  health: { icon: HeartPulse, tone: 'red', label: 'Setup', plural: 'Setup' },
};

/** The inbox's order of kinds: what blocks an agent first. */
export const KIND_ORDER: readonly AttentionKind[] = ['approval', 'question', 'problem', 'review', 'health'];
