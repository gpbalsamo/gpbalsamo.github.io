# AGU26 trip site — how to update

Live page: https://gpbalsamo.github.io/travels/AGU26/
This is a temporary site for Gianpaolo's week in San Francisco (AGU26, 5–13 Dec 2026).
Several Claude instances may update it. Follow these rules so edits don't collide.

## The page is code-protected
- Content lives encrypted in `data.enc.json` (AES-256-GCM, key from PBKDF2-SHA256 of the access code).
  `index.html` asks for the code and decrypts in the browser.
- The access code is **not** stored in this repo. Ask Gianpaolo for it if you don't have it.
- Never commit the plaintext `data.json` (it is git-ignored) and never write the code into any file.

## Where things live
- `data.enc.json` — **all content**, encrypted. Commit this.
- `data.json` — plaintext working copy, created by `crypt.py decrypt`; git-ignored.
- `crypt.py` — `decrypt` / `encrypt` between the two (needs Python `cryptography`).
- `index.html` — unlock screen + layout; it renders the decrypted data. Change it only for design/structure.

## Update workflow
1. `git pull --rebase origin main` before editing (another instance may have pushed).
2. `AGU26_CODE=<code> python3 crypt.py decrypt` → edit `data.json` only for the fields you are changing.
   Keep valid JSON (`python3 -m json.tool data.json > /dev/null`).
3. Set `meta.last_updated` (YYYY-MM-DD) and `meta.updated_by` (short note, e.g. "Claude — dinner added").
4. `AGU26_CODE=<code> python3 crypt.py encrypt`, then commit `data.enc.json` with a message prefixed
   `AGU26:` and `git pull --rebase origin main && git push origin main`.
5. Encrypted files can't be merged. On a conflict in `data.enc.json`: take theirs
   (`git checkout --theirs data.enc.json`), decrypt, re-apply your edit, re-encrypt, continue.

## Data conventions
- Dates: ISO `YYYY-MM-DD`. Times: local time where the event happens (PST in San Francisco).
- `days[].items[]`: `{ "time": "", "text": "", "highlight": true? }`.
- `todo[]`: set `"done": true` instead of deleting items.
- `accommodation.status`: "Booked" once a hotel is confirmed.
- `notes[]`: free-text strings; the section hides when empty.

## Still never add (a short numeric code is a light lock, not strong security)
Booking confirmation numbers or PINs, ticket numbers, payment or card details, home address,
passport/ESTA numbers, personal phone numbers, or login credentials (e.g. AGU Speaker Center).
Hotel name, address and the hotel's public phone number are fine.
