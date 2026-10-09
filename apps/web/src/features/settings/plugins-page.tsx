import { errorMessage, formatBytes, formatList, plural } from '@superagent/client';
import type { Plugin, PluginPreview } from '@superagent/shared';
import { Package, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useInstallPlugin, usePlugins, usePreviewPlugin, useUninstallPlugin } from '../../api/settings';
import { Loaded } from '../../layout/loaded';
import { useDocumentTitle } from '../../lib/title';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { ConfirmDialog, Dialog } from '../../ui/dialog';
import { EmptyState, FormFailure, Notice, Spinner } from '../../ui/feedback';
import { Field, Input, SecretInput } from '../../ui/field';
import { DetailRow, Page, PageHeader, Panel } from '../../ui/layout';
import { Segmented } from '../../ui/tabs';
import { RelativeTime } from '../../ui/time';
import { toast } from '../../ui/toast';

const STATUS = {
  installing: { label: 'Installing', tone: 'amber' },
  installed: { label: 'Installed', tone: 'green' },
  failed: { label: 'Its servers failed', tone: 'red' },
} as const;

/** Where a plugin came from, pinned: "owner/repo/folder @ 1a2b3c4" or the archive's address. */
function sourceText(source: Plugin['source'], sha: string | null): string {
  if (source.kind === 'github') {
    return `${source.repo}${source.path ? `/${source.path}` : ''} @ ${sha ? sha.slice(0, 7) : source.ref}`;
  }
  return source.url;
}

/** Plugins bring skills and MCP servers, fetched pinned and looked over before they install. */
export function PluginsPage() {
  useDocumentTitle('Plugins');
  const plugins = usePlugins();
  const uninstall = useUninstallPlugin();
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState<Plugin | null>(null);
  return (
    <Page
      header={
        <PageHeader
          eyebrow="Settings"
          title="Plugins"
          description="Skills and MCP servers, packaged. Each is fetched pinned to a commit or a checksum, and you see what it brings before it installs."
          actions={
            <Button variant="primary" onClick={() => setInstalling(true)}>
              <Plus aria-hidden />
              Install a plugin
            </Button>
          }
        />
      }
    >
      <Loaded query={plugins} failure="Couldn’t load the plugins">
        {(items) =>
          items.length === 0 ? (
            <Panel>
              <EmptyState
                compact
                icon={<Package />}
                title="No plugins yet"
                description="Install one from a GitHub repository or an archive. Its skills and servers then show up where agents get their tools."
              />
            </Panel>
          ) : (
            <ul className="flex flex-col gap-3" aria-label="Plugins">
              {items.map((plugin) => (
                <li key={plugin.id}>
                  <Panel className="flex flex-col gap-2 px-4 py-3.5" role="group" aria-label={plugin.title}>
                    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <h3 className="text-card-title text-foreground">
                          {plugin.title}{' '}
                          <span className="ml-1 font-mono text-meta text-placeholder">
                            {plugin.name}
                            {plugin.version ? ` ${plugin.version}` : ''}
                          </span>
                        </h3>
                        {plugin.description ? (
                          <p className="text-body-sm text-muted-foreground">{plugin.description}</p>
                        ) : null}
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <Badge tone={STATUS[plugin.status].tone} dot>
                            {STATUS[plugin.status].label}
                          </Badge>
                          <Badge>{plural(plugin.skills.length, 'skill')}</Badge>
                          <Badge>{plural(plugin.mcpServers.length, 'server')}</Badge>
                          {plugin.mcpServers.length > 0 ? (
                            <Badge>{plugin.network === 'egress' ? 'Public internet' : 'No network'}</Badge>
                          ) : null}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="destructive-ghost"
                        aria-label={`Uninstall ${plugin.title}`}
                        onClick={() => setRemoving(plugin)}
                      >
                        <Trash2 aria-hidden />
                        Uninstall
                      </Button>
                    </div>
                    <p className="truncate font-mono text-caption text-muted-foreground">
                      {sourceText(plugin.source, plugin.sha)} · installed{' '}
                      <RelativeTime iso={plugin.createdAt} />
                    </p>
                    {plugin.status === 'failed' && plugin.statusDetail ? (
                      <Notice tone="destructive">{plugin.statusDetail}</Notice>
                    ) : null}
                    {plugin.warnings.length > 0 ? (
                      <Notice tone="warning" title="Worth knowing">
                        {formatList(plugin.warnings)}
                      </Notice>
                    ) : null}
                  </Panel>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <InstallDialog open={installing} onOpenChange={setInstalling} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Uninstall ${removing?.title ?? ''}?`}
        description="Its skills and servers leave every agent and department that had them, its servers stop, and the secrets it made are deleted."
        confirmLabel="Uninstall"
        destructive
        busy={uninstall.isPending}
        onConfirm={() => {
          if (!removing) return;
          uninstall.mutate(removing.id, {
            onSuccess: () => {
              toast.success(`${removing.title} uninstalled`);
              setRemoving(null);
            },
            onError: () => setRemoving(null),
          });
        }}
      />
    </Page>
  );
}

type SourceKind = 'github' | 'url';

/** "owner/repo" from what was typed: the name itself, or the repository's GitHub address. */
const repoName = (text: string) =>
  text
    .trim()
    .replace(/^(?:https?:\/\/)?github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

/** Where from (then a preview), what it brings, the values it needs, then install. */
function InstallDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const preview = usePreviewPlugin();
  const install = useInstallPlugin();
  const [kind, setKind] = useState<SourceKind>('github');
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('');
  const [ref, setRef] = useState('');
  const [url, setUrl] = useState('');
  const [sha256, setSha256] = useState('');
  const [privateNetwork, setPrivateNetwork] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [network, setNetwork] = useState<'egress' | 'none'>('egress');
  const [servers, setServers] = useState<Record<string, boolean>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const found = preview.data;

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts fresh
  useEffect(() => {
    if (!open) return;
    setKind('github');
    setRepo('');
    setPath('');
    setRef('');
    setUrl('');
    setSha256('');
    setPrivateNetwork(false);
    setInputs({});
    setNetwork('egress');
    setServers({});
    setFailure(null);
    preview.reset();
    install.reset();
  }, [open]);

  async function look(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    try {
      const result = await preview.mutateAsync({
        source:
          kind === 'github'
            ? {
                kind,
                repo: repoName(repo),
                path: path.trim().replace(/^\/+|\/+$/g, '') || undefined,
                ref: ref.trim() || undefined,
              }
            : {
                kind,
                url: url.trim(),
                sha256: sha256.trim().toLowerCase(),
                allowPrivateNetwork: privateNetwork,
              },
      });
      setInputs(Object.fromEntries(result.inputs.map((input) => [input.name, input.default ?? ''])));
      setServers(Object.fromEntries(result.mcpServers.map((server) => [server.key, true])));
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }

  async function installIt() {
    if (!found) return;
    setFailure(null);
    try {
      const plugin = await install.mutateAsync({
        previewId: found.id,
        network,
        inputs: Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== '')),
        servers: Object.fromEntries(Object.entries(servers).map(([key, enabled]) => [key, { enabled }])),
      });
      toast.success(
        `${plugin.title} installed`,
        plugin.status === 'installing' ? 'Its servers are starting.' : undefined,
      );
      onOpenChange(false);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }

  const missing =
    found?.inputs.filter((input) => input.required && !inputs[input.name]?.trim() && !input.default) ?? [];
  const ready =
    kind === 'github'
      ? /^[\w.-]+\/[\w.-]+$/.test(repoName(repo))
      : /^https?:\/\//.test(url.trim()) && /^[a-fA-F0-9]{64}$/.test(sha256.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={found ? `Install ${found.title}?` : 'Install a plugin'}
      description={
        found
          ? `Pinned${found.sha ? ` to ${found.sha.slice(0, 7)}` : ' by its checksum'}. Nothing is installed until you say so.`
          : 'From a GitHub repository (pinned to the commit its ref points at), or a .tar.gz with its sha256.'
      }
      footer={
        found ? (
          <>
            <Button variant="ghost" onClick={() => preview.reset()}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={found.installed || missing.length > 0 || install.isPending}
              onClick={() => void installIt()}
            >
              {install.isPending ? <Spinner /> : null}
              Install
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="plugin-source"
              variant="primary"
              disabled={!ready || preview.isPending}
            >
              {preview.isPending ? <Spinner /> : null}
              Look at it
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        {failure ? <FormFailure>{failure}</FormFailure> : null}
        {found ? (
          <PreviewView
            preview={found}
            inputs={inputs}
            onInput={(name, value) => setInputs((current) => ({ ...current, [name]: value }))}
            network={network}
            onNetwork={setNetwork}
            servers={servers}
            onServer={(key, enabled) => setServers((current) => ({ ...current, [key]: enabled }))}
          />
        ) : (
          <form id="plugin-source" onSubmit={look} className="flex flex-col gap-4" noValidate>
            <Segmented
              aria-label="Where from"
              className="self-start"
              value={kind}
              onValueChange={setKind}
              options={[
                { value: 'github', label: 'GitHub' },
                { value: 'url', label: 'An archive' },
              ]}
            />
            {kind === 'github' ? (
              <>
                <Field label="Repository" hint="owner/repo, or its GitHub address.">
                  {(control) => (
                    <Input
                      {...control}
                      value={repo}
                      spellCheck={false}
                      placeholder="acme/agent-plugins"
                      className="font-mono"
                      onChange={(event) => setRepo(event.target.value)}
                    />
                  )}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Folder" hint="Optional: where the plugin is in the repository.">
                    {(control) => (
                      <Input
                        {...control}
                        value={path}
                        spellCheck={false}
                        className="font-mono"
                        onChange={(event) => setPath(event.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Branch, tag or commit" hint="Optional: its default branch otherwise.">
                    {(control) => (
                      <Input
                        {...control}
                        value={ref}
                        spellCheck={false}
                        placeholder="main"
                        className="font-mono"
                        onChange={(event) => setRef(event.target.value)}
                      />
                    )}
                  </Field>
                </div>
              </>
            ) : (
              <>
                <Field label="Archive URL" hint="A .tar.gz of the plugin.">
                  {(control) => (
                    <Input
                      {...control}
                      type="url"
                      value={url}
                      spellCheck={false}
                      className="font-mono"
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  )}
                </Field>
                <Field label="Its sha256" hint="The checksum it must match, in hex.">
                  {(control) => (
                    <Input
                      {...control}
                      value={sha256}
                      spellCheck={false}
                      maxLength={64}
                      className="font-mono"
                      onChange={(event) => setSha256(event.target.value)}
                    />
                  )}
                </Field>
                <Checkbox
                  checked={privateNetwork}
                  onCheckedChange={setPrivateNetwork}
                  label="It’s on a private network"
                  hint="Allow a private address for the download (your LAN or tailnet)."
                />
              </>
            )}
          </form>
        )}
      </div>
    </Dialog>
  );
}

/** What a plugin would install, and the choices it needs. */
function PreviewView({
  preview,
  inputs,
  onInput,
  network,
  onNetwork,
  servers,
  onServer,
}: {
  preview: PluginPreview;
  inputs: Record<string, string>;
  onInput: (name: string, value: string) => void;
  network: 'egress' | 'none';
  onNetwork: (network: 'egress' | 'none') => void;
  servers: Record<string, boolean>;
  onServer: (key: string, enabled: boolean) => void;
}) {
  const stdio = preview.mcpServers.some((server) => server.transport === 'stdio');
  return (
    <>
      {preview.installed ? (
        <Notice tone="warning" title={`${preview.name} is installed`}>
          Uninstall it first to install this one.
        </Notice>
      ) : null}
      {preview.description ? <p className="text-body-sm text-foreground/90">{preview.description}</p> : null}
      <dl>
        <DetailRow label="Name">
          <span className="font-mono">{preview.name}</span>
          {preview.version ? ` ${preview.version}` : ''}
        </DetailRow>
        <DetailRow label="Licence">{preview.license ?? 'None given'}</DetailRow>
        <DetailRow label="Size">
          {plural(preview.files, 'file')}, {formatBytes(preview.bytes)}
        </DetailRow>
        {preview.homepage ? (
          <DetailRow label="Homepage">
            <span className="break-all">{preview.homepage}</span>
          </DetailRow>
        ) : null}
      </dl>
      {preview.warnings.length > 0 ? (
        <Notice tone="warning" title="Worth knowing">
          <ul className="list-disc pl-4">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <section className="flex flex-col gap-2" aria-label="Skills">
        <h3 className="text-label text-foreground">{plural(preview.skills.length, 'skill')}</h3>
        {preview.skills.map((skill) => (
          <div key={skill.name} className="flex flex-col">
            <span className="text-body-sm text-foreground">{skill.name}</span>
            <span className="text-caption text-muted-foreground">{skill.description}</span>
          </div>
        ))}
      </section>
      {preview.mcpServers.length > 0 ? (
        <section className="flex flex-col gap-2.5" aria-label="MCP servers">
          <h3 className="text-label text-foreground">{plural(preview.mcpServers.length, 'MCP server')}</h3>
          {preview.mcpServers.map((server) => (
            <Checkbox
              key={server.key}
              checked={servers[server.key] ?? true}
              onCheckedChange={(enabled) => onServer(server.key, enabled)}
              label={
                <>
                  <span className="font-mono">{server.slug}</span>{' '}
                  <span className="text-muted-foreground">({server.transport})</span>
                </>
              }
              hint={[
                server.url ?? server.package ?? server.command?.join(' '),
                server.env.length > 0 ? `given ${formatList(server.env)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          ))}
          {stdio ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-muted-foreground">Its servers that run here reach</span>
              <Segmented
                aria-label="Network for its servers"
                size="sm"
                value={network}
                onValueChange={onNetwork}
                options={[
                  { value: 'egress', label: 'Public internet' },
                  { value: 'none', label: 'No network' },
                ]}
              />
            </div>
          ) : null}
        </section>
      ) : null}
      {preview.inputs.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Values it needs">
          <h3 className="text-label text-foreground">Values it needs</h3>
          {preview.inputs.map((input) => (
            <Field
              key={input.name}
              label={`${input.name}${input.required ? '' : ' (optional)'}`}
              hint={`${input.description}${input.sensitive ? ' Kept in the secrets vault.' : ''}`}
            >
              {(control) =>
                input.sensitive ? (
                  <SecretInput
                    {...control}
                    value={inputs[input.name] ?? ''}
                    placeholder={input.default ?? undefined}
                    revealLabel={`Show ${input.name}`}
                    onChange={(event) => onInput(input.name, event.target.value)}
                  />
                ) : (
                  <Input
                    {...control}
                    autoComplete="off"
                    value={inputs[input.name] ?? ''}
                    placeholder={input.default ?? undefined}
                    onChange={(event) => onInput(input.name, event.target.value)}
                  />
                )
              }
            </Field>
          ))}
        </section>
      ) : null}
      {preview.skipped.length > 0 ? (
        <p className="text-caption text-muted-foreground">
          Left out: {formatList(preview.skipped.map((item) => `${item.component} (${item.reason})`))}.
        </p>
      ) : null}
    </>
  );
}
