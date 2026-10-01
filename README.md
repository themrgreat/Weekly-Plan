# Weekly Plan

A Zoho CRM widget for planning weekly School/Dealer visits across the next 4 Mondays (Mon–Sat).

## Features
- Per-day Schedule Status: **Active**, **Holiday**, **Leave**, **Team Working**.
- CRM business holidays are detected automatically and lock the matching day.
- Live School (Accounts) / Dealer (Vendors) lookup.
- **Team Working** days pick a single Team Member instead of Schools/Dealers (see *Team Member visibility*).
- One `Weekly_Planner` record is created per week; visits go into the `Plan_Details` subform.
- Duplicate protection: a week the user already planned is disabled unless every matching record has Status `Reject`.
- Admin-only "Schedule access" panel to open Current / Previous week for everyone.

## Team Member visibility
The Team Member dropdown never shows the signed-in user, and is scoped by the **Region** field on the CRM user:

| Signed-in user's Region | Users shown |
|---|---|
| `All` | every active user |
| a region (e.g. `South 1`) | active users in that same region (case-insensitive) |
| empty | only users listed in `temporaryVisibleUserIds` |

- Users with an empty Region, or Region `All`, are **not** shown to other regions.
- To make a specific user visible to everyone regardless of region (e.g. owner, CEO), add their user ID to the `temporaryVisibleUserIds` variable.
- Region values must match exactly across users (`North 2` and `North2` are different regions).

## CRM setup
**Users:** a custom field with API name `Region` on the CRM Users module.

**Variables** (Setup > Developer Space > Variables, group `General`):

| Variable | Type | Purpose |
|---|---|---|
| `isEnable` | Checkbox | Enable Current/Previous week access |
| `isCurrentWeek` | Checkbox | Show the current week |
| `isPreviousWeek` | Checkbox | Show the previous week |
| `temporaryVisibleUserIds` | Multi-line | User IDs shown to every user. Comma-separated, e.g. `1343779000000459001,1343779000001146001`. Empty = `{}` or blank |

The `zohocrm` connection must have the settings, users and variables scopes (`ZohoCRM.settings.ALL`, `ZohoCRM.users.READ`, `ZohoCRM.settings.variables.ALL`).

`Weekly_Planner` needs a `Status` picklist (includes `Draft` and `Reject`) and the `Plan_Details` subform fields: `Date`, `School_Name`, `Dealer_Name`, `Purpose`, `Transport_Medium`, `Schedule_Status`, `Team_Member`.

## Project layout
- `app/index.html`, `app/widget.js`, `app/widget.css` — the widget (all logic in `widget.js`).
- `server/index.js` — local HTTPS dev server.
- `dist/Weekly-Plan.zip` — build output (git-ignored).

## Run & deploy
```bash
npm install
npm start          # https://127.0.0.1:3000 (accept the self-signed cert once)
zet pack           # builds dist/Weekly-Plan.zip
```
Upload the zip in Zoho CRM > Setup > Developer Space > Widgets (Hosting: Zoho, Base URL `/index.html`).

## Debugging
Region/Team Member loading logs to the browser console with the `[Region]` prefix (current user's region, user count per region, and how many users were listed).
