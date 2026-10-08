import type { BrowserIdentity, Capabilities, CatalogTool, McpGrant, ToolGrant } from '@superagent/shared';
import { Plug, Sparkles, Wrench } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { EmptyState } from '../../ui/feedback';
import { Select } from '../../ui/select';
import { SettingRow, SettingsGroupLabel, SettingsList, settingLabels } from '../../ui/settings';
import { SwitchControl } from '../../ui/switch';
import { Segmented } from '../../ui/tabs';

/*
 * What an agent (or every agent of a department) may use: catalog tools, skills from plugins, and MCP
 * servers' tools. Each grant can ask the owner before every call.
 */

const PACKS: Record<string, string> = {
  core: 'Basics',
  web: 'Web',
  knowledge: 'Knowledge',
  workspace: 'Workspace',
  browser: 'Browser',
};
const PACK_ORDER = Object.keys(PACKS);

/** "web_search" → "Web search". */
export function toolName(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ASK_FIRST_HINT = 'Each call waits in your inbox until you approve it.';

/** A tool's or server's key after its name; the space keeps the two apart in the label's accessible name. */
function Key({ children }: { children: string }) {
  return (
    <>
      {' '}
      <span className="ml-1 font-mono text-meta text-placeholder">{children}</span>
    </>
  );
}

/** Catalog tools, by pack: on or off, ask first, and for the browser, whose sign-ins it uses. */
export function ToolGrants({
  value,
  onChange,
  tools,
  identities,
  disabled,
}: {
  value: readonly ToolGrant[];
  onChange: (next: ToolGrant[]) => void;
  tools: readonly CatalogTool[];
  identities: readonly BrowserIdentity[] | undefined;
  disabled?: boolean;
}) {
  const byKey = new Map(value.map((grant) => [grant.key, grant]));
  const packs = [...new Set(tools.map((tool) => tool.pack))].sort(
    (a, b) => (PACK_ORDER.indexOf(a) + 1 || 99) - (PACK_ORDER.indexOf(b) + 1 || 99),
  );
  const set = (key: string, grant: ToolGrant | null) => {
    const others = value.filter((item) => item.key !== key);
    onChange(grant ? [...others, grant] : others);
  };

  if (tools.length === 0) {
    return (
      <SettingsList>
        <EmptyState compact icon={<Wrench />} title="No tools available" />
      </SettingsList>
    );
  }
  return (
    <SettingsList>
      {packs.map((pack) => (
        <section key={pack} aria-label={PACKS[pack] ?? toolName(pack)}>
          <SettingsGroupLabel>{PACKS[pack] ?? toolName(pack)}</SettingsGroupLabel>
          <div className="divide-y divide-border">
            {tools
              .filter((tool) => tool.pack === pack)
              .map((tool) => (
                <ToolRow
                  key={tool.key}
                  tool={tool}
                  grant={byKey.get(tool.key)}
                  identities={identities}
                  disabled={disabled}
                  onChange={(grant) => set(tool.key, grant)}
                />
              ))}
          </div>
        </section>
      ))}
    </SettingsList>
  );
}

function ToolRow({
  tool,
  grant,
  identities,
  disabled,
  onChange,
}: {
  tool: CatalogTool;
  grant: ToolGrant | undefined;
  identities: readonly BrowserIdentity[] | undefined;
  disabled?: boolean;
  onChange: (grant: ToolGrant | null) => void;
}) {
  const id = useId();
  const NONE = '-';
  return (
    <SettingRow
      htmlFor={id}
      label={
        <>
          {toolName(tool.key)}
          <Key>{tool.key}</Key>
        </>
      }
      description={tool.description}
      control={
        <SwitchControl
          id={id}
          {...settingLabels(id)}
          checked={Boolean(grant)}
          disabled={disabled}
          onCheckedChange={(on) => onChange(on ? { key: tool.key, requireApproval: false } : null)}
        />
      }
    >
      {grant ? (
        <>
          <Checkbox
            checked={grant.requireApproval}
            disabled={disabled}
            onCheckedChange={(requireApproval) => onChange({ ...grant, requireApproval })}
            label="Ask me before each call"
            hint={ASK_FIRST_HINT}
          />
          {tool.pack === 'browser' ? (
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <span className="text-body-sm text-foreground" id={`${id}-identity`}>
                Signed in as
              </span>
              <Select
                aria-label="Browser identity"
                size="sm"
                disabled={disabled}
                className="min-w-48"
                value={grant.identity ?? NONE}
                onValueChange={(identity) =>
                  onChange(
                    identity === NONE
                      ? { key: grant.key, requireApproval: grant.requireApproval }
                      : { ...grant, identity },
                  )
                }
                options={[
                  { value: NONE, label: 'Nobody (a fresh browser)' },
                  ...(identities ?? []).map((identity) => ({ value: identity.name, label: identity.name })),
                  // A name the list doesn't have (yet): keep it choosable rather than blank.
                  ...(grant.identity && !identities?.some((identity) => identity.name === grant.identity)
                    ? [{ value: grant.identity, label: grant.identity }]
                    : []),
                ]}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </SettingRow>
  );
}

/**
 * Skills, by the plugin they came with: all of a plugin's skills (its name), or some of them
 * ("plugin/skill"). What the department already gives shows as on and fixed.
 */
export function SkillGrants({
  value,
  onChange,
  skills,
  plugins,
  inherited = [],
  inheritedFrom,
  disabled,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  skills: Capabilities['skills'];
  plugins: Capabilities['plugins'];
  inherited?: readonly string[];
  inheritedFrom?: string;
  disabled?: boolean;
}) {
  const granted = new Set(value);
  const fromDepartment = new Set(inherited);
  const pluginNames = [...new Set(skills.map((skill) => skill.plugin))].sort();
  const toggle = (ref: string, on: boolean) =>
    onChange(on ? [...value.filter((item) => item !== ref), ref] : value.filter((item) => item !== ref));

  if (skills.length === 0) {
    return (
      <SettingsList>
        <EmptyState
          compact
          icon={<Sparkles />}
          title="No skills installed"
          description="Skills come with plugins. Install one through the API (POST /v1/plugins) until settings has them."
        />
      </SettingsList>
    );
  }
  return (
    <SettingsList>
      {pluginNames.map((plugin) => {
        const title = plugins.find((item) => item.name === plugin)?.title ?? plugin;
        const wholeInherited = fromDepartment.has(plugin);
        const whole = granted.has(plugin) || wholeInherited;
        return (
          <div key={plugin} className="divide-y divide-border">
            <GrantRow
              label={
                <>
                  All of {title}
                  <Key>{plugin}</Key>
                </>
              }
              description={
                wholeInherited
                  ? `Given by ${inheritedFrom ?? 'the department'}.`
                  : 'Its skills, including ones it adds later.'
              }
              checked={whole}
              disabled={disabled || wholeInherited}
              onCheckedChange={(on) => {
                // The whole plugin replaces its single skills.
                const rest = value.filter((ref) => ref !== plugin && !ref.startsWith(`${plugin}/`));
                onChange(on ? [...rest, plugin] : rest);
              }}
            />
            {skills
              .filter((skill) => skill.plugin === plugin)
              .map((skill) => {
                const viaDepartment = wholeInherited || fromDepartment.has(skill.ref);
                return (
                  <GrantRow
                    key={skill.ref}
                    inset
                    label={
                      <>
                        {skill.name}{' '}
                        {viaDepartment ? (
                          <Badge size="xs" className="ml-1 align-middle">
                            {inheritedFrom ?? 'Department'}
                          </Badge>
                        ) : null}
                      </>
                    }
                    description={skill.description}
                    checked={whole || granted.has(skill.ref) || viaDepartment}
                    disabled={disabled || whole || viaDepartment}
                    onCheckedChange={(on) => toggle(skill.ref, on)}
                  />
                );
              })}
          </div>
        );
      })}
    </SettingsList>
  );
}

function GrantRow({
  label,
  description,
  checked,
  disabled,
  inset = false,
  onCheckedChange,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  inset?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingRow
      htmlFor={id}
      className={inset ? 'pl-4' : undefined}
      label={label}
      description={description}
      control={
        <SwitchControl
          id={id}
          {...settingLabels(id, Boolean(description))}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      }
    />
  );
}

const SERVER_STATUS: Record<Capabilities['mcpServers'][number]['status'], string> = {
  ready: 'Ready',
  pending: 'Starting',
  failed: 'Failed',
};

/**
 * MCP servers: all of a server's tools or some of them, and whether each call waits for you. What the
 * department already gives shows as on and fixed.
 */
export function McpGrants({
  value,
  onChange,
  servers,
  inherited = [],
  inheritedFrom,
  disabled,
}: {
  value: readonly McpGrant[];
  onChange: (next: McpGrant[]) => void;
  servers: Capabilities['mcpServers'];
  inherited?: readonly McpGrant[];
  inheritedFrom?: string;
  disabled?: boolean;
}) {
  const set = (server: string, grant: McpGrant | null) => {
    const others = value.filter((item) => item.server !== server);
    onChange(grant ? [...others, grant] : others);
  };
  if (servers.length === 0) {
    return (
      <SettingsList>
        <EmptyState
          compact
          icon={<Plug />}
          title="No MCP servers"
          description="Add one through the API (POST /v1/mcp-servers), or install a plugin that brings one, until settings has them."
        />
      </SettingsList>
    );
  }
  return (
    <SettingsList>
      {servers.map((server) => (
        <McpRow
          key={server.slug}
          server={server}
          grant={value.find((item) => item.server === server.slug)}
          inherited={inherited.find((item) => item.server === server.slug)}
          inheritedFrom={inheritedFrom}
          disabled={disabled}
          onChange={(grant) => set(server.slug, grant)}
        />
      ))}
    </SettingsList>
  );
}

/** "all its tools, asking you first". */
function grantSummary(grant: McpGrant): string {
  const tools = grant.tools ? `${grant.tools.length} of its tools` : 'all its tools';
  return grant.requireApproval ? `${tools}, asking you first` : tools;
}

/**
 * One MCP server for an agent (or a department). An agent's own grant replaces its department's for
 * that server, as the server applies them: the department's shows as given, and can be replaced by the
 * agent's own (its tools, asking first) or come back when the own one goes.
 */
function McpRow({
  server,
  grant,
  inherited,
  inheritedFrom,
  disabled,
  onChange,
}: {
  server: Capabilities['mcpServers'][number];
  grant: McpGrant | undefined;
  inherited: McpGrant | undefined;
  inheritedFrom?: string;
  disabled?: boolean;
  onChange: (grant: McpGrant | null) => void;
}) {
  const id = useId();
  const from = inheritedFrom ?? 'the department';
  const status = server.enabled ? SERVER_STATUS[server.status] : 'Off';
  const tone = !server.enabled
    ? 'neutral'
    : server.status === 'ready'
      ? 'green'
      : server.status === 'failed'
        ? 'red'
        : 'amber';
  const some = grant?.tools !== undefined;
  const chosen = new Set(grant?.tools ?? []);
  return (
    <SettingRow
      htmlFor={id}
      label={
        <>
          {server.name}
          <Key>{server.slug}</Key>{' '}
          <Badge size="xs" tone={tone} dot className="ml-1 align-middle">
            {status}
          </Badge>
        </>
      }
      description={
        grant && inherited
          ? `Its own grant, in place of ${from}’s (${grantSummary(inherited)}).`
          : inherited
            ? `Given by ${from}: ${grantSummary(inherited)}.`
            : server.tools.length > 0
              ? `${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`
              : 'Its tools aren’t known yet.'
      }
      control={
        <SwitchControl
          id={id}
          {...settingLabels(id)}
          checked={Boolean(grant) || Boolean(inherited)}
          // The department's grant is changed in the department's settings, not here.
          disabled={disabled || (!grant && Boolean(inherited))}
          onCheckedChange={(on) => onChange(on ? { server: server.slug, requireApproval: false } : null)}
        />
      }
    >
      {!grant && inherited && !disabled ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-fit"
          onClick={() =>
            onChange({ ...inherited, tools: inherited.tools ? [...inherited.tools] : undefined })
          }
        >
          Give it its own grant
        </Button>
      ) : null}
      {grant ? (
        <>
          <Checkbox
            checked={grant.requireApproval}
            disabled={disabled}
            onCheckedChange={(requireApproval) => onChange({ ...grant, requireApproval })}
            label="Ask me before each call"
            hint={ASK_FIRST_HINT}
          />
          {server.tools.length > 0 ? (
            <>
              <Segmented
                aria-label={`Which of ${server.name}’s tools`}
                size="sm"
                value={some ? 'some' : 'all'}
                onValueChange={(next) =>
                  onChange(
                    next === 'all'
                      ? { server: grant.server, requireApproval: grant.requireApproval }
                      : { ...grant, tools: [] },
                  )
                }
                options={[
                  { value: 'all', label: 'All its tools' },
                  { value: 'some', label: 'Only some' },
                ]}
              />
              {some ? (
                <div className="flex flex-col gap-2.5 rounded-lg bg-fill-subtle p-3 shadow-rim">
                  {server.tools.map((tool) => (
                    <Checkbox
                      key={tool.name}
                      checked={chosen.has(tool.name)}
                      disabled={disabled}
                      onCheckedChange={(on) =>
                        onChange({
                          ...grant,
                          tools: on
                            ? [...(grant.tools ?? []).filter((name) => name !== tool.name), tool.name]
                            : (grant.tools ?? []).filter((name) => name !== tool.name),
                        })
                      }
                      label={<span className="font-mono text-label">{tool.name}</span>}
                      hint={tool.description || undefined}
                    />
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {inherited && !disabled ? (
            <Button size="sm" variant="ghost" className="w-fit" onClick={() => onChange(null)}>
              Use {from}’s grant instead
            </Button>
          ) : null}
        </>
      ) : null}
    </SettingRow>
  );
}
