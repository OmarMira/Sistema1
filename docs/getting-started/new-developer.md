# New Developer Guide

## Prerequisites

| Herramienta | Versión | Notas |
|---|---|---|
| Node.js | 18+ | |
| bun | 1.x | Package manager |
| PostgreSQL | 15+ | Windows service |
| Caddy | 2.x | Opcional (proxy) |

---

## Setup

```bash
# 1. Clonar
git clone <repo>
cd sistema

# 2. Instalar dependencias
bun install

# 3. Generar SESSION_SECRET (AES-256-GCM, 64 caracteres hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copiar el resultado

# 4. Crear .env
cp .env.example .env
# Editar DATABASE_URL y pegar SESSION_SECRET

# 5. Inicializar base de datos
bun run db:generate
bun run db:migrate

# 6. Ejecutar tests (opcional, ~8.5 min)
bun run test

# 7. Iniciar servidor
bun run dev
# → http://localhost:3000
```

---

## Lectura recomendada (en orden)

1. `docs/architecture/overview.md` — entender las capas
2. `docs/architecture/bank-import.md` — el core del sistema
3. `docs/architecture/ai-decision-model.md` — cómo se usa la IA
4. `docs/adr/` — decisiones de arquitectura registradas
5. `docs/process/engineering-principles.md` — cómo trabajamos

---

## Convenciones

- TypeScript strict mode
- Tests en `tests/` siguiendo la estructura de `src/`
- Pull requests con descripción clara y tests
- Toda función nueva debe tener test
- No modificar producción para hacer pasar tests

---

## Comandos útiles

| Comando | Propósito |
|---|---|
| `bun run dev` | Servidor desarrollo (:3000) |
| `bun run build` | Build production |
| `bun run test` | Suite completa |
| `bun run test -- -t "nombre test"` | Test específico |
| `bun run lint` | ESLint |
| `bun run db:generate` | Prisma Client |
| `bun run db:migrate` | Migraciones |
| `caddy run` | Proxy :81 → :3000 |

---

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL (termina en `accountexpress`/`accountexpress_test`) |
| `SESSION_SECRET` | ✅ | AES-256-GCM (64 hex). No guarda API keys — van cifradas en DB |
| `NEXT_PUBLIC_SENTRY_DSN` | ❌ | Sentry |
