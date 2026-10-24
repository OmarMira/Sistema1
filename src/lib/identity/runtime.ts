import { IdentityService } from './service';
import { PostgresIdentityRepository } from './repository';
import { IdentityMailer, SmtpAdapter } from './mail';
import { identityConfig } from './config';
import { db } from '../db';
import type { PrismaClient } from '@prisma/client';

export function createIdentityService(): IdentityService | null {
  try {
    const cfg = identityConfig(process.env as Record<string, string | undefined>);
    if (!cfg.enabled) return null;
    const adapter = new SmtpAdapter({
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: (process.env.SMTP_SECURE || 'false') === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.SMTP_FROM || '',
      fromName: process.env.SMTP_FROM_NAME || 'Sistema1',
    });
    return new IdentityService(
      cfg,
      new PostgresIdentityRepository(db as unknown as PrismaClient),
      new IdentityMailer(adapter),
    );
  } catch {
    return null;
  }
}
