import type { Settings } from '@superagent/shared';
import { useId, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useSettings } from '../../api/org';
import { useUpdateSettings } from '../../api/settings';
import { Loaded } from '../../layout/loaded';
import { notificationsSupported, useNotificationsOn } from '../../lib/notifications';
import { useServerDraft } from '../../lib/server-draft';
import { THEME_CHOICES, useTheme } from '../../lib/theme';
import { isTimezone, timezones } from '../../lib/timezones';
import { useDocumentTitle } from '../../lib/title';
import { UnsavedChangesDialog, useUnsavedChanges } from '../../lib/unsaved';
import { Notice } from '../../ui/feedback';
import { Input } from '../../ui/field';
import { Page, PageHeader, Panel, Section } from '../../ui/layout';
import { SaveBar, SettingRow, SettingsList, settingLabels } from '../../ui/settings';
import { SwitchControl } from '../../ui/switch';
import { Segmented } from '../../ui/tabs';
import { toast } from '../../ui/toast';
import { toggleNotifications } from '../inbox/notify';

interface TimeDraft {
  timezone: string;
}

const timeDraft = (settings: Settings): TimeDraft => ({ timezone: settings.timezone });
const timeChanges = (base: TimeDraft, draft: TimeDraft): Partial<TimeDraft> =>
  draft.timezone.trim() !== base.timezone ? { timezone: draft.timezone.trim() } : {};

/** The server's timezone, and how this browser shows the app. */
export function GeneralPage() {
  useDocumentTitle('General');
  const settings = useSettings();
  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="General"
          description="The timezone superagent works in, and how this browser shows it."
        />
      }
    >
      <div className="flex flex-col gap-8">
        <Section title="Time">
          <Loaded
            query={settings}
            failure="Couldn’t load the settings"
            skeleton={<Panel className="h-24 animate-pulse" />}
          >
            {(data) => <TimeForm settings={data} />}
          </Loaded>
        </Section>
        <Section title="This browser">
          <BrowserPreferences />
        </Section>
      </div>
    </Page>
  );
}

function TimeForm({ settings }: { settings: Settings }) {
  const update = useUpdateSettings();
  const editor = useServerDraft({
    server: settings,
    revision: settings,
    toDraft: timeDraft,
    diff: timeChanges,
  });
  const { draft, patch, changes, dirty } = editor;
  const blocker = useUnsavedChanges(dirty);
  const [failure, setFailure] = useState<string | null>(null);
  const ids = { timezone: useId(), zones: useId() };
  const invalid = !isTimezone(draft.timezone.trim());

  const save = async () => {
    if (invalid) return;
    setFailure(null);
    try {
      await editor.save(() => update.mutateAsync(changes));
      toast.success('Timezone saved', 'New schedules use it; each existing one keeps its own.');
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) void save();
      }}
      noValidate
    >
      {failure ? (
        <Notice tone="destructive" title="Couldn’t save" className="mb-3">
          {failure}
        </Notice>
      ) : null}
      <SettingsList>
        <SettingRow
          label="Timezone"
          htmlFor={ids.timezone}
          description={
            dirty && invalid ? (
              <span className="text-destructive-foreground">Not a timezone this browser knows.</span>
            ) : (
              'New schedules run in it, and agents tell the time by it.'
            )
          }
          wide
          control={
            <>
              <Input
                id={ids.timezone}
                list={ids.zones}
                value={draft.timezone}
                spellCheck={false}
                aria-invalid={dirty && invalid ? true : undefined}
                aria-describedby={`${ids.timezone}-description`}
                onChange={(event) => patch({ timezone: event.target.value })}
              />
              <datalist id={ids.zones}>
                {timezones(draft.timezone).map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </>
          }
        />
      </SettingsList>
      <SaveBar
        open={dirty}
        saving={update.isPending}
        message="The timezone isn’t saved yet."
        onDiscard={editor.discard}
        onSave={() => void save()}
      />
      <UnsavedChangesDialog blocker={blocker} what="the timezone" />
    </form>
  );
}

/** The theme and notifications: kept in this browser, applied at once. */
function BrowserPreferences() {
  const { choice, setChoice } = useTheme();
  const notifying = useNotificationsOn();
  const ids = { notify: useId() };
  return (
    <SettingsList>
      <SettingRow
        label="Theme"
        description="Dark, light, or whatever your system uses."
        control={
          <Segmented
            aria-label="Theme"
            size="sm"
            value={choice}
            onValueChange={setChoice}
            options={THEME_CHOICES.map((theme) => ({ value: theme.value, label: theme.label }))}
          />
        }
      />
      {notificationsSupported() ? (
        <SettingRow
          label="Notifications"
          htmlFor={ids.notify}
          description="While superagent is hidden, tell me when something needs me."
          control={
            <SwitchControl
              id={ids.notify}
              {...settingLabels(ids.notify)}
              checked={notifying}
              onCheckedChange={() => void toggleNotifications(notifying)}
            />
          }
        />
      ) : null}
    </SettingsList>
  );
}
