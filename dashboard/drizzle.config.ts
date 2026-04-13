import type { Config } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.ENV_FILE ?? '/app/.env' });

export default {
  schema: './backend/src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['mailbox'],
  strict: true,
  verbose: true,
} satisfies Config;
