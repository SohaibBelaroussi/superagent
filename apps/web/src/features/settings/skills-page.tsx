import type { SkillList } from '@superagent/shared';
import { FileText, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { usePlugins, useSkill, useSkills } from '../../api/settings';
import { Loaded } from '../../layout/loaded';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { useDocumentTitle } from '../../lib/title';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { EmptyState, Notice, Skeleton } from '../../ui/feedback';
import { DetailRow, Page, PageHeader, Panel, Section } from '../../ui/layout';
import { raisedSurface } from '../../ui/recipes';

type SkillSummary = SkillList['items'][number];

/** The skills plugins brought, by plugin: what each is for, and its files. */
export function SkillsPage() {
  useDocumentTitle('Skills');
  const skills = useSkills();
  const plugins = usePlugins();
  const [viewing, setViewing] = useState<SkillSummary | null>(null);
  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Skills"
          description="Know-how an agent reads when a task calls for it: instructions, and files it can use. They come with plugins; give them to agents or whole departments."
        />
      }
    >
      <Loaded query={skills} failure="Couldn’t load the skills">
        {(items) => {
          if (items.length === 0) {
            return (
              <Panel>
                <EmptyState
                  compact
                  icon={<Sparkles />}
                  title="No skills yet"
                  description="Skills come with plugins."
                  action={
                    <Link
                      to="/settings/plugins"
                      className="text-label text-foreground underline underline-offset-4"
                    >
                      Install a plugin
                    </Link>
                  }
                />
              </Panel>
            );
          }
          const byPlugin = new Map<string, SkillSummary[]>();
          for (const skill of items)
            byPlugin.set(skill.plugin, [...(byPlugin.get(skill.plugin) ?? []), skill]);
          return (
            <div className="flex flex-col gap-7">
              {[...byPlugin].map(([plugin, list]) => (
                <Section
                  key={plugin}
                  title={plugins.data?.find((item) => item.name === plugin)?.title ?? plugin}
                >
                  <ul
                    className={cn('divide-y divide-border rounded-xl', raisedSurface)}
                    aria-label={`${plugin}’s skills`}
                  >
                    {list.map((skill) => (
                      <li key={skill.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <p className="text-label text-foreground">
                            {skill.name}{' '}
                            <span className="ml-1 font-mono text-meta text-placeholder">{skill.ref}</span>
                          </p>
                          <p className="text-body-sm text-muted-foreground">{skill.description}</p>
                          {skill.compatibility ? (
                            <p className="text-caption text-muted-foreground">Needs: {skill.compatibility}</p>
                          ) : null}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Files of ${skill.name}`}
                          onClick={() => setViewing(skill)}
                        >
                          Files
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Section>
              ))}
            </div>
          );
        }}
      </Loaded>
      <SkillDialog
        skill={viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      />
    </Page>
  );
}

function SkillDialog({
  skill,
  onOpenChange,
}: {
  skill: SkillSummary | null;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useSkill(skill?.id ?? null);
  return (
    <Dialog
      open={skill !== null}
      onOpenChange={onOpenChange}
      title={skill?.name ?? ''}
      description={skill?.description}
    >
      {skill ? (
        <div className="flex flex-col gap-4 pb-4">
          <dl>
            <DetailRow label="Grant">
              <span className="font-mono">{skill.ref}</span>
            </DetailRow>
            <DetailRow label="Licence">{skill.license ?? 'None given'}</DetailRow>
            <DetailRow label="Size">{formatBytes(skill.bytes)}</DetailRow>
          </dl>
          {detail.data ? (
            <ul className="flex flex-col gap-1" aria-label="Files">
              {detail.data.files.map((file) => (
                <li key={file} className="flex items-center gap-2 font-mono text-caption text-foreground/90">
                  <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  {file}
                </li>
              ))}
            </ul>
          ) : detail.isError ? (
            <Notice
              tone="destructive"
              title="Couldn’t load its files"
              action={
                <Button size="sm" onClick={() => detail.refetch()}>
                  Retry
                </Button>
              }
            >
              {errorMessage(detail.error)}
            </Notice>
          ) : (
            <Skeleton className="h-16 rounded-lg" />
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
