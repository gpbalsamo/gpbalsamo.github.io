# AGU26 trip site — how to update

Live page: https://gpbalsamo.github.io/travels/AGU26/
This is a temporary site for Gianpaolo's week in San Francisco (AGU26, 5–13 Dec 2026).
Several Claude instances may update it. Follow these rules so edits don't collide.

## Where things live
- `data.json` — **all content**. Edit this for almost every update.
- `index.html` — layout only; it renders `data.json`. Change it only for design/structure changes.

## Update workflow
1. `git pull --rebase origin main` before editing (another instance may have pushed).
2. Edit `data.json` only for the fields you are changing. Keep valid JSON
   (check with `python3 -m json.tool data.json > /dev/null`).
3. Set `meta.last_updated` (YYYY-MM-DD) and `meta.updated_by` (short note, e.g. "Claude — hotel added").
4. Commit with a short message prefixed `AGU26:` (e.g. `AGU26: add hotel booking`), then
   `git pull --rebase origin main && git push origin main`.
5. On a rebase conflict in `data.json`, keep both sides' changes, re-validate, continue.

## Data conventions
- Dates: ISO `YYYY-MM-DD`. Times: local time where the event happens (PST in San Francisco).
- `days[].items[]`: `{ "time": "", "text": "", "highlight": true? }`.
- `todo[]`: set `"done": true` instead of deleting items.
- `accommodation.status`: change from "Not booked yet" to "Booked" once a hotel is confirmed.
- `notes[]`: free-text strings; the section hides when empty.

## This page is public — never add
Booking references, ticket numbers, seat numbers, payment or card details, home address,
passport/ESTA numbers, phone numbers, or login credentials (e.g. AGU Speaker Center).
Hotel name and area are fine; room/confirmation numbers are not.
