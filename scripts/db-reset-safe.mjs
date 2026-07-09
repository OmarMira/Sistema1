import { execSync } from 'child_process';

const url = process.env.DATABASE_URL ?? '';
if (!url.includes('test')) {
  console.error('❌ ABORTADO: DATABASE_URL no contiene "test".');
  console.error('   prisma migrate reset solo puede ejecutarse contra una base de datos de prueba.');
  console.error(`   URL actual: ${url.slice(0, 60)}...`);
  process.exit(1);
}

console.log('⚠️  Ejecutando prisma migrate reset en base de TEST...');
execSync('prisma migrate reset --force', { stdio: 'inherit' });
