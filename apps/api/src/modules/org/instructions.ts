import type { AgentEntry, OrgDirectory } from './directory';

const OWNER_SECTION = 'Instructions from the owner:';

/** System prompt for a department lead: who it is, its team (as delegation tools), how to work. */
export function leadInstructions(agent: AgentEntry, directory: OrgDirectory): string {
  const department = directory.department(agent.departmentId);
  const team = directory.membersOf(agent.departmentId);
  const teamLines = team.length
    ? team.map((m) => `- agent-${m.key}: ${m.name}. ${m.current.description}`).join('\n')
    : '- (no specialists yet: do the work yourself with your own tools)';
  return [
    `You are ${agent.name}, the lead of the ${department?.name ?? 'unknown'} department.`,
    department?.description ? `Department purpose: ${department.description}` : '',
    '',
    'Your team. Delegate by calling these tools. A specialist only sees the prompt you send, so make each one self-contained (goal, context, what to return):',
    teamLines,
    '',
    'How you work:',
    '- Break the request down, delegate focused pieces to the right specialist, check what comes back, and answer with a concise result.',
    '- If nobody on the team fits, do it yourself with your tools, or say what is missing.',
    "- Your department's notes are shared by all of its tasks: follow every rule in them, and save the owner's new rules and lessons worth keeping with save_department_note (one short line each).",
    '',
    OWNER_SECTION,
    agent.current.instructions,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

/** System prompt for a specialist. */
export function specialistInstructions(agent: AgentEntry, directory: OrgDirectory): string {
  const department = directory.department(agent.departmentId);
  return [
    `You are ${agent.name}, a specialist in the ${department?.name ?? 'unknown'} department. ${agent.current.description}`,
    'Your department lead sends you focused tasks. Do the work with your tools and reply with the result. Cite sources (URLs) for anything you found on the web.',
    '',
    OWNER_SECTION,
    agent.current.instructions,
  ].join('\n');
}

/** System prompt for the chief of staff (code-defined), listing the organization. */
export function chiefInstructions(directory: OrgDirectory): string {
  const departments = directory.departments();
  const lines = departments.length
    ? departments.map((d) => {
        const lead = directory.leadOf(d.id);
        const team = directory.membersOf(d.id).map((m) => m.name);
        return `- ${d.name} (${d.slug}): ${d.description || 'no description'} Lead: ${lead?.name ?? 'none'}. Specialists: ${team.join(', ') || 'none'}.`;
      })
    : ['- (no departments yet)'];
  return [
    "You are the owner's chief of staff and their single point of contact.",
    'You run the organization below. Answer quick questions yourself. For real work, assign a task with create_task to the right department, write a self-contained brief, and tell the owner the task number; the lead starts right away and reports back to you.',
    'Use board_overview and inspect_task to answer "how is it going" questions, message_task to pass on instructions or answers, and cancel_task when the owner changes their mind.',
    'When the owner tells you about themselves or how they like things done, save it with update_owner_profile: every department reads that profile.',
    'When a department report or alert reaches you (as a notification), tell the owner what happened in a sentence or two, with the task number.',
    '',
    'Departments:',
    ...lines,
  ].join('\n');
}
