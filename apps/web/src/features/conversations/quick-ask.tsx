import { ArrowUp } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { composerSurface } from '../../ui/recipes';
import type { ChiefDraft } from './chief-page';

/** One line to the chief of staff: the conversation opens with it sent. */
export function QuickAsk() {
  const [text, setText] = useState('');
  const navigate = useNavigate();

  function submit(event: FormEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message) return;
    const state: ChiefDraft = { send: message };
    navigate('/chief', { state });
  }

  return (
    <form
      onSubmit={submit}
      className={cn('flex items-center gap-3 bg-card py-2 pr-2 pl-3 shadow-raised', composerSurface)}
    >
      <Avatar name="Chief of staff" size="md" />
      <label htmlFor="quick-ask" className="sr-only">
        Ask your chief of staff
      </label>
      <input
        id="quick-ask"
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={20_000}
        autoComplete="off"
        placeholder="Ask your chief of staff, or hand it some work…"
        className="h-9 min-w-0 flex-1 bg-transparent text-body text-foreground outline-hidden placeholder:text-placeholder"
      />
      <Button type="submit" variant="primary" size="icon-md" tooltip="Ask" disabled={!text.trim()}>
        <ArrowUp aria-hidden />
      </Button>
    </form>
  );
}
