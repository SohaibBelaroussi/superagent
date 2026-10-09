import { formatList } from '@superagent/client';
import type { OwnerProfile, OwnerProfilePatch } from '@superagent/shared';
import { Plus, X } from 'lucide-react';
import { useId } from 'react';
import { useUpdateProfile } from '../../api/memory';
import { useProfile } from '../../api/queries';
import { Loaded } from '../../layout/loaded';
import { useServerDraft } from '../../lib/server-draft';
import { timezones } from '../../lib/timezones';
import { useDocumentTitle } from '../../lib/title';
import { UnsavedChangesDialog, useUnsavedChanges } from '../../lib/unsaved';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/feedback';
import { Field, Input, Textarea } from '../../ui/field';
import { Page, PageHeader, Panel, Section } from '../../ui/layout';
import { SaveBar } from '../../ui/settings';
import { toast } from '../../ui/toast';

export interface ProfileDraft {
  name: string;
  language: string;
  timezone: string;
  communicationStyle: string;
  preferences: string[];
  about: string;
}

const TEXT_FIELDS = ['name', 'language', 'timezone', 'communicationStyle', 'about'] as const;

export function profileDraft(profile: OwnerProfile): ProfileDraft {
  return {
    name: profile.name ?? '',
    language: profile.language ?? '',
    timezone: profile.timezone ?? '',
    communicationStyle: profile.communicationStyle ?? '',
    preferences: profile.preferences ?? [],
    about: profile.about ?? '',
  };
}

const tidy = (items: readonly string[]) => items.map((item) => item.trim()).filter(Boolean);

/**
 * What you changed in `draft` from `base`: those fields only, an emptied one as null (which removes
 * it). Both sides are trimmed: the chief may store a value with spaces around it.
 */
export function profileChanges(base: ProfileDraft, draft: ProfileDraft): OwnerProfilePatch {
  const patch: OwnerProfilePatch = {};
  for (const field of TEXT_FIELDS) {
    const next = draft[field].trim();
    if (next !== base[field].trim()) patch[field] = next || null;
  }
  const preferences = tidy(draft.preferences);
  const current = tidy(base.preferences);
  if (preferences.length !== current.length || preferences.some((item, index) => item !== current[index])) {
    patch.preferences = preferences.length > 0 ? preferences : null;
  }
  return patch;
}

const PROFILE_FIELDS: Record<keyof OwnerProfilePatch, string> = {
  name: 'name',
  language: 'language',
  timezone: 'timezone',
  communicationStyle: 'how you like answers',
  preferences: 'preferences',
  about: 'about you',
};

/** What your agents know about you: the chief keeps it as you talk, you correct it here. */
export function ProfilePage() {
  useDocumentTitle('Your profile');
  const profile = useProfile();
  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Your profile"
          description="What your agents know about you. Your chief of staff keeps it up to date as you talk, and every agent reads it. Correct anything here."
        />
      }
    >
      <Loaded
        query={profile}
        failure="Couldn’t load your profile"
        skeleton={<Panel className="h-96 animate-pulse" />}
      >
        {(data) => <ProfileForm profile={data} />}
      </Loaded>
    </Page>
  );
}

function ProfileForm({ profile }: { profile: OwnerProfile }) {
  const update = useUpdateProfile();
  // The chief writes it too: what you change is the difference from where you started, and its changes
  // meanwhile are taken in with yours on top.
  const editor = useServerDraft({
    server: profile,
    revision: profile,
    toDraft: profileDraft,
    diff: profileChanges,
  });
  const { draft, patch, changes, dirty } = editor;
  const blocker = useUnsavedChanges(dirty);
  const zones = useId();

  const save = async () => {
    try {
      await editor.save((sent) => update.mutateAsync(sent));
      toast.success('Profile saved', 'Your agents read it from their next turn.');
    } catch {
      // The mutation's own toast says what went wrong.
    }
  };

  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) void save();
      }}
      noValidate
    >
      {dirty && editor.changedElsewhere ? (
        <Notice
          tone="warning"
          title="Your chief of staff updated your profile while you were editing"
          action={
            <Button size="sm" onClick={editor.discard}>
              Discard mine
            </Button>
          }
        >
          It’s shown here as it is now, with your changes to{' '}
          {formatList(
            (Object.keys(changes) as (keyof OwnerProfilePatch)[]).map((field) => PROFILE_FIELDS[field]),
          )}{' '}
          on top. Saving sends only those.
        </Notice>
      ) : null}
      <Section title="You">
        <Panel className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="Name">
            {(control) => (
              <Input
                {...control}
                value={draft.name}
                maxLength={200}
                autoComplete="name"
                onChange={(event) => patch({ name: event.target.value })}
              />
            )}
          </Field>
          <Field label="Language" hint="The one agents answer in.">
            {(control) => (
              <Input
                {...control}
                value={draft.language}
                maxLength={100}
                placeholder="English"
                onChange={(event) => patch({ language: event.target.value })}
              />
            )}
          </Field>
          <Field label="Timezone" hint="Where you are, for agents’ sense of your day.">
            {(control) => (
              <Input
                {...control}
                list={zones}
                value={draft.timezone}
                maxLength={100}
                spellCheck={false}
                placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
                onChange={(event) => patch({ timezone: event.target.value })}
              />
            )}
          </Field>
          <datalist id={zones}>
            {timezones().map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </Panel>
      </Section>

      <Section title="How you work">
        <Panel className="flex flex-col gap-4 p-4">
          <Field label="How you like answers" hint="Length, tone, format.">
            {(control) => (
              <Textarea
                {...control}
                value={draft.communicationStyle}
                maxLength={1000}
                rows={3}
                placeholder="Short and direct. Bullet points over paragraphs. Always say what you’d do next."
                onChange={(event) => patch({ communicationStyle: event.target.value })}
              />
            )}
          </Field>
          <Preferences value={draft.preferences} onChange={(preferences) => patch({ preferences })} />
          <Field label="About you" hint="Your work, your projects, anything worth knowing.">
            {(control) => (
              <Textarea
                {...control}
                value={draft.about}
                maxLength={4000}
                rows={6}
                onChange={(event) => patch({ about: event.target.value })}
              />
            )}
          </Field>
        </Panel>
      </Section>

      <SaveBar
        open={dirty}
        saving={update.isPending}
        message="Unsaved changes to your profile."
        onDiscard={editor.discard}
        onSave={() => void save()}
      />
      <UnsavedChangesDialog blocker={blocker} what="your profile" />
    </form>
  );
}

/** A list of short preferences, one per line, each removable. */
function Preferences({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-hint`}>
      <legend className="mb-1.5 text-label text-foreground">Preferences</legend>
      <p id={`${id}-hint`} className="-mt-1 text-caption text-muted-foreground">
        One per line, like “cite sources” or “no meetings before 10”.
      </p>
      {value.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; their place is their identity
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Preference ${index + 1}`}
            value={item}
            maxLength={500}
            onChange={(event) =>
              onChange(value.map((current, at) => (at === index ? event.target.value : current)))
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={`Remove preference ${index + 1}`}
            onClick={() => onChange(value.filter((_, at) => at !== index))}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="w-fit"
        disabled={value.length >= 50}
        onClick={() => onChange([...value, ''])}
      >
        <Plus aria-hidden />
        Add a preference
      </Button>
    </fieldset>
  );
}
