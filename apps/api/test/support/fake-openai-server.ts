// The tests' fake model on its own, on a fixed port: the model the phone app's end-to-end flows talk
// to in CI (see apps/mobile/e2e/setup.js).
//   pnpm --filter @superagent/api exec tsx test/support/fake-openai-server.ts [port]
import { startFakeOpenAI } from './fake-openai';

const port = Number(process.argv[2] ?? 4199);
const fake = await startFakeOpenAI(['fake-chat', 'fake-embed'], port);
console.log(`Fake model at ${fake.url}`);
