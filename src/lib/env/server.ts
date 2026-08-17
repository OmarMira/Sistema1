// ─── Server environment validation ──────────────────────────────────────────
// Centralized startup policy for required environment variables.
// Called once from instrumentation.ts before any runtime service is started.
// Expresses SERVER STARTUP requirements only — test-runner policy is handled
// separately by the existing guards (db.ts, tests/setup.ts).

interface EnvRequirement {
  name: string;
  requiredIn: Array<'development' | 'production'>;
}

const REQUIREMENTS: EnvRequirement[] = [
  {
    name: 'DATABASE_URL',
    requiredIn: ['development', 'production'],
  },
  {
    name: 'SESSION_SECRET',
    requiredIn: ['production'],
  },
];

export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const mode = env.NODE_ENV;
  if (mode === 'production') {
    for (const requirement of REQUIREMENTS) {
      if (!requirement.requiredIn.includes('production')) continue;
      const value = env[requirement.name];
      if (!value || value.trim() === '') {
        throw new Error(
          `Environment variable ${requirement.name} is required in production mode. ` +
            'Set it before starting the server.',
        );
      }
    }
    return;
  }

  if (mode === 'test') {
    return;
  }

  for (const requirement of REQUIREMENTS) {
    if (!requirement.requiredIn.includes('development')) continue;
    const value = env[requirement.name];
    if (!value || value.trim() === '') {
      throw new Error(
        `Environment variable ${requirement.name} is required in development mode. ` +
          'Set it before starting the server.',
      );
    }
  }
}