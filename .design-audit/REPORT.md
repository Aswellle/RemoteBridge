# RemoteBridge Web Client — Design Audit Report
**Date:** 2026-06-26  
**Branch:** main  
**Auditor:** gstack design-review v1.58.5.0  
**Scope:** apps/web — connect page, dashboard, all responsive breakpoints

---

## Summary

4 real issues found and fixed. 1 false positive (FINDING-005, preventive fix still applied). FINDING-002 initially deferred, then implemented. A second pass then resolved all remaining UI/UX polish items.

**Overall Grade: A−** (up from B+ after pass 2)  
**AI Slop Score: A** (Inter font applied for Latin headings; no icon grids, no emoji bullets, no purple gradients)

---

## Pass 1 — Audit Findings (FINDING-001 to 005)

### FINDING-001 — Mobile connect page layout broken (HIGH)
**Status: FIXED** | Commit: `801ae5c`

**Problem:** `apps/web/src/app/page.tsx:88` — sidebar `div` had no mobile hide class. At 375px the sidebar took ~288px of a 375px viewport, leaving ~87px for the form. The form was completely unusable on mobile.

**Root cause:** Dashboard layout correctly uses `hidden lg:flex` (line 196 of dashboard/layout.tsx), but the connect page sidebar used bare `flex flex-col` — never adopted the same responsive pattern.

**Fix:** `flex flex-col` → `hidden lg:flex flex-col`

**Before:** sidebar always visible, form crushed to 87px  
**After:** sidebar hidden on mobile, form takes full viewport — clean, usable

---

### FINDING-002 — System font stack only (HIGH → IMPLEMENTED)
**Status: FIXED** | Commit: `2fed30d`

**Problem:** `apps/web/src/app/globals.css:65` uses `-apple-system, BlinkMacSystemFont, ...` — no custom typeface.

**Implementation:** `next/font/google` Inter applied via CSS variable `--font-inter` to `<body>`. Latin subsets only — CJK text continues to use system fonts (PingFang SC / Microsoft YaHei / Noto Sans CJK) at native quality. `--font-inter` prepended to the system font-family fallback stack in `globals.css`.

---

### FINDING-003 — Hydration warning on every page load (MEDIUM)
**Status: FIXED** | Commit: `7692f86`

**Problem:** `apps/web/src/app/layout.tsx:16` — `<html lang="zh-CN">` missing `suppressHydrationWarning`. The inline blocking script sets theme class on `<html>` before React hydrates (correct FOUC prevention), but React saw a class attribute mismatch and emitted a warning on every load.

**Fix:** Added `suppressHydrationWarning` to `<html>`.

---

### FINDING-004 — H1 brand "RemoteBridge" same visual size as H2 page heading (MEDIUM)
**Status: FIXED** | Commits: `4f5a58a`, `42a3df7`

**Problem:** `apps/web/src/app/page.tsx:91` — sidebar brand H1 `text-2xl font-bold` matched the page heading H2 "连接到远程电脑" at `text-2xl font-bold`. Brand marks should be visually subordinate to page headings.

**Fix:** Connect page sidebar brand reduced from `text-2xl` → `text-lg` → then aligned to `text-xl` (matching dashboard sidebar). Dashboard sidebar uses `text-xl`; both are now visually consistent and clearly smaller than `text-2xl` page headings.

---

### FINDING-005 — Dashboard stat cards overflowing viewport (POLISH → FALSE POSITIVE)
**Status: FALSE POSITIVE** | Commit: `ad819e1` (preventive fix still applied)

**Investigation:** JS measurement confirmed `mainScrollWidth === mainWidth === 1024px`, `isOverflowing: false`. The apparent clipping was a visual artifact from the skeleton state.

**Preventive fix applied:** Added `min-w-0` to `<main className="flex-1 min-w-0 overflow-auto">`. Without `min-w-0`, a flex child's `min-width: auto` can cause overflow if grid content grows.

---

## Pass 2 — Systematic UI/UX Polish

### Group A — Empty / disconnected states (3 pages)
**Commit: `bb35528`**

All three dashboard sub-pages (files, messages, security) had identical bare disconnected states: centered text + plain `<a>` link, no icon, no context.

**Fix:** Created shared `apps/web/src/components/ui/NotConnected.tsx`:
- `WifiOff` default icon (overridden per page: `FolderOpen`, `MessageSquare`, `ShieldCheck`)
- `rounded-2xl bg-muted/50` icon container
- Page-specific description prop
- `<Link>` styled as a proper primary button

Applied to `files/page.tsx`, `messages/page.tsx`, `security/page.tsx`.

---

### Group B — Inter typography
**Commit: `2fed30d`** (same as FINDING-002 above)

---

### Group C — Mobile brand mark
**Commit: `b1d5b38`**

After hiding the connect page sidebar on mobile (FINDING-001), there was no brand identity on small screens. Added a `lg:hidden` brand block above the form heading showing "RemoteBridge" + "远程文件桥接系统".

---

### Group D — Spinner consistency in files page
**Commit: `da4cc2d`**

`files/page.tsx` used an inline raw SVG for the loading spinner. All other pages use `Loader2` from lucide-react. Replaced with `<Loader2 className="animate-spin h-8 w-8 text-primary" />`.

---

### Group E — Settings heading weight + icon color
**Commit: `59c830d`**

- `settings/page.tsx` used `font-bold`; all other dashboard pages use `font-semibold`. Fixed to `font-semibold`.
- Settings gear icon was inheriting foreground color; changed to `text-muted-foreground` for visual subordination.

---

### Group F — Dashboard security card color
**Commit: `59c830d`**

Quick-action "安全审计" card used `text-destructive`/`bg-destructive` (red). Red signals danger/irreversible actions — viewing security logs is neither. Changed to `text-indigo-400`/`bg-indigo-600` (blue-purple), consistent with the card's informational intent.

---

### Group G — Connect page brand alignment + security filter radius
**Commit: `42a3df7`**

- Connect page sidebar brand: `text-lg` → `text-xl` to match dashboard sidebar's `text-xl font-bold`.
- Security page filter bar controls (`<select>`, `<input>`, `<button>`): `rounded` (4px) → `rounded-lg` (8px) to match the rest of the UI's `--radius: 0.5rem`.

---

## Design System State (post pass 2)

| Token | Value | Status |
|-------|-------|--------|
| Font (Latin) | Inter via `next/font/google` | ✓ Applied |
| Font (CJK) | System (PingFang SC / YaHei / Noto) | ✓ Native |
| Dark default | `:root` dark, `.light` via JS | ✓ Correct |
| Theme hydration | `suppressHydrationWarning` on `<html>` | ✓ Fixed |
| Color tokens | 8-color palette, CSS vars | ✓ Clean |
| Border radius | `--radius: 0.5rem` uniform | ✓ Clean |
| Focus visible | Global `focus-visible` ring | ✓ Present |
| Mobile sidebar (connect) | `hidden lg:flex` | ✓ Fixed |
| Mobile sidebar (dashboard) | `hidden lg:flex` | ✓ Was correct |
| Mobile brand (connect) | `lg:hidden` brand mark | ✓ Added |
| Flex overflow guard | `min-w-0` on dashboard main | ✓ Fixed |
| Empty states | Shared `NotConnected` component | ✓ 3 pages |
| Spinner | `Loader2` consistent | ✓ All pages |
| Heading weight | `font-semibold` uniform | ✓ All pages |
| Brand size | `text-xl font-bold` both sidebars | ✓ Aligned |
| Security card color | `indigo` (was `destructive`) | ✓ Fixed |
| Filter border radius | `rounded-lg` uniform | ✓ Fixed |

---

## All Commits

| Commit | Pass | Change |
|--------|------|--------|
| `801ae5c` | 1 | FINDING-001: connect page sidebar `hidden lg:flex` |
| `7692f86` | 1 | FINDING-003: `suppressHydrationWarning` on `<html>` |
| `4f5a58a` | 1 | FINDING-004: sidebar H1 `text-2xl` → `text-lg` |
| `ad819e1` | 1 | FINDING-005: `min-w-0` on dashboard `<main>` |
| `bb35528` | 2 | NotConnected shared component; files/messages/security pages |
| `2fed30d` | 2 | FINDING-002: Inter font via CSS variable |
| `b1d5b38` | 2 | Mobile brand mark on connect page |
| `da4cc2d` | 2 | Loader2 spinner in files page (replaces raw SVG) |
| `59c830d` | 2 | Settings heading `font-semibold`; security card `indigo` |
| `42a3df7` | 2 | Brand `text-xl` alignment; filter bar `rounded-lg` |

---

## Remaining Known Issues

- **Full-data review:** All screenshots capture disconnected/skeleton state. A review against a live connected Host would audit real content states — long file names, truncation, large message lists, pagination, 100+ security log entries, etc.
