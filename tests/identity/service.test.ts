import { expect, it, vi } from 'vitest';
import { IdentityMailer } from '../../src/lib/identity/mail';
import { IdentityService, NEUTRAL_RESPONSE } from '../../src/lib/identity/service';

it('disabled service does not access persistence, deliver mail or consume counters', async () => {
  const repository = new Proxy({}, { get() { throw new Error('Persistence accessed'); } });
  const send = vi.fn();
  const service = new IdentityService({ enabled: false }, repository as never, new IdentityMailer({ send }));
  expect(await service.requestRecovery('unknown@example.test')).toBe(NEUTRAL_RESPONSE);
  expect(await service.beginRegistration('new@example.test')).toBe(NEUTRAL_RESPONSE);
  expect(await service.resendVerification('new@example.test')).toBe(NEUTRAL_RESPONSE);
  expect(await service.verifyCode('new@example.test', '000000')).toBe(false);
  expect(await service.consumeRecovery('a'.repeat(64))).toBe(null);
  expect(send).not.toHaveBeenCalled();
});
it('mail is provider-neutral, failure-safe and fails closed without transport', async () => {
  expect(await new IdentityMailer().verification('x@example.test', '000001')).toBe(false);
  const send = vi.fn().mockRejectedValue(new Error('secret transport data'));
  expect(await new IdentityMailer({ send }).verification('x@example.test', '000001')).toBe(false);
  expect(send).toHaveBeenCalledOnce();
});
