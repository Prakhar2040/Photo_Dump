# Family Vault API

Run: `npm install && npm start` → http://127.0.0.1:4000 (localhost only).
Env: `ARCHIVE_ROOT` (default `C:\Users\Prakhar\Code\Photo_Dump\Family Archive`), `PORT`, `ALLOWED_ORIGINS` (comma list, add your Lovable URL), `API_KEY` (optional; send `x-api-key` header, or `?key=` for `<img>` URLs).

Long operations return a job (`202`). Poll `GET /api/jobs/:id` → `{status: running|done|error, progress:{done,total,message}, result, error}`.

| Tab | Endpoint | Notes |
|---|---|---|
| – | `GET /api/health` | |
| Dashboard | `GET /api/dashboard` | counts, sizes, drive capacity, last import/backup, duplicate summary |
| Settings | `GET/PUT /api/settings` | archiveRoot, similarityDefault, people, eventFolderPattern, backupTargets[] |
| Pickers | `GET /api/fs/browse?path=` | directories only; empty path lists drives |
| Import | `POST /api/import/preview` `{sourcePath}` | counts + sample |
| Import | `POST /api/import` `{sourcePath, person, quarter:"2026-Q4"}` | job; copies to `Imports/<quarter>/<person>`, never touches source |
| Clean Up | `POST /api/duplicates/scan` `{mode:"exact"\|"similar", similarity:70-100, scope:"imports"\|"archive"}` | job; result = summary |
| Clean Up | `GET /api/duplicates/summary` | `{groups, photos, reclaimableBytes}` |
| Clean Up | `GET /api/duplicates/groups?status=pending&offset&limit` | each group has `files[]` (id,name,width,height,size,modifiedAt,folder) and `suggestedKeepId` |
| Clean Up | `POST /api/duplicates/groups/:id/resolve` `{keepId}` | keeps that file, moves the rest to the Review Bin. `keepId:"all"` keeps everything |
| Clean Up | `POST /api/duplicates/groups/:id/skip` | |
| Review Bin | `GET /api/bin`, `POST /api/bin/:binId/restore`, `DELETE /api/bin?confirm=yes` | last one is permanent |
| Library | `GET /api/library/folders` | tree with counts |
| Library | `GET /api/library/photos?folder&q&person&year&type&page&limit` | |
| Library | `POST /api/library/folders` `{path}`, `POST /api/library/move` `{ids[], destFolder}` | |
| Images | `GET /api/files/:id/thumb?w=400`, `GET /api/files/:id/raw` | |
| Backup | `GET /api/backup/targets` | connected?, file counts, last sync/verify |
| Backup | `POST /api/backup/sync` `{targetId, dryRun}` | `dryRun` defaults to **true** (returns plan). `dryRun:false` starts the job |
| Backup | `POST /api/backup/verify` `{targetId}` | job; SHA-256 compare of every file |

Backup modes: `update` copies new/changed files and never removes anything; `mirror` also moves files missing from the archive into `<target>/.sync-trash/<timestamp>/` (not deleted).
