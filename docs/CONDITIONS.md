# GeoLocation Attendance — Conditions & Constraints

**Project:** GeoLocation Attendance | **Owner:** Prasidha Jagtap | **Date:** 2026-06-28

---

## Environment Conditions

| # | Condition | Detail |
|---|---|---|
| E1 | SharePoint Online required | App runs inside a SharePoint Script Editor or Page Viewer Web Part on `onehruat.poornata.com` |
| E2 | Azure AD identity | Name and Poornata ID auto-read from SharePoint hidden fields at runtime; manual fallback form shown if detection fails |
| E3 | HTTPS only | Geolocation API (`navigator.geolocation`) is blocked by browsers on plain HTTP |
| E4 | Modern mobile browser | Chrome 90+, Safari 14+, Edge 90+; GPS and `dvh` units required |
| E5 | Supabase project active | Free-tier projects pause after inactivity; a keep-alive RPC ping fires on page load to prevent this |
| E6 | No bundler or build step | Source files are edited and deployed as-is; no transpilation, no npm build |

---

## Security Conditions

| # | Condition | Detail |
|---|---|---|
| S1 | RLS must be ENABLED on `public.attendance` | Without RLS, the public anon key can read/update/delete all rows |
| S2 | Anon key has INSERT only | RLS policy grants INSERT; all other operations are revoked at the DB level |
| S3 | History read only via RPC | Direct SELECT on the table is denied; the `recent_shifts(emp)` security-definer function returns only the requesting employee's last 7 shifts |
| S4 | Anon key is permanently public | It ships in `app.js` and appears in every network request; rotating it provides no security gain while RLS is active — real protection is the DB policies |
| S5 | No per-user DB isolation | App uses SharePoint/Azure identity on the client; Supabase sees only the anon role — cannot enforce "only my rows" at DB level without Supabase Auth |

---

## Input Conditions

| # | Condition | Detail |
|---|---|---|
| I1 | Name: letters + spaces only | 2–60 characters; regex `/^[a-zA-Z\s]{2,60}$/` |
| I2 | Poornata ID: digits only | 3–12 digits; non-digit chars stripped in the DB payload regardless |
| I3 | Location name: alphanum + space + hyphen | 1–20 characters; `maxlength="20"` enforced in HTML and validator |
| I4 | All inputs sanitized before DB write | `sanitize()` strips `< > " ' ; = + # \| \ / ( ) { } % @ \`` as a second layer of defence |
| I5 | GPS required for clock-in / clock-out | `maximumAge:0` — no cached positions accepted; user sees error if permission denied |

---

## Operational Conditions

| # | Condition | Detail |
|---|---|---|
| O1 | Single active shift per session | State machine prevents double clock-in; re-open after submit starts a new shift |
| O2 | Offline: submit queued | App detects `navigator.onLine`; offline banner shown; submit retried when back online |
| O3 | Shift history shows last 7 punches | No date window — shows the most recent 7 regardless of how long ago |
| O4 | Location names ≤ 20 chars | Enforced at input (maxlength), validator, and DB sanitize; longer names are rejected before insert |
| O5 | Times display device-independently | Manual 12-hour format (not `toLocaleTimeString`) — AM/PM always English; digits localized per language |
| O6 | Right-click disabled | Browser context menu suppressed as a casual deterrent; F12 / Ctrl+Shift+I still accessible |

---

## CSS / Layout Conditions

| # | Condition | Detail |
|---|---|---|
| C1 | No page scroll on mobile | `section.smx-shell` fixed to `100dvh`; content scrolls internally when it overflows |
| C2 | SP host CSS must not bleed into app | All app rules scoped under `.smx-wrap`; SP chrome suppressed via `display:none` block |
| C3 | Dark / light theme via `data-theme` | Applied on `<html>`; persisted in `localStorage` |
| C4 | `dvh` units required for iOS | `100dvh` on backdrops and shell prevents iOS URL-bar from hiding the Close button |

---

*This document covers conditions as of the current deployment. Revisit if the SharePoint version, Supabase plan, or browser support matrix changes.*
