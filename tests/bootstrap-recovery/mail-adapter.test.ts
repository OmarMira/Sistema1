import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const behaviour = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'reject' }));
const createTransport = vi.hoisted(() => () => ({
  sendMail: async (message: Record<string, unknown>) => {
    if (behaviour.mode === 'reject') throw new Error('provider said: 535 bad credentials for token abc');
    sent.push(message);
  },
}));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { IdentityMailer, SmtpAdapter } from '@/lib/identity/mail';
import { createRecoveryMailTransport, deliverRecoveryToken } from '@/lib/backup-recovery-mail';

const SMTP_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_FROM_NAME'];
const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function adapter() {
  return new SmtpAdapter({ host: '', port: 587, secure: false, user: '', pass: '', from: '' });
}

beforeEach(() => {
  for (const key of SMTP_ENV) saved.set(key, process.env[key]);
  sent.length = 0;
  behaviour.mode = 'ok';
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('smtp adapter delivery contract', () => {
  it('refuses to pretend it delivered when SMTP is not configured', async () => {
    setEnv({ SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined });
    await expect(adapter().send({ type: 'recovery', to: 'owner@example.test', token: 'a'.repeat(64) }))
      .rejects.toThrow(/not configured/i);
    // The identity mailer reports the delivery as failed instead of a silent success.
    expect(await new IdentityMailer(adapter()).recovery('owner@example.test', 'a'.repeat(64))).toBe(false);
  });

  it('keeps the configured delivery behaviour and message shape', async () => {
    setEnv({
      SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false',
      SMTP_USER: 'mailer@example.test', SMTP_PASS: 'secret', SMTP_FROM: 'mailer@example.test',
      SMTP_FROM_NAME: 'Sistema1',
    });
    const token = 'b'.repeat(64);
    expect(await new IdentityMailer(adapter()).recovery('owner@example.test', token)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@example.test');
    expect(String(sent[0].text)).toContain(token);
  });

  it('propagates only a sanitized failure from the provider', async () => {
    setEnv({
      SMTP_HOST: 'smtp.example.test', SMTP_USER: 'mailer@example.test', SMTP_PASS: 'secret',
      SMTP_FROM: 'mailer@example.test',
    });
    behaviour.mode = 'reject';
    let message = '';
    try {
      await adapter().send({ type: 'recovery', to: 'owner@example.test', token: 'c'.repeat(64) });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('SMTP delivery rejected');
    expect(message).not.toMatch(/token|credentials/i);
  });
});

describe('recovery token delivery', () => {
  it('never reports success without a transport', async () => {
    setEnv({ SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, SMTP_FROM: undefined });
    expect(createRecoveryMailTransport(process.env)).toBeNull();
    expect(await deliverRecoveryToken(null, { to: 'owner@example.test', token: 'd'.repeat(64) }))
      .toBe('mail_unavailable');
    expect(await deliverRecoveryToken(undefined, { to: 'owner@example.test', token: 'd'.repeat(64) }))
      .toBe('mail_unavailable');
  });

  it('reports a failed delivery and leaks no token', async () => {
    const outcome = await deliverRecoveryToken(
      { send: async () => { throw new Error('boom ' + 'e'.repeat(64)); } },
      { to: 'owner@example.test', token: 'e'.repeat(64) },
    );
    expect(outcome).toBe('delivery_failed');
  });

  it('rejects a malformed recipient or token before handing it to the provider', async () => {
    const calls: unknown[] = [];
    const transport = { send: async (message: unknown) => { calls.push(message); } };
    expect(await deliverRecoveryToken(transport, { to: 'not-an-email', token: 'f'.repeat(64) }))
      .toBe('delivery_failed');
    expect(await deliverRecoveryToken(transport, { to: 'owner@example.test', token: 'short' }))
      .toBe('delivery_failed');
    expect(calls).toHaveLength(0);
    expect(await deliverRecoveryToken(transport, { to: 'owner@example.test', token: 'f'.repeat(64) }))
      .toBe('sent');
    expect(calls).toHaveLength(1);
  });
});
