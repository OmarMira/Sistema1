import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const localPlugin = {
  rules: {
    "no-server-import-in-client": {
      meta: {
        type: "problem",
        docs: { description: "Block Client Components from importing server code" },
      },
      create(context) {
        const RESTRICTED = [
          /^@\/internal\/company-knowledge$/,
          /^@\/internal\/company-knowledge\/index$/,
          /^@\/internal\/company-knowledge\/server$/,
          /^@\/internal\/company-knowledge\/(entity\/service|integration|audit|relationship\/service)/,
        ];
        return {
          Program(node) {
            const isClient = node.body.some(
              (b) => b.type === "ExpressionStatement" && b.expression.type === "Literal" && b.expression.value === "use client"
            );
            if (!isClient) return;
            for (const stmt of node.body) {
              if (stmt.type !== "ImportDeclaration") continue;
              const src = stmt.source.value;
              if (RESTRICTED.some((re) => re.test(src))) {
                context.report({ node: stmt, message: `'${src}' is server-only and cannot be imported from a Client Component.` });
              }
            }
          },
        };
      },
    },
  },
};

export const localRules = localPlugin.rules;

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react-hooks/preserve-manual-memoization": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    "react-hooks/set-state-in-effect": "off",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  plugins: { local: localPlugin },
  rules: {
    "local/no-server-import-in-client": "error",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", "scripts/**", "*.mjs", "tests/**"]
}];

export default eslintConfig;
