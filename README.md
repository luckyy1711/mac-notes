# Mac Notes

A lightweight macOS-dark notes app built with vanilla HTML, CSS, and JavaScript. Public notes are locally cached and can be synced securely to Supabase; Private Vault notes are AES-encrypted in the browser before they leave the device.

## Run locally

```bash
cd mac-notes
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Supabase setup

1. Create a Supabase project, then open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql). It creates the `notes` table, index, enables RLS, and adds owner-only select/insert/update/delete policies, and enables `notes` in the Realtime publication.
2. In **Authentication → Providers**, enable Email. For password sign-up, configure the site URL and any deployed redirect URLs in **Authentication → URL Configuration**. Email confirmation is recommended for production; when it is enabled, new users must confirm their email before first sign-in.
3. Copy `supabase-config.example.js` to `supabase-config.js`. Set `url` to Project URL and `anonKey` to the dashboard's anon/publishable key. These are safe public browser values; **never** use the `service_role` key in this app. `supabase-config.js` is ignored by Git.
4. Deploy the static files (`index.html`, `styles.css`, `app.js`, and the created `supabase-config.js`) to GitHub Pages, Netlify, or another static host. Add that deployment URL to Supabase Auth redirect URLs.

## Sync and security behavior

- Once signed in, Supabase is the cloud source of truth for public notes. The app loads cloud notes, writes changes to a small local pending queue, retries them when the browser comes back online, and listens for Supabase Realtime changes.
- On the first sign-in on a device with existing notes, the app offers migration. It upserts the local notes then verifies every uploaded ID before marking migration complete. The existing local encrypted vault cache is intentionally retained as an offline copy.
- Vault notes are encrypted as complete note objects with the existing client-side CryptoJS AES passcode before being sent to `encrypted_payload`. Their title, content, category, tags, and pinned metadata are not uploaded in plaintext. Passcodes and keys are never sent to Supabase.
- A vault passcode is device-local. On another device, unlock the vault with the same passcode after signing in; the app verifies it by decrypting the encrypted vault payload.
- If the app detects that a pending local edit is older than the matching cloud edit, it keeps the newer cloud version rather than silently overwriting it and reports a sync conflict. This is last-writer-safe rather than a line-by-line merge.

## Two-device smoke test

1. Open the deployed site on a laptop, create an account, sign in, and accept migration if prompted.
2. Create a public note and wait for **Synced**. Verify its row in **Table Editor → notes**.
3. Open the same deployed URL on a phone, sign in with the same account, and confirm the note appears. Edit it and confirm it updates on the laptop (Realtime) or after the laptop reconnects/reloads.
4. Delete a test note on either device and verify it disappears on the other.
5. Turn one device offline, edit a note, confirm **Offline**, then reconnect and wait for **Synced**.
6. For vault coverage, create/unlock the same vault passcode on both devices. Confirm database vault rows have `is_vault = true` and only `encrypted_payload` contains vault data.
