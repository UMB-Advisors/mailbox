import { db } from '../src/db/client.js';
import { onboarding } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

async function main() {
  await db.insert(onboarding).values({
    customerKey: 'default',
    stage: 'pending_admin',
  }).onConflictDoNothing({ target: onboarding.customerKey });
  const rows = await db.execute(sql`SELECT customer_key, stage FROM mailbox.onboarding;`);
  console.log('onboarding rows:', rows.rows);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
