import { errorMessage, ProblemError } from '@superagent/client';
import { AgentKeySchema, type AgentRole, type Department } from '@superagent/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCreateAgent } from '../../api/org';
import { slugify } from '../../lib/slug';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { FormFailure, Notice, Spinner } from '../../ui/feedback';
import { Field, Input, Textarea } from '../../ui/field';
import { Segmented } from '../../ui/tabs';
import { toast } from '../../ui/toast';

/** Keys the server keeps for its own agents. */
const isReservedKey = (key: string) => ['chief', 'scratch'].includes(key) || key.startsWith('provider-test');

/** A key for a new agent: the department's slug and the agent's name ("research-ada"). */
export function suggestKey(department: Department, name: string, role: AgentRole): string {
  const base = slugify(name, 48) || (role === 'lead' ? 'lead' : '');
  return base ? slugify(`${department.slug}-${base}`, 48) : '';
}

type Errors = { role?: string; name?: string; key?: string; description?: string; instructions?: string };

/** Adds an agent to a department: its lead, or a specialist. Its tools are chosen on its page next. */
export function NewAgentDialog({
  open,
  onOpenChange,
  department,
  role: initialRole,
  hasLead,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department: Department;
  role: AgentRole;
  hasLead: boolean;
}) {
  const navigate = useNavigate();
  const create = useCreateAgent();
  const [role, setRole] = useState<AgentRole>(initialRole);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts fresh
  useEffect(() => {
    if (!open) return;
    setRole(hasLead ? 'specialist' : initialRole);
    setName('');
    setKey('');
    setKeyEdited(false);
    setDescription('');
    setInstructions('');
    setErrors({});
    setFailure(null);
    create.reset();
  }, [open]);

  const shownKey = keyEdited ? key : suggestKey(department, name, role);
  const lead = role === 'lead';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Errors = {
      role: lead && hasLead ? `${department.name} has a lead already.` : undefined,
      name: name.trim() ? undefined : 'Give it a name.',
      key: !AgentKeySchema.safeParse(shownKey).success
        ? 'Lowercase letters, digits and dashes, up to 48.'
        : isReservedKey(shownKey)
          ? 'superagent keeps this key for itself.'
          : undefined,
      description: description.trim() ? undefined : lead ? 'Say what it does.' : 'Say what it’s good at.',
      instructions: instructions.trim() ? undefined : 'Tell it how to work.',
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    setFailure(null);
    try {
      const agent = await create.mutateAsync({
        departmentId: department.id,
        role,
        key: shownKey,
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
      });
      toast.success(
        lead ? `${agent.name} leads ${department.name}` : `${agent.name} joined ${department.name}`,
        'Choose its tools on its page.',
      );
      onOpenChange(false);
      navigate(`/agents/${encodeURIComponent(agent.key)}`);
    } catch (error) {
      const code = error instanceof ProblemError ? error.code : undefined;
      if (code === 'agent_key_taken') setErrors({ key: 'Another agent has this key.' });
      else if (code === 'reserved_agent_key') setErrors({ key: 'superagent keeps this key for itself.' });
      else if (code === 'lead_exists') setErrors({ role: `${department.name} has a lead already.` });
      else setFailure(errorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={lead ? `A lead for ${department.name}` : `A specialist for ${department.name}`}
      description={
        lead
          ? 'The lead takes every task the department gets: it plans the work, hands parts to its specialists, checks what comes back and reports to you.'
          : 'A specialist does focused work its lead hands it, and answers the lead.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-agent" variant="primary" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : null}
            {lead ? 'Add the lead' : 'Add the specialist'}
          </Button>
        </>
      }
    >
      <form id="new-agent" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        {failure ? <FormFailure>{failure}</FormFailure> : null}
        {hasLead ? (
          errors.role ? (
            <Notice tone="destructive">{errors.role}</Notice>
          ) : null
        ) : (
          // Without a lead, the first agent is usually the lead; a specialist can come first too.
          <Field label="Role" error={errors.role}>
            {() => (
              <Segmented
                aria-label="Role"
                value={role}
                onValueChange={setRole}
                options={[
                  { value: 'lead', label: 'Lead' },
                  { value: 'specialist', label: 'Specialist' },
                ]}
              />
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={100}
                placeholder={lead ? 'Ada' : 'Grace'}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field label="Key" error={errors.key} hint="Its id in tools and links. It can’t change later.">
            {(control) => (
              <Input
                {...control}
                value={shownKey}
                maxLength={48}
                className="font-mono"
                onChange={(event) => {
                  setKeyEdited(true);
                  setKey(event.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
        </div>
        <Field
          label={lead ? 'What it does' : 'What it’s good at'}
          error={errors.description}
          hint={
            lead
              ? 'Shown on the team and to your chief of staff.'
              : 'Its lead reads this to decide what to hand it, so be specific.'
          }
        >
          {(control) => (
            <Textarea
              {...control}
              value={description}
              maxLength={500}
              rows={2}
              className="min-h-16"
              placeholder={
                lead
                  ? 'Plans research tasks and turns the findings into a clear answer.'
                  : 'Finds recent, reliable sources on a topic and summarizes each with its link.'
              }
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
        <Field
          label="Instructions"
          error={errors.instructions}
          hint="superagent already tells it who it is, who its team is and how to report. Write what’s particular to this job. You can change it any time; each change is kept as a version."
        >
          {(control) => (
            <Textarea
              {...control}
              value={instructions}
              maxLength={20_000}
              rows={6}
              placeholder="Prefer primary sources. Give every claim a link. Keep summaries under 200 words, in bullet points."
              onChange={(event) => setInstructions(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
