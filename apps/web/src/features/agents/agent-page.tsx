import type { AgentDefinition, Department } from '@superagent/shared';
import { Archive, Ellipsis, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client';
import {
  useAgentVersions,
  useArchiveAgent,
  useBrowserIdentities,
  useCapabilities,
  useUpdateAgent,
} from '../../api/org';
import { Loaded } from '../../layout/loaded';
import { cn } from '../../lib/cn';
import { formatDate, formatList } from '../../lib/format';
import { useServerDraft } from '../../lib/server-draft';
import { useDocumentTitle } from '../../lib/title';
import { departmentTone, TONE_DOT } from '../../lib/tones';
import { pastUnsaved, UnsavedChangesDialog, useUnsavedChanges } from '../../lib/unsaved';
import { Avatar } from '../../ui/avatar';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/dialog';
import { Notice } from '../../ui/feedback';
import { Field, Input, Textarea } from '../../ui/field';
import { Page, PageHeader, Panel, Section } from '../../ui/layout';
import { Menu, MenuItem } from '../../ui/menu';
import { SaveBar } from '../../ui/settings';
import { TabCount, TabPanel, Tabs } from '../../ui/tabs';
import { toast } from '../../ui/toast';
import { useOrg } from '../tasks/org';
import { OrgMiss } from '../tasks/org-miss';
import {
  type AgentDraftErrors,
  agentChanges,
  agentDraft,
  agentDraftErrors,
  agentFieldNames,
  makesVersion,
} from './draft';
import { McpGrants, SkillGrants, ToolGrants } from './grants';
import { ModelSelect } from './model-select';
import { AgentVersions } from './versions';

type AgentTab = 'definition' | 'versions';

/** An agent: its definition (saved as a new version) and its versions. */
export function AgentPage() {
  const { agentKey = '' } = useParams();
  const org = useOrg();
  const agent = org.agentByKey(agentKey);
  useDocumentTitle(agent?.name ?? 'Agent');

  if (!agent) {
    return (
      <OrgMiss
        org={org}
        name={agentKey}
        icon={<UserRound />}
        title="No such agent"
        description={`There’s no agent “${agentKey}”. It may have a different key.`}
      />
    );
  }
  return <AgentEditor key={agent.id} agent={agent} department={org.department(agent.departmentId)} />;
}

function AgentEditor({ agent, department }: { agent: AgentDefinition; department: Department | undefined }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: AgentTab = params.get('tab') === 'versions' ? 'versions' : 'definition';
  const capabilities = useCapabilities();
  const versions = useAgentVersions(agent.id);
  const update = useUpdateAgent(agent.id);
  const archive = useArchiveAgent(agent.id);
  const readOnly = Boolean(agent.archivedAt);

  // What you change is the difference from where you started: saved here, another version put in
  // use, or a save elsewhere is taken in, with your changes kept on top.
  const editor = useServerDraft({
    server: agent,
    revision: agent.updatedAt,
    toDraft: agentDraft,
    diff: agentChanges,
  });
  const { draft, patch, changes } = editor;
  const [errors, setErrors] = useState<AgentDraftErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const dirty = !readOnly && editor.dirty;
  const blocker = useUnsavedChanges(dirty);
  const browserGranted = draft.tools.some((grant) => grant.key === 'browser');
  const identities = useBrowserIdentities(browserGranted);

  const serverName = (slug: string) =>
    capabilities.data?.mcpServers.find((server) => server.slug === slug)?.name ?? slug;
  const nextVersion = Math.max(agent.activeVersion, versions.data?.[0]?.version ?? 0) + 1;
  const newVersion = makesVersion(changes);

  const discard = () => {
    editor.discard();
    setErrors({});
    setFailure(null);
  };

  const save = async () => {
    const found = agentDraftErrors(draft, serverName);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      if (tab !== 'definition') setParams({}, { replace: true });
      return;
    }
    setFailure(null);
    try {
      const saved = await editor.save((sent) => update.mutateAsync(sent));
      toast.success(
        newVersion ? `Saved as version ${saved.activeVersion}` : 'Saved',
        newVersion ? `${saved.name} works this way from its next run.` : undefined,
      );
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  const tone = department ? departmentTone(department.slug) : 'neutral';
  return (
    <Page width="medium">
      <PageHeader
        eyebrow={
          department ? (
            <Link
              to={`/departments/${encodeURIComponent(department.slug)}?tab=team`}
              className="flex items-center gap-1.5 hover:text-foreground"
            >
              <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[tone])} />
              {department.name}
              <span aria-hidden>·</span>
              Team
            </Link>
          ) : undefined
        }
        title={
          <span className="flex items-center gap-3">
            <Avatar name={agent.name} tone={tone} size="lg" />
            {agent.name}
          </span>
        }
        description={agent.current.description}
        actions={
          <>
            <Badge tone={agent.role === 'lead' ? 'purple' : 'neutral'} size="md">
              {agent.role === 'lead' ? 'Lead' : 'Specialist'}
            </Badge>
            <Badge size="md">Version {agent.activeVersion}</Badge>
            <span className="font-mono text-caption text-placeholder">{agent.key}</span>
            {readOnly ? null : (
              <Menu
                trigger={
                  <Button variant="ghost" size="icon-md" tooltip={`More for ${agent.name}`}>
                    <Ellipsis aria-hidden />
                  </Button>
                }
              >
                <MenuItem icon={<Archive aria-hidden />} destructive onClick={() => setArchiveOpen(true)}>
                  Archive {agent.name}…
                </MenuItem>
              </Menu>
            )}
          </>
        }
      />

      {readOnly ? (
        <Notice
          tone="info"
          title={`Archived ${formatDate(agent.archivedAt ?? agent.updatedAt)}`}
          className="mb-5"
        >
          {agent.name} takes no new work. Its versions are kept for the record.
        </Notice>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(next) => setParams(next === 'definition' ? {} : { tab: next }, { replace: true })}
        items={[
          { value: 'definition', label: 'Definition' },
          {
            value: 'versions',
            label: 'Versions',
            meta: versions.data ? <TabCount>{versions.data.length}</TabCount> : undefined,
          },
        ]}
      >
        <TabPanel value="definition" className="pt-6">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (dirty) void save();
            }}
            className="flex flex-col gap-8"
            noValidate
          >
            {dirty && editor.changedElsewhere ? (
              <Notice
                tone="warning"
                title={`${agent.name} changed while you were editing`}
                action={
                  <Button size="sm" onClick={discard}>
                    Discard mine
                  </Button>
                }
              >
                It’s on version {agent.activeVersion} now, shown here with your changes to{' '}
                {formatList(agentFieldNames(changes))} on top. Saving sends only those.
              </Notice>
            ) : null}
            {failure ? (
              <Notice tone="destructive" title="Couldn’t save">
                {failure}
              </Notice>
            ) : null}

            <Section title="Profile">
              <Panel className="flex flex-col gap-4 p-4">
                <Field label="Name" error={errors.name}>
                  {(control) => (
                    <Input
                      {...control}
                      value={draft.name}
                      maxLength={100}
                      disabled={readOnly}
                      onChange={(event) => patch({ name: event.target.value })}
                    />
                  )}
                </Field>
                <Field
                  label="Description"
                  error={errors.description}
                  hint={
                    agent.role === 'lead'
                      ? 'What it does. The chief of staff and your team pages show it.'
                      : 'What it’s good at. Its lead reads this to decide what to hand it.'
                  }
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      value={draft.description}
                      maxLength={500}
                      rows={2}
                      className="min-h-16"
                      disabled={readOnly}
                      onChange={(event) => patch({ description: event.target.value })}
                    />
                  )}
                </Field>
                <Field
                  label="Model"
                  hint="The default comes from settings, for every agent that doesn’t pick one."
                >
                  {(control) => (
                    <ModelSelect
                      {...control}
                      value={draft.model}
                      disabled={readOnly}
                      onChange={(model) => patch({ model })}
                    />
                  )}
                </Field>
              </Panel>
            </Section>

            <Section title="Instructions">
              <Panel className="p-4">
                <Field
                  label={`How ${draft.name.trim() || agent.name} works`}
                  error={errors.instructions}
                  hint={
                    <>
                      superagent already tells it who it is, who its team is and how to report. Write what is
                      particular to this job: what to focus on, the standard you expect, sources to prefer or
                      avoid, the shape of its results. Markdown works.{' '}
                      <span className="tabular-nums">
                        {draft.instructions.length.toLocaleString()} / 20,000
                      </span>
                    </>
                  }
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      value={draft.instructions}
                      maxLength={20_000}
                      disabled={readOnly}
                      className="max-h-[70dvh] min-h-64"
                      onChange={(event) => patch({ instructions: event.target.value })}
                    />
                  )}
                </Field>
              </Panel>
            </Section>

            <Section title="Tools">
              <Loaded query={capabilities} failure="Couldn’t load what agents can use">
                {(caps) => (
                  <ToolGrants
                    value={draft.tools}
                    onChange={(tools) => patch({ tools })}
                    tools={caps.tools}
                    identities={identities.data}
                    disabled={readOnly}
                  />
                )}
              </Loaded>
            </Section>

            <Section title="Skills">
              <Loaded query={capabilities} failure="Couldn’t load what agents can use">
                {(caps) => (
                  <SkillGrants
                    value={draft.skills}
                    onChange={(skills) => patch({ skills })}
                    skills={caps.skills}
                    plugins={caps.plugins}
                    inherited={department?.skills}
                    inheritedFrom={department?.name}
                    disabled={readOnly}
                  />
                )}
              </Loaded>
            </Section>

            <Section title="MCP servers">
              {errors.mcp ? <Notice tone="destructive">{errors.mcp}</Notice> : null}
              <Loaded query={capabilities} failure="Couldn’t load what agents can use">
                {(caps) => (
                  <McpGrants
                    value={draft.mcp}
                    onChange={(mcp) => patch({ mcp })}
                    servers={caps.mcpServers}
                    inherited={department?.mcp}
                    inheritedFrom={department?.name}
                    disabled={readOnly}
                  />
                )}
              </Loaded>
            </Section>
          </form>
        </TabPanel>
        <TabPanel value="versions" className="pt-6">
          <AgentVersions agent={agent} readOnly={readOnly} />
        </TabPanel>
      </Tabs>

      <SaveBar
        open={dirty}
        saving={update.isPending}
        message={
          newVersion
            ? `Saving makes version ${nextVersion}. ${agent.name} uses it from its next run.`
            : 'Unsaved changes.'
        }
        saveLabel={newVersion ? `Save as version ${nextVersion}` : 'Save'}
        onDiscard={discard}
        onSave={() => void save()}
      />

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${agent.name}?`}
        description={
          agent.role === 'lead'
            ? `${agent.name} stops leading ${department?.name ?? 'its department'}: new tasks there wait in the inbox until it has a lead again. Its versions are kept. This can’t be undone.`
            : `${agent.name} leaves ${department?.name ?? 'its department'}’s team and takes no new work. Its versions are kept. This can’t be undone.`
        }
        confirmLabel="Archive"
        destructive
        busy={archive.isPending}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              setArchiveOpen(false);
              toast.success(`${agent.name} is archived`);
              navigate(
                department ? `/departments/${encodeURIComponent(department.slug)}?tab=team` : '/departments',
                { state: pastUnsaved },
              );
            },
            onError: () => setArchiveOpen(false),
          })
        }
      />
      <UnsavedChangesDialog blocker={blocker} what={agent.name} />
    </Page>
  );
}
