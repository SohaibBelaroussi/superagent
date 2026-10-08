import type { AgentVersion } from '@superagent/shared';
import { describe, expect, it } from 'vitest';
import {
  agentChanges,
  agentDraft,
  agentDraftErrors,
  departmentChanges,
  departmentDraft,
  makesVersion,
  versionChanges,
} from '../src/features/agents/draft';
import { suggestKey } from '../src/features/agents/new-agent-dialog';
import { profileChanges } from '../src/features/profile/profile-page';
import { diffLines, foldDiff } from '../src/lib/diff';
import { slugify } from '../src/lib/slug';
import { ada, research } from './msw';

describe('saving an agent', () => {
  it('sends only what changed: a version only when its definition did', () => {
    const draft = agentDraft(ada);
    expect(agentChanges(ada, draft)).toEqual({});

    const renamed = agentChanges(ada, { ...draft, name: '  Ada L.  ' });
    expect(renamed).toEqual({ name: 'Ada L.' });
    expect(makesVersion(renamed)).toBe(false);

    const tooled = agentChanges(ada, {
      ...draft,
      instructions: `${draft.instructions} `,
      tools: [{ key: 'web_search', requireApproval: true }],
    });
    // Trailing space trimmed away: the instructions didn't change.
    expect(tooled).toEqual({ tools: [{ key: 'web_search', requireApproval: true }] });
    expect(makesVersion(tooled)).toBe(true);
  });

  it('doesn’t count grants given back in another order as a change', () => {
    const agent = {
      ...ada,
      current: {
        ...ada.current,
        tools: [
          { key: 'web_search', requireApproval: false },
          { key: 'browser', requireApproval: true, identity: 'work' },
        ],
        mcp: [{ server: 'github', requireApproval: false, tools: ['b', 'a'] }],
      },
    };
    const draft = agentDraft(agent);
    expect(
      agentChanges(agent, {
        ...draft,
        tools: [...draft.tools].reverse(),
        mcp: [{ server: 'github', requireApproval: false, tools: ['a', 'b'] }],
      }),
    ).toEqual({});
    expect(agentChanges(agent, { ...draft, mcp: [{ server: 'github', requireApproval: false }] })).toEqual({
      mcp: [{ server: 'github', requireApproval: false }],
    });
  });

  it('won’t save an empty name, description or instructions, or a server with none of its tools', () => {
    const errors = agentDraftErrors(
      {
        ...agentDraft(ada),
        name: ' ',
        description: '',
        instructions: '',
        mcp: [{ server: 'github', requireApproval: false, tools: [] }],
      },
      () => 'GitHub',
    );
    expect(errors).toEqual({
      name: 'Give it a name.',
      description: 'Say what it does.',
      instructions: 'Tell it how to work.',
      mcp: 'Pick at least one of GitHub’s tools, or give it all of them.',
    });
  });

  it('says what each version changed from the one before', () => {
    const v1: AgentVersion = { ...ada.current, version: 1 };
    const v2: AgentVersion = {
      ...v1,
      version: 2,
      instructions: 'Lead, briefly.',
      tools: [{ key: 'web_search', requireApproval: false }],
    };
    expect(versionChanges(v1, undefined)).toEqual([]);
    expect(versionChanges(v2, v1)).toEqual(['instructions', 'tools']);
    expect(versionChanges({ ...v2, version: 3 }, v2)).toEqual([]);
  });
});

describe('saving a department and the profile', () => {
  it('sends the department’s changed fields only', () => {
    const draft = departmentDraft(research);
    expect(departmentChanges(research, draft)).toEqual({});
    expect(
      departmentChanges(research, { ...draft, autoClose: true, description: ' Finds things out. ' }),
    ).toEqual({
      autoClose: true,
    });
  });

  it('removes a profile field you emptied, and replaces the preferences', () => {
    const profile = { name: 'Sohaib', language: 'English', preferences: ['cite sources'] };
    const draft = {
      name: 'Sohaib',
      language: '',
      timezone: 'Asia/Qatar',
      communicationStyle: '',
      preferences: ['cite sources', ' ', 'no meetings before 10'],
      about: '',
    };
    expect(profileChanges(profile, draft)).toEqual({
      language: null,
      timezone: 'Asia/Qatar',
      preferences: ['cite sources', 'no meetings before 10'],
    });
    expect(profileChanges(profile, { ...draft, language: 'English', timezone: '', preferences: [] })).toEqual(
      {
        preferences: null,
      },
    );
  });
});

describe('slugs, keys and diffs', () => {
  it('makes slugs and keys the server accepts', () => {
    expect(slugify('Market Research')).toBe('market-research');
    expect(slugify('  Ünïcode & co.  ')).toBe('unicode-co');
    expect(slugify('a'.repeat(50))).toHaveLength(40);
    expect(suggestKey(research, 'Grace Hopper', 'specialist')).toBe('research-grace-hopper');
    expect(suggestKey(research, '', 'lead')).toBe('research-lead');
    expect(suggestKey(research, '', 'specialist')).toBe('');
  });

  it('marks the lines removed and added, folding long unchanged stretches', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'e', 'f', 'G', 'h', 'i'].join('\n');
    expect(diffLines(before, after).filter((line) => line.kind !== 'same')).toEqual([
      { kind: 'removed', text: 'g' },
      { kind: 'added', text: 'G' },
      { kind: 'added', text: 'i' },
    ]);
    const folded = foldDiff(diffLines(before, after), 1);
    expect(folded[0]).toEqual({ kind: 'gap', count: 5 });
    expect(folded[1]).toMatchObject({ kind: 'lines' });
    expect(diffLines('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  });
});
