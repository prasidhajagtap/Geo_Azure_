# GeoLocation Attendance — Project Documentation

**Author:** Prasidha Jagtap  
**Deployed at:** `https://www.onehruat.poornata.com/Style%20Library/Geo-tagg/index.html`  
**Environment:** SharePoint Online — Script Editor / Page Viewer Web Part  
**Last updated:** 2026-06-28

---

## 1. Overview

A mobile-first, single-origin web attendance app embedded in SharePoint. Employees clock in and out with GPS-captured location names. Attendance records are stored in Supabase. No native app install required — works in any mobile browser.

---

## 2. File Structure

```
Style Library/Geo-tagg/
├── index.html      → Shell HTML (62 KB) — markup + SharePoint postback disabler
├── styles.css      → All CSS (121 KB) — scoped under .smx-wrap to isolate from SP host
└── app.js          → All JS (120 KB)  — state, i18n, Supabase client, validators, render
```

**Deploy all three files** to `/Style Library/Geo-tagg/` in SharePoint.  
CSS/JS referenced with absolute paths so they resolve in both preview and production.

> **Do not edit** the old monolithic `C:\TextApp\Attendance\index.html` — it is a pre-split backup.

---

## 3. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Backend | Supabase (PostgreSQL) | Managed, RLS-capable, free-tier available |
| Auth | Azure AD (SharePoint SSO) | Auto-detects name + Poornata ID from SP hidden fields |
| Geolocation | Browser `navigator.geolocation` | No API key required |
| Reverse geocode | BigDataCloud (free, no key) | Converts lat/lng → readable location hint |
| Fonts | Google Fonts — DM Sans + DM Mono | Weights loaded via preconnect |
| Supabase client | CDN — `@supabase/supabase-js@2` (UMD) | Single script tag, no bundler |
| i18n | Inline object, no external API | Hard constraint (no translation APIs) |
| CSS isolation | `.smx-wrap` scope | SharePoint host leaks neutralized |

---

## 4. Application Screens

### Auth Screen (`smx-auth-sec`)
Azure AD auto-detect via SharePoint hidden fields. Manual fallback form (name + Poornata ID) with whitelist validation. Animated inline loader while looking up the user.

### Welcome Screen (`smx-welcome-sec`)
Two large buttons: **Clock In** and **Clock Out**. Shows current user, PID, live clock. Footer has theme toggle, language picker, Shifts history, and recover button.

### Capture Screen (`smx-capture-sec`)
GPS capture with progress ring and live timer. Location name input (max 20 chars, letters/digits/spaces/hyphens only). Autocomplete chips from previously used names. Confirm button enabled only when GPS + location name are valid.

### Main Screen (`smx-main-sec`)
Shows current shift status: clocked-in time, elapsed duration, location. Edit button on each tile. Submit shift button (hold-to-confirm with ring animation).

### Success Screen (`smx-success-sec`)
Shift summary: clock-in, clock-out, duration, location. Shift history (Recent Shifts) modal accessible from footer.

### Recent Shifts Modal
Centered modal, `max-height: 84dvh`, internal scroll, scale+fade entrance. Shows last 7 **punched** shifts (no date window). Close button always pinned at bottom.

---

## 5. State Machine

Single state object `U` (localStorage-persisted):

```
null → AUTH → WELCOME → CAPTURE → MAIN (clocked in)
                                        → CAPTURE (clock out)
                                              → MAIN (both times set)
                                                    → SUCCESS (submitted)
                                                          → WELCOME
```

`renderMainBody()` reads `U` and routes to the correct screen. `save()` syncs `U` to localStorage on every change. State shape is validated on restore — tampered data cannot bypass the flow.

---

## 6. Database (Supabase)

**Table:** `public.attendance`

| Column | Type | Description |
|---|---|---|
| `user_name` | text | Sanitized display name |
| `employee_id` | text | Digits only (stripped) |
| `clock_in_time` | timestamptz | ISO timestamp |
| `clock_in_coords` | text | `lat,lng` |
| `clock_in_location_name` | text | User-entered, max 20 chars |
| `clock_out_time` | timestamptz | Null until clocked out |
| `clock_out_coords` | text | |
| `clock_out_location_name` | text | |
| `status` | text | `'partial'` or `'completed'` |
| `business_name` | text | From SP hidden fields |
| `business_unit` | text | |
| `business_desc` | text | |
| `bu_unit_desc` | text | |
| `clock_in_coord_source` | text | `'gps'` or `'cached'` |
| `clock_out_coord_source` | text | |

### Required SQL (run once in Supabase SQL editor)

```sql
-- 1. Enable RLS
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

-- 2. Anon key: INSERT only
DROP POLICY IF EXISTS "anon insert attendance" ON public.attendance;
CREATE POLICY "anon insert attendance"
  ON public.attendance FOR INSERT TO anon WITH CHECK (true);

REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON public.attendance FROM anon;
GRANT INSERT ON public.attendance TO anon;

-- 3. History read via guarded RPC (no direct SELECT)
CREATE OR REPLACE FUNCTION public.recent_shifts(emp text)
RETURNS TABLE (
  clock_in_time           timestamptz,
  clock_out_time          timestamptz,
  clock_in_location_name  text,
  clock_out_location_name text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT clock_in_time, clock_out_time,
         clock_in_location_name, clock_out_location_name
  FROM public.attendance
  WHERE employee_id = emp AND emp <> ''
  ORDER BY clock_in_time DESC
  LIMIT 7;
$$;

REVOKE ALL ON FUNCTION public.recent_shifts(text) FROM public;
GRANT EXECUTE ON FUNCTION public.recent_shifts(text) TO anon;
```

---

## 7. Security Model

| Layer | Mechanism |
|---|---|
| DOM XSS | All user text via `.textContent`; `esc()` for innerHTML; `sanitize()` strips `< > " ' ; = + # \| \ / ( ) { } % @ \`` |
| Input validation | Whitelist regex: `isValidName` (letters+spaces, 2–60), `isValidId` (digits, 3–12), `isValidLoc` (alphanum/space/hyphen, 1–20) |
| Database | RLS: anon INSERT only; no direct SELECT; history via `security definer` RPC |
| Key exposure | Supabase anon key is public by design — real protection is RLS, not the key |
| Right-click | `contextmenu` event blocked (casual deterrent — DevTools still accessible via F12) |
| SP postback | `__doPostBack` / `WebForm_DoPostBackWithOptions` patched to no-ops in `<head>` |

---

## 8. i18n Architecture

Three languages: **English (en)**, **Hindi (hi)**, **Marathi (mr)** — no external APIs.

- Inline `I18N = { en:{}, hi:{}, mr:{} }` — **115 keys each** (invariant: must stay balanced)
- Static HTML: `data-i18n="key"` (textContent) and `data-i18n-ph="key"` (placeholder)
- Dynamic JS: `t('key')` — falls back to EN
- Numbers: `toLocalNum()` / `toEnNum()` convert ASCII ↔ Devanagari digits
- Time: manual 12-hour formatting (`fmt()`, `fmtClock()`) — **never** `toLocaleTimeString()` as its output varies per device; AM/PM stays English in all languages
- Dates: `toLocaleDateString(langLocale())` for month/weekday names, wrapped in `toLocalNum(toEnNum(...))`

---

## 9. CSS Architecture

- All rules scoped under `.smx-wrap` (main) — prevents SharePoint host bleed
- CSS variables: `--tx`, `--tx2`, `--txm`, `--card`, `--bg-sub`, `--bdr`, `--orange`, `--red`, etc.
- Two themes: light (default) and dark — toggled via `data-theme` on `<html>`
- Mobile-first breakpoints: `≤480px`, `≤767px`, `≤360px`
- App-shell scroll fix: mobile `section.smx-shell` = `height:100dvh` + `overflow-y:auto` + `justify-content: safe center` — page never scrolls; content centers when it fits, scrolls internally otherwise
- SharePoint chrome suppressed via a `display:none !important` block at the top of CSS; uncertain wrappers hidden via `smxHideSpWrappers()` JS guard

---

## 10. Key UX Decisions

| Feature | Decision |
|---|---|
| GPS | `maximumAge:0` — always fresh, no cached position |
| Submit | Hold-to-confirm (ring animation) prevents accidental submission |
| Location input | Max 20 chars, whitelist only, 17px font, autocomplete chips |
| Button feedback | `:active` scale + brightness on all buttons; edit button turns orange |
| Shift history | Last 7 **punched** shifts (no date window) via DB RPC |
| Logo | Embedded SVG (`geometricPrecision`) — no external image required |
| Scroll lock | `html.smx-modal-open` + `overflow:hidden` when any modal is open |
| iOS URL-bar | `100dvh` on backdrops; app-shell `height:100dvh` |

---

## 11. SharePoint Deployment

1. Upload `index.html`, `styles.css`, `app.js` to `/Style Library/Geo-tagg/`
2. Add a **Script Editor Web Part** (or Page Viewer) on the SP page
3. In the web part, reference: `<script src="/Style%20Library/Geo-tagg/app.js"></script>` (or embed `index.html` via Page Viewer)
4. Run the Supabase SQL above
5. Ensure Supabase project is on a paid plan or that the free-tier keep-alive ping is sufficient

---

## 12. Local Development

```
Working dir : C:\TextApp\Attendance
Preview     : npx http-server . -c-1 (serves on port 8080, autoPort enabled)
Navigate to : http://localhost:8080/Style%20Library/Geo-tagg/index.html
```

> Do NOT use `preview_screenshot` — it times out. Use `preview_eval`, `preview_snapshot`, `preview_inspect`.
