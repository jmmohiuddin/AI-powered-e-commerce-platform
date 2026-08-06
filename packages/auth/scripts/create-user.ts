// Must be first: populates process.env from the repo-root .env before any
// module below reads a connection string at import time.
import '@voltix/config/load-env';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { sql } from 'drizzle-orm';
import { dbAdmin, closeConnections, uuidv7 } from '@voltix/db';
import { hashPassword } from '../src/passwords';

/**
 * Creates a staff account.
 *
 *   npm run db:create-user -- --email you@store.ae --role owner
 *
 * A CLI rather than a public sign-up page, and that is the point. Anyone who
 * can create an admin account can create an owner, so this capability lives
 * behind shell access to the server rather than behind a URL. Every SaaS that
 * has ever shipped an open `/register` on its admin has regretted it.
 *
 * The password is read from a prompt, never from an argument. Arguments land in
 * shell history and in the process list, where any other user on the box can
 * read them with `ps`.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Reads the password from a prompt when there is a human at a terminal, and
 * from stdin when there is not.
 *
 * The two-path shape is what `docker login --password-stdin` and `gh auth
 * login` do, for the same reason: an interactive prompt is right for a person,
 * but it hangs forever in a provisioning script or a CI job. Reading stdin when
 * it is not a TTY makes the script automatable without ever putting the
 * password in `process.argv`, where `ps` would show it to every other user on
 * the machine.
 */
async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    let buffer = '';
    for await (const chunk of stdin) buffer += chunk;
    // First line only. A here-doc or `echo` adds a trailing newline, and a
    // password silently carrying one is a support ticket nobody ever solves.
    return buffer.split('\n')[0]?.trim() ?? '';
  }

  const rl = createInterface({ input: stdin, output: stdout });
  // Node has no portable way to mute terminal echo through readline, so this
  // says so plainly rather than pretending the input is hidden. Being wrong
  // about that is how someone types a password onto a shared screen.
  console.log('\nPassword input is NOT masked — make sure nobody is looking.');
  const password = (await rl.question('Password (min 12 chars): ')).trim();
  const confirm = (await rl.question('Confirm password: ')).trim();
  rl.close();

  if (password !== confirm) {
    console.error('✗ Passwords do not match.');
    return '';
  }
  return password;
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const roleKey = arg('role') ?? 'owner';
  const name = arg('name') ?? email?.split('@')[0] ?? 'Staff';

  if (!email || !email.includes('@')) {
    console.error('Usage: npm run db:create-user -- --email you@store.ae [--role owner] [--name "Your Name"]');
    process.exitCode = 1;
    return;
  }

  const password = await readPassword();
  if (!password) {
    console.error('✗ No password provided.');
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);

  await dbAdmin().transaction(async (tx) => {
    const tenant = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM tenants WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1
    `);
    const tenantId = tenant.rows[0]?.id;
    if (!tenantId) throw new Error('No tenant found — run `npm run db:seed` first.');

    const role = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM roles WHERE tenant_id = ${tenantId} AND key = ${roleKey} LIMIT 1
    `);
    const roleId = role.rows[0]?.id;
    if (!roleId) throw new Error(`No role '${roleKey}' in this tenant.`);

    // Upsert on email so re-running resets the password rather than failing on
    // a unique violation — which is exactly what you want this script for at
    // 2am when someone is locked out.
    const user = await tx.execute<{ id: string }>(sql`
      INSERT INTO users (id, email, name, password_hash, email_verified_at, session_epoch, created_at, updated_at)
      VALUES (${uuidv7()}, ${email}, ${name}, ${passwordHash}, now(), '0', now(), now())
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            name = EXCLUDED.name,
            -- Bumping the epoch signs out every existing session. A password
            -- reset that leaves old sessions alive has not reset anything.
            session_epoch = (users.session_epoch::bigint + 1)::text,
            deleted_at = NULL,
            updated_at = now()
      RETURNING id
    `);
    const userId = user.rows[0]!.id;

    await tx.execute(sql`
      INSERT INTO memberships (id, tenant_id, user_id, role_id, accepted_at, created_at, updated_at)
      VALUES (${uuidv7()}, ${tenantId}, ${userId}, ${roleId}, now(), now(), now())
      ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET role_id = EXCLUDED.role_id, accepted_at = now(), updated_at = now()
    `);

    console.log(`\n✓ ${email} — ${role.rows[0]!.name} of ${tenant.rows[0]!.name}`);
    console.log('  Sign in at http://localhost:3001');
    if (roleKey === 'owner' || roleKey === 'admin') {
      console.log('  This role requires two-factor auth; you will be asked to enrol on first sign-in.');
    }
  });
}

main()
  .catch((error) => {
    console.error('✗', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeConnections);
