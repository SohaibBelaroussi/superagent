import { type ConfigValue, type McpServer, McpServerSlugSchema } from '@superagent/shared';
import { ChevronDown, Ellipsis, Pencil, Plug, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { errorMessage, ProblemError } from '../../api/client';
import {
  useCreateMcpServer,
  useDeleteMcpServer,
  useMcpServers,
  useRefreshMcpServer,
  useSecrets,
  useUpdateMcpServer,
} from '../../api/settings';
import { Loaded } from '../../layout/loaded';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { slugify } from '../../lib/slug';
import { useDocumentTitle } from '../../lib/title';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog, Dialog } from '../../ui/dialog';
import { EmptyState, FormFailure, Notice, Spinner } from '../../ui/feedback';
import { Field, Input, Textarea } from '../../ui/field';
import { Page, PageHeader, Panel } from '../../ui/layout';
import { Menu, MenuItem, MenuSeparator } from '../../ui/menu';
import { colorTransition, focusRingInset } from '../../ui/recipes';
import { Select } from '../../ui/select';
import { Switch, SwitchControl } from '../../ui/switch';
import { toast } from '../../ui/toast';

const STATUS = { ready: 'Ready', pending: 'Starting', failed: 'Failed' } as const;

/** The MCP servers agents can be given tools from: added here, or brought by plugins. */
export function McpPage() {
  useDocumentTitle('MCP servers');
  const servers = useMcpServers();
  const [editing, setEditing] = useState<{ open: boolean; server?: McpServer }>({ open: false });
  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="MCP servers"
          description="Servers whose tools agents and departments can be given, each call asking you first if you like. Plugins bring their own."
          actions={
            <Button variant="primary" onClick={() => setEditing({ open: true })}>
              <Plus aria-hidden />
              Add a server
            </Button>
          }
        />
      }
    >
      <Loaded query={servers} failure="Couldn’t load the MCP servers">
        {(items) =>
          items.length === 0 ? (
            <Panel>
              <EmptyState
                compact
                icon={<Plug />}
                title="No MCP servers yet"
                description="Add one that speaks Streamable HTTP, or install a plugin that brings one. Then give its tools to an agent or a department."
              />
            </Panel>
          ) : (
            <ul className="flex flex-col gap-3" aria-label="MCP servers">
              {items.map((server) => (
                <li key={server.id}>
                  <ServerPanel server={server} onEdit={() => setEditing({ open: true, server })} />
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <ServerDialog
        open={editing.open}
        server={editing.server}
        onOpenChange={(open) => setEditing((current) => ({ ...current, open }))}
      />
    </Page>
  );
}

function ServerPanel({ server, onEdit }: { server: McpServer; onEdit: () => void }) {
  const update = useUpdateMcpServer();
  const refresh = useRefreshMcpServer();
  const remove = useDeleteMcpServer();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const titleId = useId();
  const tone = !server.enabled
    ? 'neutral'
    : server.status === 'ready'
      ? 'green'
      : server.status === 'failed'
        ? 'red'
        : 'amber';
  return (
    <Panel className="flex flex-col" role="group" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 id={titleId} className="text-card-title text-foreground">
            {server.name} <span className="ml-1 font-mono text-meta text-placeholder">{server.slug}</span>
          </h3>
          <p className="truncate font-mono text-caption text-muted-foreground">
            {server.transport === 'http' ? server.url : (server.package ?? server.command?.join(' '))}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone={tone} dot>
              {server.enabled ? STATUS[server.status] : 'Off'}
            </Badge>
            <Badge>{server.transport === 'http' ? 'HTTP' : 'stdio'}</Badge>
            {server.plugin ? <Badge>From {server.plugin}</Badge> : null}
            {server.allowPrivateNetwork ? <Badge tone="amber">Private network</Badge> : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SwitchControl
            aria-label={`${server.name} enabled`}
            checked={server.enabled}
            disabled={update.isPending}
            onCheckedChange={(enabled) =>
              update.mutate(
                { id: server.id, enabled },
                { onError: (error) => toast.error('Couldn’t change the server', errorMessage(error)) },
              )
            }
          />
          <Menu
            trigger={
              <Button variant="ghost" size="icon-sm" tooltip={`More for ${server.name}`}>
                <Ellipsis aria-hidden />
              </Button>
            }
          >
            {server.enabled ? (
              <MenuItem
                icon={<RefreshCw aria-hidden />}
                onClick={() =>
                  refresh.mutate(server.id, {
                    // A server that can't be reached still answers, with its state saying why.
                    onSuccess: (fresh) =>
                      fresh.status === 'ready'
                        ? toast.success(`${plural(fresh.tools.length, 'tool')} listed`)
                        : toast.error(
                            `Couldn’t reach ${fresh.name}`,
                            fresh.statusDetail ?? 'Its state below says why.',
                          ),
                  })
                }
              >
                List its tools again
              </MenuItem>
            ) : null}
            {server.transport === 'http' ? (
              <MenuItem icon={<Pencil aria-hidden />} onClick={onEdit}>
                Edit
              </MenuItem>
            ) : null}
            {server.enabled || server.transport === 'http' ? <MenuSeparator /> : null}
            <MenuItem icon={<Trash2 aria-hidden />} destructive onClick={() => setDeleting(true)}>
              Delete…
            </MenuItem>
          </Menu>
        </div>
      </div>
      {server.status === 'failed' && server.statusDetail ? (
        <Notice tone="destructive" className="mx-4 mb-3" title="It can’t be reached">
          <span className="line-clamp-4 break-words">{server.statusDetail}</span>
        </Notice>
      ) : null}
      <div className="border-t border-border">
        <button
          type="button"
          aria-expanded={toolsOpen}
          disabled={server.tools.length === 0}
          onClick={() => setToolsOpen((open) => !open)}
          className={cn(
            'flex w-full items-center gap-2 px-4 py-2.5 text-left text-label text-muted-foreground outline-hidden enabled:cursor-pointer enabled:hover:text-foreground',
            colorTransition,
            focusRingInset,
          )}
        >
          {server.tools.length > 0 ? (
            <ChevronDown
              aria-hidden
              className={cn('size-icon-sm transition-transform', !toolsOpen && '-rotate-90')}
            />
          ) : null}
          {server.tools.length > 0 ? plural(server.tools.length, 'tool') : 'Its tools aren’t known yet'}
        </button>
        {toolsOpen ? (
          <ul className="flex flex-col gap-2 px-4 pb-3.5" aria-label={`${server.name}’s tools`}>
            {server.tools.map((tool) => (
              <li key={tool.name} className="flex flex-col">
                <span className="font-mono text-label text-foreground">{tool.name}</span>
                {tool.description ? (
                  <span className="text-caption text-muted-foreground">{tool.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${server.name}?`}
        description={
          server.plugin
            ? `It came with ${server.plugin}: uninstall the plugin instead.`
            : 'Agents and departments lose its tools. Take its grants away first: a granted server can’t be deleted.'
        }
        confirmLabel="Delete server"
        destructive
        busy={remove.isPending}
        onConfirm={() =>
          remove.mutate(server.id, {
            onSuccess: () => {
              setDeleting(false);
              toast.success(`${server.name} deleted`);
            },
            onError: () => setDeleting(false),
          })
        }
      />
    </Panel>
  );
}

interface HeaderRow {
  name: string;
  kind: 'value' | 'secret';
  value: string;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

const rowsOf = (headers: Record<string, ConfigValue>): HeaderRow[] =>
  Object.entries(headers).map(([name, config]) =>
    'secret' in config
      ? { name, kind: 'secret', value: config.secret }
      : { name, kind: 'value', value: config.value },
  );

/** Adds an HTTP MCP server, or edits one (`server`). */
function ServerDialog({
  open,
  server,
  onOpenChange,
}: {
  open: boolean;
  server?: McpServer;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateMcpServer();
  const update = useUpdateMcpServer();
  const secrets = useSecrets();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [privateNetwork, setPrivateNetwork] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; url?: string; headers?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from the server
  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? '');
    setSlug(server?.slug ?? '');
    setSlugEdited(Boolean(server));
    setDescription(server?.description ?? '');
    setUrl(server?.url ?? '');
    setHeaders(server ? rowsOf(server.headers) : []);
    setPrivateNetwork(server?.allowPrivateNetwork ?? false);
    setErrors({});
    setFailure(null);
  }, [open]);

  const shownSlug = slugEdited ? slug : slugify(name, 32);
  const pending = create.isPending || update.isPending;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const filled = headers.filter((row) => row.name.trim() || row.value);
    const next = {
      name: name.trim() ? undefined : 'Give it a name.',
      slug:
        server || McpServerSlugSchema.safeParse(shownSlug).success
          ? undefined
          : 'Lowercase letters, digits and dashes, up to 32.',
      url: /^https?:\/\/.+/.test(url.trim()) ? undefined : 'Its Streamable HTTP address.',
      headers: filled.every((row) => HEADER_NAME.test(row.name.trim()) && row.value)
        ? undefined
        : 'Each header needs a name and a value, or a secret.',
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    const record = Object.fromEntries(
      filled.map((row) => [
        row.name.trim(),
        row.kind === 'secret' ? { secret: row.value } : { value: row.value },
      ]),
    );
    setFailure(null);
    try {
      if (server) {
        await update.mutateAsync({
          id: server.id,
          name: name.trim(),
          description: description.trim(),
          url: url.trim(),
          headers: record,
          allowPrivateNetwork: privateNetwork,
        });
        toast.success(`${name.trim()} saved`);
      } else {
        const created = await create.mutateAsync({
          slug: shownSlug,
          name: name.trim(),
          description: description.trim(),
          url: url.trim(),
          headers: record,
          allowPrivateNetwork: privateNetwork,
        });
        if (created.status === 'ready')
          toast.success(`${created.name} added`, `${plural(created.tools.length, 'tool')}.`);
        else toast.info(`${created.name} added`, 'It can’t be reached yet: its status below says why.');
      }
      onOpenChange(false);
    } catch (error) {
      if (error instanceof ProblemError && error.status === 409)
        setErrors({ slug: 'Another server has this slug.' });
      else setFailure(errorMessage(error));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={server ? `Edit ${server.name}` : 'Add an MCP server'}
      description="A server that speaks Streamable HTTP. Its requests go out through superagent’s checks: public addresses only, unless you allow a private one."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="mcp-server" variant="primary" disabled={pending}>
            {pending ? <Spinner /> : null}
            {server ? 'Save' : 'Add server'}
          </Button>
        </>
      }
    >
      <form id="mcp-server" onSubmit={submit} className="flex flex-col gap-4 pb-1" noValidate>
        {failure ? <FormFailure>{failure}</FormFailure> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name}>
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Slug"
            error={errors.slug}
            hint={server ? 'Its tools are named after it: it can’t change.' : 'Its tools are named after it.'}
          >
            {(control) => (
              <Input
                {...control}
                value={shownSlug}
                disabled={Boolean(server)}
                maxLength={32}
                className="font-mono"
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
        </div>
        <Field label="URL" error={errors.url}>
          {(control) => (
            <Input
              {...control}
              type="url"
              value={url}
              spellCheck={false}
              placeholder="https://mcp.example.com/mcp"
              className="font-mono"
              onChange={(event) => setUrl(event.target.value)}
            />
          )}
        </Field>
        <Field label="What it’s for" hint="Optional.">
          {(control) => (
            <Textarea
              {...control}
              value={description}
              rows={2}
              className="min-h-16"
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-label text-foreground">Headers</legend>
          <p className="-mt-1 text-caption text-muted-foreground">
            A credential goes in as a secret from the vault, by name: its value never shows here.
          </p>
          {errors.headers ? (
            <p className="text-caption text-destructive-foreground">{errors.headers}</p>
          ) : null}
          {headers.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place; their place is their identity
            <div key={index} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <Input
                aria-label={`Header ${index + 1} name`}
                value={row.name}
                placeholder="Authorization"
                spellCheck={false}
                className="font-mono sm:w-48"
                onChange={(event) =>
                  setHeaders(
                    headers.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)),
                  )
                }
              />
              <Select
                aria-label={`Header ${index + 1} kind`}
                size="sm"
                value={row.kind}
                className="w-28"
                onValueChange={(kind) =>
                  setHeaders(headers.map((item, at) => (at === index ? { ...item, kind, value: '' } : item)))
                }
                options={[
                  { value: 'value', label: 'Value' },
                  { value: 'secret', label: 'Secret' },
                ]}
              />
              {row.kind === 'secret' ? (
                <Select
                  aria-label={`Header ${index + 1} secret`}
                  size="sm"
                  value={row.value || null}
                  placeholder="Choose a secret"
                  className="min-w-0 flex-1"
                  onValueChange={(value) =>
                    setHeaders(headers.map((item, at) => (at === index ? { ...item, value } : item)))
                  }
                  options={(secrets.data ?? []).map((secret) => ({ value: secret.name, label: secret.name }))}
                />
              ) : (
                <Input
                  aria-label={`Header ${index + 1} value`}
                  value={row.value}
                  className="min-w-0 flex-1"
                  onChange={(event) =>
                    setHeaders(
                      headers.map((item, at) =>
                        at === index ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                />
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                tooltip={`Remove header ${index + 1}`}
                onClick={() => setHeaders(headers.filter((_, at) => at !== index))}
              >
                <X aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="w-fit"
            onClick={() => setHeaders([...headers, { name: '', kind: 'value', value: '' }])}
          >
            <Plus aria-hidden />
            Add a header
          </Button>
        </fieldset>
        <Switch
          checked={privateNetwork}
          onCheckedChange={setPrivateNetwork}
          label="It’s on a private network"
          hint="Allow a private address (your LAN or tailnet). Only for servers you run and trust."
        />
      </form>
    </Dialog>
  );
}
