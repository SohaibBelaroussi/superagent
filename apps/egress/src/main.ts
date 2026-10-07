import { createEgressProxy } from './proxy';

const ports = (raw: string | undefined, fallback: string) =>
  new Set(
    (raw || fallback)
      .split(',')
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65_536),
  );

const host = process.env.EGRESS_HOST || '0.0.0.0';
const port = Number(process.env.EGRESS_PORT || 3128);
const quiet = process.env.LOG_LEVEL === 'warn' || process.env.LOG_LEVEL === 'error';

const server = createEgressProxy({
  connectPorts: ports(process.env.EGRESS_CONNECT_PORTS, '443'),
  httpPorts: ports(process.env.EGRESS_HTTP_PORTS, '80'),
  log: (event) => {
    if (quiet && event.action === 'allow') return;
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
  },
});
server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ msg: `egress proxy on ${host}:${port}` })}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
