import { PrismaClient } from '@prisma/client';
import readline from 'readline';

const url = process.env.DATABASE_URL ?? '';
const force = process.argv.includes('--force');

if (!url.includes('test') && !force) {
  console.error('❌ ABORTADO: DATABASE_URL no contiene "test".');
  console.error('   Para borrar en producción, agregá --force:');
  console.error('   node scripts/clear-ai-config.mjs --force');
  console.error(`   URL actual: ${url.slice(0, 60)}...`);
  process.exit(1);
}

// Confirm before deleting
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise((resolve) => {
  rl.question('⚠️  ¿Borrar TODA la configuración del sistema? (escribe "SI" para confirmar): ', resolve);
});
rl.close();

if (answer !== 'SI') {
  console.log('Cancelado.');
  process.exit(0);
}

const db = new PrismaClient();
try {
  const r = await db.systemConfig.deleteMany();
  console.log('Deleted:', r.count);
} catch (e) {
  console.error(e);
} finally {
  await db.$disconnect();
}
