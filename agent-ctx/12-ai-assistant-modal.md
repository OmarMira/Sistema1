# Task ID: 12 - AI Assistant Modal

## Agent: Main Orchestrator

## Work Log

### 1. Updated auth-store.ts
- Added `aiAssistantOpen: boolean` state field
- Added `setAiAssistantOpen: (open: boolean) => void` action
- Initialized `aiAssistantOpen: false` in default state
- Reset `aiAssistantOpen: false` on logout

### 2. Added i18n Translations
- Added `aiAssistant` key to `/src/i18n/locales/es.ts` with 22 translation keys (Spanish)
- Added `aiAssistant` key to `/src/i18n/locales/en.ts` with 22 translation keys (English)
- Keys cover: title, greeting, subtitle, chat, createRule, inputPlaceholder, shiftEnterHint, ruleTitle, ruleInstructions, ruleExample, createRuleButton, saveRule, ruleCreated, analyzing, error, saveRuleButton, parsedRule, ruleName, condition, account, priority, direction

### 3. Created API Route: `/src/app/api/ai-assistant/route.ts`
- POST endpoint accepting `{ message, companyId?, mode }`
- **Chat mode**: Uses z-ai-web-dev-sdk with system prompt for "Asistente Contable" - bilingual Spanish/English accounting assistant
- **Create-rule mode**: Parses natural language rule descriptions into structured JSON with: name, conditionType, conditionValue, transactionDirection, glAccountName, priority
- JSON extraction handles markdown code blocks and raw JSON responses
- Input validation with descriptive Spanish error messages
- Returns `{ reply, parsedRule? }`

### 4. Created AIAssistantModal.tsx Component
- Dark themed modal (bg-[#1a2332]) with rounded corners and full-screen overlay
- Large modal (90% width, max-w-4xl)
- Close button (X) + Escape key support
- Header with purple Sparkles icon, "Asistente IA" title, company name subtitle
- Two mode tabs (Chat / Crear Regla) with blue active state
- **Chat Mode**: Welcome screen with Bot icon, greeting text, auto-growing textarea input, Send button, Shift+Enter hint, chat history with user/assistant bubbles, typing indicator animation
- **Crear Regla Mode**: Instructions with Sparkles icon, example text, textarea input, parsed rule card with green border, Save Rule button that calls /api/bank-rules
- framer-motion animations for modal entrance/exit, message appearance, error banners
- Uses shadcn/ui Button, Input, Badge, ScrollArea
- Uses lucide-react icons throughout
- Fully i18n'd via useLanguageStore
- Uses useAuthStore for activeCompany and aiAssistantOpen state

### 5. Integrated into AppShell
- Added `AIAssistantModal` import and rendering in AppShell
- Added "Asistente IA" button with Sparkles icon in mobile sidebar (SidebarNav)
- Added "Asistente IA" button in desktop sidebar (DesktopNavItems)
- Purple hover color scheme for AI button (distinct from other nav items)

### 6. Lint Results
- All 5 lint errors are pre-existing in settings tabs (not from new code)
- New files have zero lint errors

## Files Created/Modified
- **Modified**: `/src/store/auth-store.ts`
- **Modified**: `/src/i18n/locales/es.ts`
- **Modified**: `/src/i18n/locales/en.ts`
- **Created**: `/src/app/api/ai-assistant/route.ts`
- **Created**: `/src/components/spa/AIAssistantModal.tsx`
- **Modified**: `/src/components/spa/AppShell.tsx`
