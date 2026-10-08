import { z } from 'zod';

// Zod compiles object parsers with `new Function` when it can, and finds out by trying, which the app's
// Content-Security-Policy refuses (no eval). Jitless parsing never tries. Imported first in main.tsx.
z.config({ jitless: true });
