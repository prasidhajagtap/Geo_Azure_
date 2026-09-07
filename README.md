# GeoLocation Attendance

Mobile-first web attendance app for SharePoint Online. Employees clock in and
out with a GPS-captured location name; records are written to Supabase.

No build step. The three files are deployed as-is.

## Repository layout

```
Style Library/Geo-tagg/     <- copy this folder into SharePoint as-is
├── index.html              markup + SharePoint postback disabler
├── styles.css              all CSS, scoped under .smx-wrap
└── app.js                  state, i18n, Supabase client, validators, render
docs/
├── PROJECT.md              full project documentation
└── CONDITIONS.md           environment, security and input constraints
```

The folder name matches the SharePoint target path, so deployment is a direct
copy into `/Style Library/Geo-tagg/`. `index.html` references the CSS and JS by
absolute path (`/Style%20Library/Geo-tagg/...`), which is why the folder name
must be kept exactly as-is.

## Deploy

1. Upload `Style Library/Geo-tagg/` to the same path in SharePoint.
2. Add a Script Editor or Page Viewer Web Part pointing at `index.html`.
3. Run the SQL in `docs/PROJECT.md` section 6 (RLS policy + `recent_shifts` RPC).

Requires HTTPS — `navigator.geolocation` is blocked on plain HTTP.

## Local preview

```
npx http-server . -c-1 -p 8080
# http://localhost:8080/Style%20Library/Geo-tagg/index.html
```

Serve from the repository root so the absolute asset paths resolve.
Geolocation works on `localhost` because it counts as a secure context.

Identity comes from SharePoint hidden fields, which do not exist locally, so
after about six seconds the app falls back to the manual name + Poornata ID
form. That fallback is the expected local behaviour, not a failure.
