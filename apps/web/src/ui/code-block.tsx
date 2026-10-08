import { cn } from '../lib/cn';

/** Machine text in a quiet box: tool arguments and results, as indented JSON unless already text. */
export function CodeBlock({ value, className }: { value: unknown; className?: string }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto rounded-lg bg-fill-subtle px-3 py-2 font-mono text-[0.75rem] leading-relaxed break-words whitespace-pre-wrap text-foreground/90 shadow-rim',
        className,
      )}
    >
      {text}
    </pre>
  );
}
