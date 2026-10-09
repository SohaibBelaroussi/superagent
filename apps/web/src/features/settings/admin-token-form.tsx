import { ProblemError } from '@superagent/client';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '../../ui/button';
import { Field, SecretInput } from '../../ui/field';
import { Panel } from '../../ui/layout';

/** Why the server refused the token a page was given, if it did (else null). */
export function refusal(error: unknown, task: string): string | null {
  if (!(error instanceof ProblemError)) return null;
  if (error.status === 403) return `That’s a device token. ${task} takes the admin token.`;
  if (error.status === 401) return 'The server doesn’t know that token.';
  return null;
}

/**
 * Asks for the admin token a settings page needs (D45). It stays in the page's memory only: it isn't
 * kept in the browser, and leaving or reloading forgets it.
 */
export function AdminTokenForm({
  refused,
  onToken,
  purpose,
  submitLabel,
}: {
  refused: string | null;
  onToken: (token: string) => void;
  /** "to manage devices" */
  purpose: string;
  submitLabel: string;
}) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onToken(value.trim());
  };
  return (
    <Panel className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-muted-foreground shadow-rim [&_svg]:size-4">
          <KeyRound aria-hidden />
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="text-subheading text-foreground">The admin token, {purpose}</h2>
          <p className="text-body-sm text-muted-foreground">
            It stays on this page only: it isn’t kept in the browser, and leaving or reloading forgets it.
          </p>
        </div>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Field label="Admin token" error={refused ?? undefined} className="flex-1">
          {(control) => (
            <SecretInput
              {...control}
              value={value}
              inputClassName="font-mono"
              revealLabel="Show the token"
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" className="sm:mt-6.5" disabled={!value.trim()}>
          {submitLabel}
        </Button>
      </form>
    </Panel>
  );
}
