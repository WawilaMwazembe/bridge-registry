# Bridge Register: server deployment guide (for IT)

The Bridge Register is a small web application. Field staff use it on tablets, including offline, and it syncs to a central PostgreSQL database.

| Component | Technology | Notes |
|---|---|---|
| Database | PostgreSQL 16 | Single database `bridge_registry`, under 1 GB for the national inventory |
| API + web app | Node.js 20+ (Express) | One process, port 3000, serves both the API and the tablet app |
| Front end | Progressive Web App | Installed from the browser on Android or iPad; no app store |

## 1. What we need from IT

1. **A server or VM:** Windows Server 2019+ or Ubuntu 22.04+. 2 vCPU, 4 GB RAM and 40 GB disk is plenty.
2. **A DNS name**, e.g. `bridges.tanroads.go.tz`, reachable from the internet. Tablets sync from the field over mobile data.
3. **A TLS certificate** for that name. This is **mandatory**, because browsers allow offline mode (service workers) and GPS only over HTTPS.
4. **Firewall:** open inbound **443**, and port 80 if it redirects to 443. Do **not** expose 5432 (PostgreSQL) or 3000 (Node).
5. **Nightly database backups** (see section 5).

## 2. Architecture

```
Tablets ──HTTPS 443──► Reverse proxy (IIS / nginx / Caddy, holds the certificate)
                              │ http://127.0.0.1:3000
                              ▼
                        Node.js service ──► PostgreSQL (localhost:5432)
```

## 3. Installation: Windows Server

1. Install **PostgreSQL 16** (EDB installer) and **Node.js LTS**.
2. Copy the `bridge-registry` folder to e.g. `D:\Apps\bridge-registry`.
3. Create the database. This asks for the postgres password and an initial admin account, and writes `server\.env`:
   ```powershell
   powershell -ExecutionPolicy Bypass -File D:\Apps\bridge-registry\setup-db.ps1
   ```
   To **move the existing test database** instead, run the setup script first, then restore the data (see *Migrating from the pilot PC* below).
4. Install the Node packages:
   ```powershell
   cd D:\Apps\bridge-registry\server; npm ci --omit=dev
   ```
5. Run Node as a **Windows service** using [NSSM](https://nssm.cc):
   ```powershell
   nssm install BridgeRegister "C:\Program Files\nodejs\node.exe" "--env-file=D:\Apps\bridge-registry\server\.env" "D:\Apps\bridge-registry\server\server.js"
   nssm set BridgeRegister AppDirectory D:\Apps\bridge-registry\server
   nssm set BridgeRegister AppStdout D:\Apps\bridge-registry\logs\server.log
   nssm set BridgeRegister AppStderr D:\Apps\bridge-registry\logs\server.log
   nssm set BridgeRegister Start SERVICE_AUTO_START
   nssm start BridgeRegister
   ```
6. **IIS reverse proxy:** install the *URL Rewrite* and *Application Request Routing* modules, and enable the proxy in ARR (Server → ARR → Server Proxy Settings → Enable proxy). Create a site bound to 443 with the certificate. Add this `web.config`:
   ```xml
   <configuration>
     <system.webServer>
       <rewrite>
         <rules>
           <rule name="BridgeRegister" stopProcessing="true">
             <match url="(.*)" />
             <action type="Rewrite" url="http://127.0.0.1:3000/{R:1}" />
           </rule>
         </rules>
       </rewrite>
     </system.webServer>
   </configuration>
   ```

## 3b. Installation: Ubuntu (alternative)

```bash
sudo apt install postgresql nodejs npm caddy
# database: run db/01_schema.sql, 02_seed.sql, then create role bridge_api and run 03_grants.sql (see README)
sudo tee /etc/systemd/system/bridge-register.service <<'EOF'
[Unit]
Description=Bridge Register
After=postgresql.service
[Service]
WorkingDirectory=/opt/bridge-registry/server
ExecStart=/usr/bin/node --env-file=.env server.js
Restart=always
User=bridge
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now bridge-register
# /etc/caddy/Caddyfile - Caddy obtains and renews the certificate automatically:
#   bridges.tanroads.go.tz {
#       reverse_proxy 127.0.0.1:3000
#   }
sudo systemctl reload caddy
```

## 4. Migrating from the pilot PC

On the pilot PC:
```powershell
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -U postgres -Fc -d bridge_registry -f bridge_registry.dump
```
On the server, create an empty database and restore:
```powershell
psql -U postgres -c "CREATE DATABASE bridge_registry"
psql -U postgres -c "CREATE ROLE bridge_api LOGIN PASSWORD '<new strong password>'"
pg_restore -U postgres -d bridge_registry bridge_registry.dump
psql -U postgres -d bridge_registry -f db\03_grants.sql
```
Then put the new `bridge_api` password in `server\.env`.

## 5. Backups and monitoring

- **Nightly backup** (Task Scheduler / cron). Keep 30 days and copy them off the server:
  ```
  pg_dump -U postgres -Fc -d bridge_registry -f D:\Backups\bridge_registry_%DATE%.dump
  ```
- **Health check:** `GET https://bridges.tanroads.go.tz/api/ping` returns `{"ok":true}`.
- `bridge_history` keeps every version of every record, so accidental edits can be recovered without restoring a backup.

## 6. Security notes

- `bridge_api` (used by Node) has only the rights listed in `db/03_grants.sql`. It cannot drop tables or alter the schema.
- Passwords are stored as bcrypt hashes. Tablet sessions use random tokens, stored as SHA-256 hashes and valid for 60 days (`TOKEN_DAYS`). Disabling a user or resetting their password in the Admin screen signs them out on every tablet.
- Keep `server\.env` readable only by the service account.

## 7. Releasing updates

1. Replace the files in `app/` and `server/`.
2. **Increase the `CACHE` version in `app/sw.js`**, e.g. `v2` → `v3`. Otherwise tablets keep the old app.
3. Restart the service (`nssm restart BridgeRegister`). Tablets pick up the new version the next time they open the app online.
