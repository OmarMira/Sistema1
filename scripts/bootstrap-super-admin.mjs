#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const ALLOWED_TARGET = 'super_admin';
const PROMOTABLE_ROLE = 'user';

const USAGE = [
  'Usage: node scripts/bootstrap-super-admin.mjs <email> --confirm',
  '',
  'Promotes a single existing user with platformRole=user to super_admin.',
  'Idempotent: an existing super_admin is a no-op (exit 0).',
  'Fail-closed: any other platformRole aborts with exit != 0.',
  'Requires --confirm; without it the script exits without writing.',
  'The script never creates users, never touches passwords, and never',
  'creates company memberships or tenant roles.',
  'Use --help for this message (zero database access).',
].join('\n');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const knownFlags = new Set(['--confirm', '--help', '-h']);
const unknownFlags = args.filter((flag) => flag.startsWith('--') && !knownFlags.has(flag));
const positionals = args.filter((flag) => !flag.startsWith('--'));

if (unknownFlags.length > 0) {
  console.error(`[P04C] P04C_UNKNOWN_FLAG: unexpected flag(s): ${unknownFlags.join(', ')}`);
  process.exit(2);
}

if (positionals.length === 0) {
  console.error('[P04C] P04C_ARGUMENT_MISSING: a user email argument is required.');
  process.exit(2);
}

if (positionals.length > 1) {
  console.error('[P04C] P04C_ARGUMENT_MALFORMED: expected exactly one email argument.');
  process.exit(2);
}

const email = positionals[0].trim().toLowerCase();

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('[P04C] P04C_ARGUMENT_MALFORMED: the email argument is not a valid email.');
  process.exit(2);
}

if (!args.includes('--confirm')) {
  console.error('[P04C] P04C_CONFIRM_REQUIRED: pass --confirm to promote this user.');
  process.exit(3);
}

async function run() {
  const prisma = new PrismaClient();
  try {
    const candidates = await prisma.user.findMany({
      where: { email },
      select: { id: true, email: true, platformRole: true },
    });

    if (candidates.length === 0) {
      console.error('[P04C] P04C_USER_NOT_FOUND: no user matches the given email.');
      return 5;
    }

    if (candidates.length > 1) {
      console.error('[P04C] P04C_MULTIPLE_CANDIDATES: more than one user matched; aborting.');
      return 5;
    }

    const user = candidates[0];
    const previousRole = user.platformRole;

    if (previousRole === ALLOWED_TARGET) {
      console.log(`[P04C] P04C_ALREADY_SUPER_ADMIN: ${user.email} is already ${ALLOWED_TARGET}; no-op.`);
      return 0;
    }

    if (previousRole !== PROMOTABLE_ROLE) {
      console.error(
        `[P04C] P04C_INVALID_ROLE: current platformRole "${previousRole}" is not "${PROMOTABLE_ROLE}"; tenant roles cannot be promoted.`,
      );
      return 6;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { platformRole: ALLOWED_TARGET },
      select: { id: true, email: true, platformRole: true },
    });

    console.log(
      `[P04C] P04C_PROMOTED: target=${updated.email} previous=${previousRole} final=${updated.platformRole}`,
    );
    return 0;
  } catch (error) {
    const errorCode = typeof error?.code === 'string' ? error.code : '';
    const isConnectionFailure =
      (Prisma?.PrismaClientInitializationError !== undefined &&
        error instanceof Prisma.PrismaClientInitializationError) ||
      ['P1001', 'P1002', 'P1017'].includes(errorCode);
    if (isConnectionFailure) {
      console.error('[P04C] P04C_DB_CONNECTION_FAILED: could not reach the database.');
      return 4;
    }
    console.error(
      `[P04C] P04C_DB_OPERATION_FAILED: database operation rejected (code ${errorCode || 'unknown'}).`,
    );
    return 7;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

run().then((code) => {
  process.exitCode = code;
});