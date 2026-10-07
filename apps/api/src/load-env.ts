// Side-effect module, imported first in main.ts: loads .env before other modules evaluate,
// because some libraries read environment variables at import time (e.g. telemetry switches).
// Bundled builds hoist external imports above this code; that's fine because production gets
// its environment from Docker, not from a .env file.
import { loadDotEnv } from './env';

loadDotEnv();
