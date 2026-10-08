import type { AgentDefinition, AgentRole, Department } from '@superagent/shared';
import { Crown, Plus, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';
import { departmentTone } from '../../lib/tones';
import { Avatar } from '../../ui/avatar';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/feedback';
import { Panel, Section } from '../../ui/layout';
import { colorTransition, focusRingInset } from '../../ui/recipes';
import { toolName } from '../agents/grants';
import { modelLabel } from '../agents/model-select';
import { NewAgentDialog } from '../agents/new-agent-dialog';

export interface Team {
  lead: AgentDefinition | undefined;
  specialists: AgentDefinition[];
  archived: AgentDefinition[];
}

/** A department's team: its lead, its specialists, and the agents it had. */
export function TeamTab({
  department,
  team,
  readOnly,
}: {
  department: Department;
  team: Team;
  readOnly: boolean;
}) {
  const [adding, setAdding] = useState<AgentRole | null>(null);
  return (
    <div className="flex flex-col gap-8">
      <Section title="Lead">
        {team.lead ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <AgentCard agent={team.lead} department={department} />
          </div>
        ) : (
          <Panel>
            <EmptyState
              compact
              icon={<Crown />}
              title="No lead yet"
              description="The lead takes the department’s tasks: it plans them, hands parts to specialists and reports back. Until there is one, new tasks wait in the inbox."
              action={
                readOnly ? undefined : (
                  <Button variant="primary" onClick={() => setAdding('lead')}>
                    <Plus aria-hidden />
                    Add the lead
                  </Button>
                )
              }
            />
          </Panel>
        )}
      </Section>

      <Section
        title="Specialists"
        action={
          readOnly || team.specialists.length === 0 ? undefined : (
            <Button size="sm" onClick={() => setAdding('specialist')}>
              <Plus aria-hidden />
              Add a specialist
            </Button>
          )
        }
      >
        {team.specialists.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2" aria-label="Specialists">
            {team.specialists.map((agent) => (
              <li key={agent.id} className="flex">
                <AgentCard agent={agent} department={department} />
              </li>
            ))}
          </ul>
        ) : (
          <Panel>
            <EmptyState
              compact
              icon={<UsersRound />}
              title="No specialists yet"
              description="Specialists do focused work the lead hands them: finding sources, writing, checking. Without them, the lead does the work itself."
              action={
                readOnly ? undefined : (
                  <Button onClick={() => setAdding('specialist')}>
                    <Plus aria-hidden />
                    Add a specialist
                  </Button>
                )
              }
            />
          </Panel>
        )}
      </Section>

      {team.archived.length > 0 ? (
        <Section title="Archived">
          <ul className="flex flex-col" aria-label="Archived agents">
            {team.archived.map((agent) => (
              <li key={agent.id}>
                <Link
                  to={`/agents/${encodeURIComponent(agent.key)}`}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-body-sm text-muted-foreground outline-hidden hover:bg-fill-subtle hover:text-foreground',
                    colorTransition,
                    focusRingInset,
                  )}
                >
                  <Avatar name={agent.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate">
                    {agent.name}, {agent.role === 'lead' ? 'lead' : 'specialist'}
                  </span>
                  <span className="text-caption">
                    Archived {formatDate(agent.archivedAt ?? agent.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <NewAgentDialog
        open={adding !== null}
        onOpenChange={(open) => {
          if (!open) setAdding(null);
        }}
        department={department}
        role={adding ?? 'specialist'}
        hasLead={Boolean(team.lead)}
      />
    </div>
  );
}

/** An agent on its department's team: who it is, what it's good at, its model and tools. */
export function AgentCard({ agent, department }: { agent: AgentDefinition; department: Department }) {
  const titleId = `agent-${agent.id}`;
  const tools = agent.current.tools;
  const asking =
    tools.filter((grant) => grant.requireApproval).length +
    agent.current.mcp.filter((grant) => grant.requireApproval).length;
  return (
    <article
      aria-labelledby={titleId}
      className="relative flex w-full flex-col gap-3 rounded-xl bg-card p-4 shadow-raised hover:[--surface-tint:var(--fill-subtle)]"
    >
      <Link
        to={`/agents/${encodeURIComponent(agent.key)}`}
        aria-labelledby={titleId}
        className={cn('absolute inset-0 rounded-xl outline-hidden', focusRingInset)}
      />
      <div className="flex items-center gap-2.5">
        <Avatar name={agent.name} tone={departmentTone(department.slug)} size="md" />
        <div className="flex min-w-0 flex-col">
          <h3 id={titleId} className="truncate text-card-title text-foreground">
            {agent.name}
          </h3>
          <p className="truncate text-caption text-muted-foreground">
            {agent.role === 'lead' ? 'Lead' : 'Specialist'} · version {agent.activeVersion}
          </p>
        </div>
      </div>
      <p className="line-clamp-2 text-body-sm text-muted-foreground">{agent.current.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Badge>{modelLabel(agent.current.model)}</Badge>
        {tools.slice(0, 4).map((grant) => (
          <Badge key={grant.key} tone="blue">
            {toolName(grant.key)}
          </Badge>
        ))}
        {tools.length > 4 ? <Badge>+{tools.length - 4}</Badge> : null}
        {tools.length === 0 ? <span className="text-caption text-placeholder">No tools</span> : null}
        {asking > 0 ? (
          <Badge tone="orange">
            {asking} {asking === 1 ? 'tool asks first' : 'tools ask first'}
          </Badge>
        ) : null}
      </div>
    </article>
  );
}
