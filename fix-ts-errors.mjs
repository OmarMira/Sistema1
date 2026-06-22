// Simple TypeScript error fixer for common strict null check patterns
// Run with: node fix-ts-errors.js
import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

const fixes = [
  // Fix .split('.'). -> parts[0] and parts[1] with default empty string
  {
    pattern: /parts\[1\]/g,
    replacement: '(parts[1] ?? '')',
  },
  {
    pattern: /parts\[0\]/g,
    replacement: '(parts[0] ?? '')',
  },
];

const files = globSync('src/**/*.{ts,tsx}');
for (const file of files) {
  let content = readFileSync(file, 'utf-8');
  const original = content;
  for (const fix of fixes) {
    content = content.replace(fix.pattern, fix.replacement);
  }
  if (content !== original) {
    writeFileSync(file, content, 'utf-8');
    console.log('Fixed: ' + file);
  }
}
console.log('Done');
