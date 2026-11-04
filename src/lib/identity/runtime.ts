import { IdentityService } from './service';
import { PostgresIdentityRepository } from './repository';
import { IdentityMailer, type IdentityMailTransport, SmtpAdapter } from './mail';
import { identityConfig } from './config';
import { db } from '../db';
import { RelayTransport } from './relay-transport';
import type { PrismaClient } from '@prisma/client';

export function createIdentityService(): IdentityService | null {
  try {
    const cfg = identityConfig(process.env as Record<string, string | undefined>);
    if (!cfg.enabled) return null;
    let transport: IdentityMailTransport;
    const isRelay = (process.env.ACCOUNTEXPRESS_MAIL_MODE || '') === 'relay';
    if (isRelay) {
      transport = new RelayTransport();
    } else {
      transport = new SmtpAdapter({
        host: process.env.SMTP_HOST || '',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: (process.env.SMTP_SECURE || 'false') === 'true',
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
        from: process.env.SMTP_FROM || '',
        fromName: process.env.SMTP_FROM_NAME || 'Sistema1',
      });
    }
    const mailer = new IdentityMailer(transport);
    return new IdentityService(
      cfg,
      new PostgresIdentityRepository(db as unknown as PrismaClient),
      mailer,
    );
  } catch {
    return null;
  }
}
