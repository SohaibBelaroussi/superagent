// Run by common/pair.yaml before each flow that needs the server. Maestro runs it on the computer
// driving the emulator, so it reaches the API at MAESTRO_API_URL, while the app reaches it at
// MAESTRO_APP_SERVER (http://10.0.2.2:<port> from the Android emulator). It makes sure the department
// and the task the flows look for exist, then makes a pairing code, which works once.
//
// Maestro hands its MAESTRO_* environment variables to flows and scripts, so the admin token never
// appears on a command line: see docs/runbooks/mobile.md.

if (
  typeof MAESTRO_API_URL === 'undefined' ||
  typeof MAESTRO_APP_SERVER === 'undefined' ||
  typeof MAESTRO_ADMIN_TOKEN === 'undefined'
) {
  throw new Error('Set MAESTRO_API_URL, MAESTRO_APP_SERVER and MAESTRO_ADMIN_TOKEN');
}

const DEPARTMENT = {
  slug: 'phone-check',
  name: 'Phone check',
  description: 'For the phone app’s end-to-end flows.',
};
const TASK = { title: 'Phone check: on the board', brief: 'Seeded for the phone app’s end-to-end flows.' };
const headers = { Authorization: `Bearer ${MAESTRO_ADMIN_TOKEN}`, 'Content-Type': 'application/json' };

function read(response, what) {
  if (response.status < 200 || response.status > 299) {
    throw new Error(`${what} answered ${response.status}: ${response.body}`);
  }
  return JSON.parse(response.body);
}
const get = (path) => read(http.get(`${MAESTRO_API_URL}${path}`, { headers }), `GET ${path}`);
// Maestro's client wants a body on every POST.
const post = (path, body = {}) =>
  read(http.post(`${MAESTRO_API_URL}${path}`, { headers, body: JSON.stringify(body) }), `POST ${path}`);

// With MAESTRO_MODEL_URL (the tests' fake model, as in CI), the chief and the leads answer with it.
if (typeof MAESTRO_MODEL_URL !== 'undefined' && MAESTRO_MODEL_URL) {
  const provider =
    get('/v1/providers').items.find((item) => item.slug === 'e2e-model') ??
    post('/v1/providers', {
      slug: 'e2e-model',
      name: 'Test model',
      baseUrl: MAESTRO_MODEL_URL,
      apiKey: 'e2e',
    });
  post(`/v1/providers/${provider.id}/refresh-models`);
  const model = { provider: 'e2e-model', model: 'fake-chat' };
  read(
    http.request(`${MAESTRO_API_URL}/v1/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ models: { default: model, fast: model } }),
    }),
    'PATCH /v1/settings',
  );
}

// The department has no lead, so its tasks wait in the inbox and nothing calls a model.
const department =
  get('/v1/departments').items.find((item) => item.slug === DEPARTMENT.slug) ??
  post('/v1/departments', DEPARTMENT);
const seeded = get(`/v1/tasks?departmentId=${department.id}&phase=inbox&limit=200`).items;
if (!seeded.some((task) => task.title === TASK.title)) {
  post('/v1/tasks', { departmentId: department.id, ...TASK, dispatch: false });
}

const pairing = post('/v1/tokens/pairing');
output.pairLink = `superagent://pair?server=${encodeURIComponent(MAESTRO_APP_SERVER)}&code=${pairing.code}`;
