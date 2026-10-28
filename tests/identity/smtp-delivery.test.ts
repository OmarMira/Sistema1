import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IdentityMailer, SmtpAdapter, type IdentityMessage } from '../../src/lib/identity/mail';

const mocks = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }));
const config = {
  host: 'smtp.example.invalid', port: 587, secure: false,
  user: 'sender@example.invalid', pass: 'fixture-password', from: 'sender@example.invalid',
};
const messages: IdentityMessage[] = [
  { type: 'verification', to: 'recipient@example.invalid', code: '123456' },
  { type: 'recovery', to: 'recipient@example.invalid', token: 'fixture-recovery-token' },
];
function deliver(message: IdentityMessage) {
  const mailer = new IdentityMailer(new SmtpAdapter(config));
  return message.type === 'verification'
    ? mailer.verification(message.to, message.code)
    : mailer.recovery(message.to, message.token);
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({
    SMTP_HOST: config.host, SMTP_PORT: '587', SMTP_SECURE: 'false',
    SMTP_USER: config.user, SMTP_PASS: config.pass, SMTP_FROM: config.from, SMTP_FROM_NAME: '',
  })) vi.stubEnv(key, value);
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  mocks.sendMail.mockResolvedValue({ accepted: ['recipient@example.invalid'] });
});
afterEach(() => vi.unstubAllEnvs());

it.each(messages.flatMap(message => ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].map(missing => ({
  message, missing, type: message.type,
}))))('reports $type delivery failure without sending when $missing is absent', async ({ message, missing }) => {
  vi.stubEnv(missing, '');
  expect(await deliver(message)).toBe(false);
  expect(mocks.createTransport).not.toHaveBeenCalled();
  expect(mocks.sendMail).not.toHaveBeenCalled();
});

it.each(messages)('preserves successful $type SMTP delivery', async (message) => {
  expect(await deliver(message)).toBe(true);
  expect(mocks.createTransport).toHaveBeenCalledExactlyOnceWith({
    host: config.host, port: 587, secure: false, auth: { user: config.user, pass: config.pass },
  });
  const secret = message.type === 'verification' ? message.code : message.token;
  expect(mocks.sendMail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    from: config.from, to: message.to,
    text: expect.stringContaining(secret), html: expect.stringContaining(secret),
  }));
});

it.each(messages)('preserves sanitized $type provider failure without leaking its payload', async (message) => {
  mocks.sendMail.mockRejectedValue(new Error('private provider payload: fixture-password'));
  await expect(new SmtpAdapter(config).send(message)).rejects.toThrow(/^SMTP delivery rejected$/);
  expect(await deliver(message)).toBe(false);
});
