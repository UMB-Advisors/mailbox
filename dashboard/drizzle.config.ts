import type { Config } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.ENV_FILE ?? '/app/.env' });

export default {
  // Compiled JS — always present in the image since the builder stage runs tsc.
  // Pointing at .ts source fails under NodeNext because drizzle-kit's loader does
  // not rewrite `./enums.js` imports back to `enums.ts` at migration time.
  schema: './dist/backend/src/db/schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['mailbox'],
  // strict:false so `npx drizzle-kit push` runs non-interactively inside a
  // non-TTY container exec. Reviewer-driven migrations (Phase 4+) can re-enable.
  strict: false,
  verbose: true,
} satisfies Config;
