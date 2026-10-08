import type { AgentDefinition, Department } from '@superagent/shared';
import { Archive } from 'lucide-react';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { useArchiveDepartment, useCapabilities, useUpdateDepartment } from '../../api/org';
import { Loaded } from '../../layout/loaded';
import { formatList } from '../../lib/format';
import { useServerDraft } from '../../lib/server-draft';
import { pastUnsaved, useReportUnsaved } from '../../lib/unsaved';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { Notice } from '../../ui/feedback';
import { Input, Textarea } from '../../ui/field';
import { Section } from '../../ui/layout';
import { SaveBar, SettingRow, SettingsList, settingLabels } from '../../ui/settings';
import { SwitchControl } from '../../ui/switch';
import { toast } from '../../ui/toast';
import { departmentChanges, departmentDraft, departmentFieldNames } from '../agents/draft';
import { McpGrants, SkillGrants } from '../agents/grants';

/** A department's settings: its name and purpose, review, what all its agents get, and archiving it. */
export function DepartmentSettings({
  department,
  agents,
  onUnsavedChange,
}: {
  department: Department;
  /** Its active agents: archiving waits until there are none. */
  agents: readonly AgentDefinition[];
  /** Whether there are unsaved changes: the page asks before you leave. */
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const update = useUpdateDepartment(department.id);
  const archive = useArchiveDepartment(department.id);
  // What you change is the difference from where you started: a save elsewhere is taken in, with your
  // changes kept on top.
  const editor = useServerDraft({
    server: department,
    revision: department.updatedAt,
    toDraft: departmentDraft,
    diff: departmentChanges,
  });
  const { draft, patch, changes, dirty } = editor;
  const [errors, setErrors] = useState<{ name?: string; mcp?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  useReportUnsaved(dirty, onUnsavedChange);
  const ids = { name: useId(), description: useId(), autoClose: useId() };

  const discard = () => {
    editor.discard();
    setErrors({});
    setFailure(null);
  };
  const save = async () => {
    const empty = draft.mcp.find((grant) => grant.tools?.length === 0);
    const found = {
      name: draft.name.trim() ? undefined : 'Give it a name.',
      mcp: empty ? `Pick at least one of ${empty.server}’s tools, or give all of them.` : undefined,
    };
    setErrors(found);
    if (found.name || found.mcp) return;
    setFailure(null);
    try {
      const saved = await editor.save((sent) => update.mutateAsync(sent));
      toast.success('Saved', `${saved.name}’s agents use it from their next run.`);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {dirty && editor.changedElsewhere ? (
        <Notice
          tone="warning"
          title={`${department.name} changed while you were editing`}
          action={
            <Button size="sm" onClick={discard}>
              Discard mine
            </Button>
          }
        >
          It’s shown here as it is now, with your changes to {formatList(departmentFieldNames(changes))} on
          top. Saving sends only those.
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="destructive" title="Couldn’t save">
          {failure}
        </Notice>
      ) : null}
      <Section title="About">
        <SettingsList>
          <SettingRow
            label="Name"
            htmlFor={ids.name}
            wide
            control={
              <Input
                id={ids.name}
                value={draft.name}
                maxLength={100}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? `${ids.name}-description` : undefined}
                onChange={(event) => patch({ name: event.target.value })}
              />
            }
            description={
              errors.name ? <span className="text-destructive-foreground">{errors.name}</span> : undefined
            }
          />
          <SettingRow
            label="What it’s for"
            htmlFor={ids.description}
            description="Your chief of staff reads this to choose which department gets a task."
          >
            <Textarea
              id={ids.description}
              value={draft.description}
              maxLength={1000}
              rows={3}
              onChange={(event) => patch({ description: event.target.value })}
            />
          </SettingRow>
          <SettingRow
            label="Close finished tasks without my review"
            htmlFor={ids.autoClose}
            description="Tasks close as soon as the lead reports, instead of waiting for you to accept them."
            control={
              <SwitchControl
                id={ids.autoClose}
                {...settingLabels(ids.autoClose)}
                checked={draft.autoClose}
                onCheckedChange={(autoClose) => patch({ autoClose })}
              />
            }
          />
          <SettingRow
            label="Slug"
            description="In links. It can’t change."
            control={<span className="font-mono text-body-sm text-muted-foreground">{department.slug}</span>}
          />
        </SettingsList>
      </Section>

      <Section title={`Skills for everyone in ${department.name}`}>
        <Loaded query={capabilities} failure="Couldn’t load the skills">
          {(caps) => (
            <SkillGrants
              value={draft.skills}
              onChange={(skills) => patch({ skills })}
              skills={caps.skills}
              plugins={caps.plugins}
            />
          )}
        </Loaded>
      </Section>

      <Section title={`MCP servers for everyone in ${department.name}`}>
        {errors.mcp ? <Notice tone="destructive">{errors.mcp}</Notice> : null}
        <Loaded query={capabilities} failure="Couldn’t load the MCP servers">
          {(caps) => (
            <McpGrants value={draft.mcp} onChange={(mcp) => patch({ mcp })} servers={caps.mcpServers} />
          )}
        </Loaded>
      </Section>

      <Section title="Archive">
        <SettingsList>
          <SettingRow
            label={`Archive ${department.name}`}
            description={
              agents.length > 0
                ? `Archive its agents first: ${formatList(agents.map((agent) => agent.name))}.`
                : 'It takes no new tasks and its schedules pause. Its tasks, notes and history stay for the record. This can’t be undone.'
            }
            control={
              <Button
                variant="destructive-ghost"
                disabled={agents.length > 0}
                onClick={() => setArchiveOpen(true)}
              >
                <Archive aria-hidden />
                Archive…
              </Button>
            }
          />
        </SettingsList>
      </Section>

      <SaveBar
        open={dirty}
        saving={update.isPending}
        message="Unsaved changes to the department."
        onDiscard={discard}
        onSave={() => void save()}
      />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${department.name}?`}
        description="It takes no new tasks and its schedules pause. Its tasks, notes and history stay. This can’t be undone."
        confirmLabel="Archive"
        destructive
        busy={archive.isPending}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              setArchiveOpen(false);
              toast.success(`${department.name} is archived`);
              navigate('/departments', { state: pastUnsaved });
            },
            onError: () => setArchiveOpen(false),
          })
        }
      />
    </div>
  );
}
