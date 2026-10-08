export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Past this many line pairs, the middle shows as all removed then all added instead of being matched. */
const MAX_CELLS = 4_000_000;

/**
 * The lines of `before` and `after`, each kept, removed or added: a longest common subsequence over
 * the lines between the shared head and tail (edits are usually small).
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const same = (text: string): DiffLine => ({ kind: 'same', text });
  const out: DiffLine[] = a.slice(0, start).map(same);

  if (midA.length * midB.length > MAX_CELLS) {
    out.push(...midA.map((text): DiffLine => ({ kind: 'removed', text })));
    out.push(...midB.map((text): DiffLine => ({ kind: 'added', text })));
  } else {
    // lengths[i][j]: the longest common subsequence of midA[i..] and midB[j..].
    const width = midB.length + 1;
    const lengths = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        lengths[i * width + j] =
          midA[i] === midB[j]
            ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      const left = midA[i] ?? '';
      const right = midB[j] ?? '';
      if (left === right) {
        out.push(same(left));
        i += 1;
        j += 1;
      } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
        out.push({ kind: 'removed', text: left });
        i += 1;
      } else {
        out.push({ kind: 'added', text: right });
        j += 1;
      }
    }
    for (; i < midA.length; i += 1) out.push({ kind: 'removed', text: midA[i] ?? '' });
    for (; j < midB.length; j += 1) out.push({ kind: 'added', text: midB[j] ?? '' });
  }

  out.push(...a.slice(endA).map(same));
  return out;
}

/** A run of the diff to show: changed lines with `context` unchanged lines around them. */
export type DiffHunk = { kind: 'lines'; lines: DiffLine[] } | { kind: 'gap'; count: number };

/** The diff with long unchanged stretches folded into gaps. */
export function foldDiff(lines: DiffLine[], context = 2): DiffHunk[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) {
      keep[k] = true;
    }
  });
  const hunks: DiffHunk[] = [];
  lines.forEach((line, index) => {
    const last = hunks.at(-1);
    if (keep[index]) {
      if (last?.kind === 'lines') last.lines.push(line);
      else hunks.push({ kind: 'lines', lines: [line] });
    } else if (last?.kind === 'gap') last.count += 1;
    else hunks.push({ kind: 'gap', count: 1 });
  });
  return hunks;
}
