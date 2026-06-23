import fs from 'fs/promises';
import path from 'path';

export default async function globalTeardown() {
  const testDb = path.resolve(process.cwd(), 'test.db');
  try {
    await fs.unlink(testDb);
    console.log('🧹 [Vitest] Test database cleaned up successfully.');
  } catch {
    // Ignore if file doesn't exist (first run or already cleaned)
  }
}
