import { configureClient, setApiToken } from '@superagent/client';

const NETWORK_ERROR = 'Can’t reach superagent. Is Tailscale on?';

/** Points the shared client at a server, with the token its requests carry. */
export function connect(server: string, token: string | null): void {
  configureClient({ baseUrl: server, networkErrorDetail: NETWORK_ERROR });
  setApiToken(token);
}
