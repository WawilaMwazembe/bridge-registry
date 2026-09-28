# Bridge Register: PostgreSQL + offline tablet app

Field staff register and check bridges on tablets, including where there is no network. Edits are kept on the tablet and sync to the central PostgreSQL database when a connection is available. The fields follow **List of Bridges - Format.xlsx**.

```
 Tablet (PWA, works offline)             Office server                    
 ┌──────────────────────────┐   HTTPS   ┌──────────────────┐   ┌────────────┐
 │ Form = Excel template    │ ────────► │ Node.js sync API │──►│ PostgreSQL │
 │ IndexedDB local copy     │ ◄──────── │ (server/)        │   │ (db/)      │
 │ GPS capture, validation  │  push/pull└──────────────────┘   └────────────┘
 └──────────────────────────┘
```

## Folder contents

| Path | Purpose |
|---|---|
| `db/01_schema.sql` | Tables, sync triggers, audit history, and report views |
| `db/02_seed.sql` | Lookup values plus the 13 sample bridges from the template |
| `db/03_grants.sql` | Limited permissions for the API's database login |
| `db/04_current_data.sql` | Snapshot of the current bridges and dropdown values (no user accounts) |
| `db/export_data.sql` | Regenerates `04_current_data.sql` from the live database |
| `db/import_from_excel.sql` | Bulk import of the full bridge list from Excel (saved as CSV) |
| `server/` | Sync API; it also serves the web pages |
| `app/index.html` | TANROADS home page, shown after sign-in |
| `app/app.html` | Sign-in page and bridge register (installable web app, works offline) |
| `docs/` | Entity relationship diagram (draw.io + PNG) |
| `setup-db.ps1` | One-time database setup (creates the database, API login and admin user) |
| `backup-db.ps1` | Full private backup to `backups/` (not for GitHub) |
| `start-server.bat` | Starts the server on this PC |

Page flow: **Sign in → home page → "Open the register" → bridge list.** Visitors who aren't signed in are sent to the sign-in page.

## 1. Install (server / office PC)

1. **PostgreSQL 16+**: https://www.postgresql.org/download/windows/ (tick *Command Line Tools*)
2. **Node.js 20 LTS+**: https://nodejs.org

## 2. Create the database

**Easiest (Windows):** run `setup-db.ps1`. It asks for the postgres password and an admin account, creates everything, and writes `server/.env`. Then, to load the current bridge data:

```bash
psql -U postgres -d bridge_registry -f db/04_current_data.sql
```

**Manual:**

```bash
psql -U postgres -c "CREATE DATABASE bridge_registry"
psql -U postgres -d bridge_registry -f db/01_schema.sql
psql -U postgres -d bridge_registry -f db/02_seed.sql
psql -U postgres -d bridge_registry -c "CREATE ROLE bridge_api LOGIN PASSWORD 'choose-a-strong-password'"
psql -U postgres -d bridge_registry -f db/03_grants.sql
```

Create user accounts. Roles: `viewer` (read only), `inspector` (add/edit), `admin` (also verify/delete). The last argument limits a user to one region (`NULL` means all regions).

```sql
SELECT create_user('admin',  'System Administrator', 'TempPass#1', 'admin',     NULL);
SELECT create_user('jmushi', 'J. Mushi',             'TempPass#2', 'inspector', '12');  -- Morogoro only
```

## 3. Load the existing bridge list (optional)

1. Open the Excel file, then choose **File → Save As → CSV UTF-8** and name it `bridges.csv`.
2. From the folder that contains `bridges.csv`:
   ```bash
   psql -U postgres -d bridge_registry -f path/to/db/import_from_excel.sql
   ```
   The script skips header and legend rows. It also cleans spacing and capitalisation (for example "fair" becomes "Fair"), adds missing roads and lookup values, and lists duplicate bridge numbers. You can run it again safely.
   CSV does not keep cell colours, so set **Record status** (Closed/Demolished, Duplicate, New) for the highlighted bridges afterwards.

## 4. Run the server

```bash
cd server
copy .env.example .env      # then edit the password
npm install
npm start
```

Open http://localhost:3000 in a browser to test.

## 5. Put it on tablets

Tablets need **HTTPS**. Browsers allow offline mode and GPS only on secure sites. Choose one:
- Put the server behind a reverse proxy with a certificate, such as **Caddy** (automatic HTTPS), IIS or nginx, on a domain like `bridges.tanroads.go.tz`, **or**
- Host it on an internal server your IT team already runs with a certificate.

On each tablet:
1. Open the HTTPS address in **Chrome** (Android) or **Safari** (iPad).
2. Menu → **Install app** / **Add to Home Screen**.
3. **Sign in once while online.** This downloads the bridge list and dropdown values.
4. From then on, the app opens and works with no connection.

## How field staff use it

- **Check a bridge:** search or filter the list, tap the bridge, correct the fields, then press **Save**.
- **Register a new bridge:** press **+ New bridge**, press **📍 Use tablet GPS** at the site, fill in the template fields, then press **Save** (or **Save & add next on this road**).
- **Sync:** runs automatically when a connection returns and every 5 minutes; you can also press **Sync now**. The top bar shows how many changes are still unsynced.
- **Filters:** *Not synced*, *Needs attention* (conflicts or rejected records), *Not verified*, *Missing GPS*.
- **Conflicts:** if two people change the same bridge, the second tablet sees both versions side by side and chooses which to keep. Nothing is overwritten silently.
- **Verification (admin):** **Mark as verified** approves a record. Any later edit clears verification so the bridge is checked again.
- **Export CSV:** downloads the current list in the template's column order. Closed and duplicate bridges are left out, as the legend requires.

## How sync works (technical)

- Every bridge has a **UUID** created on the tablet, so records made offline on different tablets never clash.
- Each change on the server gets the next number from `sync_seq` (stored in `server_seq`). A tablet asks for "everything after N", which makes pulls incremental. Writes are serialised with an advisory lock, so no change can be skipped.
- Each row has a `version`. A push includes the version the tablet started from. If the server has moved on, the push is returned as a **conflict** and is not applied.
- Deletes are soft (`is_deleted`) so that they sync to tablets. Hard `DELETE` is blocked.
- `bridge_history` stores a full copy of every version: who changed it, when, and from which device.

## Useful queries

```sql
SELECT * FROM v_bridge_summary;             -- Trunk / Regional / Total per region (like the template legend)
SELECT * FROM v_bridge_list;                -- the list in template column order
SELECT changed_at, u.full_name, row_data->>'overall_condition'
FROM bridge_history h LEFT JOIN app_user u ON u.id = h.changed_by
WHERE bridge_id = (SELECT id FROM bridge WHERE bridge_no = '12-0001') ORDER BY version;

-- Admin tasks
INSERT INTO road VALUES ('R123', 'New Regional Road', 'Regional');
INSERT INTO region VALUES ('13', 'PWANI');                      -- confirm the correct region code
UPDATE structure_type SET name = 'Half-Through Truss bridge' WHERE name = 'Half Throug Truss bridge';  -- cascades to bridges
SELECT set_password('jmushi', 'NewPass#3');
UPDATE app_user SET active = false WHERE username = 'jmushi';  -- disables the account on all tablets
```
