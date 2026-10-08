import type { OwnerProfile, OwnerProfilePatch } from '@superagent/shared';
import { Plus, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useUpdateProfile } from '../../api/memory';
import { useProfile } from '../../api/queries';
import { Loaded } from '../../layout/loaded';
import { timezones } from '../../lib/timezones';
import { useDocumentTitle } from '../../lib/title';
import { UnsavedChangesDialog, useUnsavedChanges } from '../../lib/unsaved';
import { Button } from '../../ui/button';
import { Field, Input, Textarea } from '../../ui/field';
import { Page, PageHeader, Panel, Section } from '../../ui/layout';
import { SaveBar } from '../../ui/settings';
import { toast } from '../../ui/toast';

interface ProfileDraft {
  name: string;
  language: string;
  timezone: string;
  communicationStyle: string;
  preferences: string[];
  about: string;
}

const TEXT_FIELDS = ['name', 'language', 'timezone', 'communicationStyle', 'about'] as const;

function profileDraft(profile: OwnerProfile): ProfileDraft {
  return {
    name: profile.name ?? '',
    language: profile.language ?? '',
    timezone: profile.timezone ?? '',
    communicationStyle: profile.communicationStyle ?? '',
    preferences: profile.preferences ?? [],
    about: profile.about ?? '',
  };
}

/** What saving the draft sends: changed fields only, an emptied one as null (which removes it). */
export function profileChanges(profile: OwnerProfile, draft: ProfileDraft): OwnerProfilePatch {
  const patch: OwnerProfilePatch = {};
  for (const field of TEXT_FIELDS) {
    const next = draft[field].trim();
    if (next !== (profile[field] ?? '')) patch[field] = next || null;
  }
  const preferences = draft.preferences.map((item) => item.trim()).filter(Boolean);
  const current = profile.preferences ?? [];
  if (preferences.length !== current.length || preferences.some((item, index) => item !== current[index])) {
    patch.preferences = preferences.length > 0 ? preferences : null;
  }
  return patch;
}

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
  const [draft, setDraft] = useState(() => profileDraft(profile));
  const changes = profileChanges(profile, draft);
  const dirty = Object.keys(changes).length > 0;
  const blocker = useUnsavedChanges(dirty);
  const zones = useId();

  // The chief saved something while you weren't editing: show it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new saved profile only
  useEffect(() => {
    if (!dirty) setDraft(profileDraft(profile));
  }, [profile]);

  const patch = (next: Partial<ProfileDraft>) => setDraft((current) => ({ ...current, ...next }));
  const save = () =>
    update.mutate(changes, {
      onSuccess: () => toast.success('Profile saved', 'Your agents read it from their next turn.'),
    });

  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) save();
      }}
      noValidate
    >
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
        onDiscard={() => setDraft(profileDraft(profile))}
        onSave={save}
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
