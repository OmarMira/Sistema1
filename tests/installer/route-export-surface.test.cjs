// Public source export-surface regression test for route modules.
// Uses TypeScript parser to extract exported identifiers and asserts only
// Next-supported route exports (GET/POST/PUT/DELETE/HEAD/PATCH/OPTIONS/config/dynamic/metadata/generateStaticParams) are present.
// Forbidden names observed in RED build failure are verified absent from route files.

const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const ROUTE_FILES = [
  'src/app/api/admin/shadow-metrics/route.ts',
  'src/app/api/bank-rules/simulate/route.ts',
  'src/app/api/learning/classification-conflicts/route.ts',
  'src/app/api/learning/classification-conflicts/[id]/rehabilitate/route.ts',
  'src/app/api/reconciliation/auto/route.ts',
];

const ALLOWED = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH', 'OPTIONS',
  'config', 'dynamic', 'metadata', 'generateStaticParams', 'revalidate',
]);

const FORBIDDEN = [
  'parseDateOrError', 'parseSimulateLimit', 'toPendingConflictApiEntry',
  'mapRehabilitationResult', 'revalidateAutoMatchCandidate',
];

function getExports(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
  const exports = [];
  function visit(node) {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          exports.push(el.name.text);
        }
      }
    } else if (ts.isVariableStatement(node) && node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) exports.push(decl.name.text);
      }
    } else if (ts.isFunctionDeclaration(node) && node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (node.name) exports.push(node.name.text);
    } else if (ts.isTypeAliasDeclaration(node) && node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      exports.push(node.name.text);
    } else if (ts.isInterfaceDeclaration(node) && node.modifiers && node.modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
      exports.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...new Set(exports)];
}

let failed = false;
for (const rel of ROUTE_FILES) {
  const p = path.resolve(rel);
  const exports = getExports(p);
  for (const ex of exports) {
    if (!ALLOWED.has(ex)) {
      console.error('FORBIDDEN export in ' + rel + ': ' + ex);
      failed = true;
    }
  }
  for (const bad of FORBIDDEN) {
    if (exports.includes(bad)) {
      console.error('FORBIDDEN NAME STILL EXPORTED in ' + rel + ': ' + bad);
      failed = true;
    }
  }
  console.log('OK ' + rel + ' exports=' + exports.join(',') + ' forbidden-absent=' + (FORBIDDEN.every(b => !exports.includes(b)) ? 'yes' : 'NO'));
}

if (failed) {
  console.error('route-export-surface regression FAILED');
  process.exit(1);
} else {
  console.log('route-export-surface regression PASSED');
  process.exit(0);
}
