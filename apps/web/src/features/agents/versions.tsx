import type { AgentDefinition, AgentVersion } from '@superagent/shared';
import { History } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { useActivateVersion, useAgentVersions } from '../../api/org';
import { cn } from '../../lib/cn';
import { diffLines, foldDiff } from '../../lib/diff';
import { formatDateTime, formatList } from '../../lib/format';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog, Dialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { DetailRow, Panel } from '../../ui/layout';
import { Segmented } from '../../ui/tabs';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';
import { versionChanges } from './draft';
import { toolName } from './grants';
import { modelLabel } from './model-select';

/** An agent's versions, newest first: what each changed, the one in use, and going back to another. */
export function AgentVersions({ agent, readOnly }: { agent: AgentDefinition; readOnly: boolean }) {
  const versions = useAgentVersions(agent.id);
  const activate = useActivateVersion(agent.id);
  const [viewing, setViewing] = useState<AgentVersion | null>(null);
  const [switching, setSwitching] = useState<AgentVersion | null>(null);
  const items = versions.data ?? [];
  const inUse = items.find((version) => version.version === agent.activeVersion);

  if (versions.isPending) {
    return (
      <div className="flex flex-col gap-2" role="status">
        <span className="sr-only">Loading versions…</span>
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl opacity-60" />
      </div>
    );
  }
  if (versions.isError) {
    return (
      <Notice
        tone="destructive"
        title="Couldn’t load the versions"
        action={
          <Button size="sm" onClick={() => versions.refetch()}>
            Retry
          </Button>
        }
      >
        {errorMessage(versions.error)}
      </Notice>
    );
  }
  if (items.length === 0) return <EmptyState icon={<History />} title="No versions yet" />;

  return (
    <>
      <ol className="flex flex-col gap-2" aria-label={`${agent.name}’s versions`}>
        {items.map((version, index) => {
          const active = version.version === agent.activeVersion;
          const changed = versionChanges(version, items[index + 1]);
          return (
            <li key={version.version}>
              <Panel className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-label text-foreground">Version {version.version}</h3>
                    {active ? (
                      <Badge tone="green" dot>
                        In use
                      </Badge>
                    ) : null}
                    <RelativeTime iso={version.createdAt} className="text-caption text-muted-foreground" />
                  </div>
                  <p className="text-caption text-muted-foreground">
                    {index === items.length - 1
                      ? 'The first version.'
                      : changed.length > 0
                        ? `Changed ${formatList(changed)}.`
                        : 'The same as the version before.'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setViewing(version)}>
                    View
                  </Button>
                  {!active && !readOnly ? (
                    <Button size="sm" onClick={() => setSwitching(version)}>
                      Use this version
                    </Button>
                  ) : null}
                </div>
              </Panel>
            </li>
          );
        })}
      </ol>

      <VersionDialog
        version={viewing}
        inUse={inUse}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      />
      <ConfirmDialog
        open={switching !== null}
        onOpenChange={(open) => {
          if (!open) setSwitching(null);
        }}
        title={`Put ${agent.name} on version ${switching?.version ?? ''}?`}
        description="Its description, instructions, model and grants become that version’s, from its next run. No version is deleted, so you can come back."
        confirmLabel={`Use version ${switching?.version ?? ''}`}
        busy={activate.isPending}
        onConfirm={() => {
          if (!switching) return;
          activate.mutate(switching.version, {
            onSuccess: (saved) => {
              toast.success(`${saved.name} is on version ${saved.activeVersion}`);
              setSwitching(null);
            },
          });
        }}
      />
    </>
  );
}

function VersionDialog({
  version,
  inUse,
  onOpenChange,
}: {
  version: AgentVersion | null;
  inUse: AgentVersion | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const [view, setView] = useState<'changes' | 'text'>('changes');
  const comparable = version && inUse && version.version !== inUse.version;
  const instructionsChanged = comparable && version.instructions !== inUse.instructions;
  return (
    <Dialog
      open={version !== null}
      onOpenChange={onOpenChange}
      size="lg"
      title={version ? `Version ${version.version}` : ''}
      description={version ? `Saved ${formatDateTime(version.createdAt)}.` : undefined}
    >
      {version ? (
        <div className="flex flex-col gap-4 pb-4">
          <dl>
            <DetailRow label="Description">{version.description}</DetailRow>
            <DetailRow label="Model">{modelLabel(version.model)}</DetailRow>
            <DetailRow label="Tools">
              {version.tools.length > 0
                ? formatList(
                    version.tools.map(
                      (grant) => `${toolName(grant.key)}${grant.requireApproval ? ' (asks first)' : ''}`,
                    ),
                  )
                : 'None'}
            </DetailRow>
            <DetailRow label="Skills">
              {version.skills.length > 0 ? formatList(version.skills) : 'None'}
            </DetailRow>
            <DetailRow label="MCP servers">
              {version.mcp.length > 0
                ? formatList(
                    version.mcp.map(
                      (grant) =>
                        `${grant.server}${grant.tools ? ` (${grant.tools.length} tools)` : ''}${grant.requireApproval ? ', asks first' : ''}`,
                    ),
                  )
                : 'None'}
            </DetailRow>
          </dl>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-label text-foreground">Instructions</h3>
              {instructionsChanged ? (
                <Segmented
                  aria-label="Show"
                  size="sm"
                  value={view}
                  onValueChange={setView}
                  options={[
                    { value: 'changes', label: `Against version ${inUse.version}` },
                    { value: 'text', label: 'Full text' },
                  ]}
                />
              ) : null}
            </div>
            {instructionsChanged && view === 'changes' ? (
              <InstructionsDiff before={inUse.instructions} after={version.instructions} />
            ) : (
              <pre className="max-h-96 overflow-auto rounded-lg bg-fill-subtle px-3 py-2 font-sans text-body-sm whitespace-pre-wrap break-words text-foreground/90 shadow-rim">
                {version.instructions}
              </pre>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

/** Lines removed from `before` and added in `after`, with a little context, the rest folded. */
export function InstructionsDiff({ before, after }: { before: string; after: string }) {
  const hunks = foldDiff(diffLines(before, after));
  return (
    <div className="max-h-96 overflow-auto rounded-lg bg-fill-subtle py-1.5 font-mono text-caption shadow-rim">
      {hunks.map((hunk, index) =>
        hunk.kind === 'gap' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no identity beyond their place
          <p key={index} className="px-3 py-0.5 text-placeholder">
            ⋯ {hunk.count} unchanged {hunk.count === 1 ? 'line' : 'lines'}
          </p>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <div key={index}>
            {hunk.lines.map((line, lineIndex) => (
              <p
                // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat; their place is their identity
                key={lineIndex}
                className={cn(
                  'flex gap-2 px-3 break-words whitespace-pre-wrap',
                  line.kind === 'added' && 'bg-success-subtle text-foreground',
                  line.kind === 'removed' && 'bg-destructive-subtle text-foreground/75',
                  line.kind === 'same' && 'text-muted-foreground',
                )}
              >
                <span aria-hidden className="w-2 shrink-0 select-none">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
                </span>
                <span className="min-w-0 flex-1">
                  {line.kind === 'added' ? <span className="sr-only">Added: </span> : null}
                  {line.kind === 'removed' ? <span className="sr-only">Removed: </span> : null}
                  {line.text || ' '}
                </span>
              </p>
            ))}
          </div>
        ),
      )}
    </div>
  );
}
