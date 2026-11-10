# AccountExpress design system

Synced from `src/app/globals.css` and `tailwind.config.ts`. The active CSS uses OKLCH `--app-*` tokens; the Tailwind config also contains legacy HSL mappings. The prototype follows the active CSS, without changing application source.

## Colors

Token | Light | Dark | Usage
--- | --- | --- | ---
--app-background |  oklch(1 0 0) |  oklch(0.17 0.005 260) | background
--app-foreground |  oklch(0.145 0 0) |  oklch(0.985 0 0) | foreground
--app-card |  oklch(1 0 0) |  oklch(0.22 0.005 260) | card
--app-primary |  oklch(0.51 0.12 180) |  oklch(0.7 0.14 180) | primary
--app-primary-foreground |  oklch(0.985 0 0) |  oklch(0.145 0 0) | primary-foreground
--app-muted |  oklch(0.97 0 0) |  oklch(0.269 0.005 260) | muted
--app-muted-foreground |  oklch(0.556 0 0) |  oklch(0.708 0 0) | muted-foreground
--app-border |  oklch(0.922 0 0) |  oklch(1 0 0 / 10%) | border
--app-ring |  oklch(0.51 0.12 180) |  oklch(0.7 0.14 180) | ring
--app-accent |  oklch(0.97 0.005 180) |  oklch(0.269 0.01 180) | accent

## Typography
Application: Geist Sans / Geist Mono variables (`src/app/globals.css`). Standalone artboards: system-ui fallback; no remote fonts. Header size 18px, primary heading 24px, body 14px, supporting copy 12px follow `src/components/spa/BootstrapPage.tsx`.

## Layout and components
- Spacing: 4, 8, 16, 24, 48px from BootstrapPage Tailwind spacing utilities. Header height: 56px.
- Radius: 0.625rem base, minus 4px small, minus 2px medium, plus 4px extra large (`src/app/globals.css`).
- No custom shadow token recorded; prefer borders for this prototype.
- Header: AE badge, product name, language selector then theme toggle (`BootstrapPage.tsx`). Languages: Spanish (Mexico) and English (US), from `LanguageSelector.tsx`. Dark theme shows sun; light theme shows moon (`ThemeToggle.tsx`).
- Preview must identify simulated actions and must not claim database setup or email delivery. No authenticated-user avatar before registration.
