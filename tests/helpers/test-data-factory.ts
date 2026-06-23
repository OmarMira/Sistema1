import { randomUUID, randomInt } from 'crypto';

export function generateTestUser() {
  return {
    id: randomUUID(),
    email: `test-user-${randomInt(1000, 9999)}@example.com`,
    passwordHash: '$2b$12$dummyhashfortestingonly...',
    firstName: 'Test',
    lastName: 'User',
    role: 'company_admin',
    isActive: true,
  };
}

export function generateMockPDFBuffer() {
  const text = `Bank of America MOCK STATEMENT CYCLE
01/15/2025 DEPOSIT TEST 500.00
01/20/2025 WITHDRAWAL TEST -150.00
01/25/2025 TRANSFER TEST 200.00`.trim();

  return Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj
4 0 obj<</Length ${text.length}>>stream
BT /F1 10 Tf 72 720 Td (${text.replace(/\n/g, ') Tj ET\nBT /F1 10 Tf 72 ')}) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000${274 + text.length} 00000 n
trailer<</Size 5/Root 1 0 R>>
startxref
${370 + text.length}
%%EOF`);
}
