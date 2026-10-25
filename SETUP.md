# Family Vault – setup on a new laptop

Family Vault is a local photo archive: a Node API (port 4000), a web app (port 8080) and a phone-upload page (port 4001, only while switched on). Nothing leaves your network. Face finding is done by digiKam.

## Option A – the packaged build (easiest, no Node needed)

1. Get `FamilyVault.zip` (built by `node packaging/package.mjs`; it is not stored in git) and extract it somewhere permanent.
2. Install [digiKam](https://www.digikam.org), open it once.
3. Double-click **Start Family Vault.bat**. The browser opens at http://localhost:8080.
4. In digiKam, add the collection folder `<FamilyVault folder>\Family Archive`, scan, then run face detection.
5. Copy your existing photos into `Family Archive` (or change **Archive folder** in the app).

All paths are relative to the folder, so it can be moved or copied freely.

## Option B – from this repository (development)

Needs Node 20+ and Git.

```
git clone https://github.com/Prakhar2040/Photo_Dump.git
cd Photo_Dump
cd backend  && npm install && cd ..
cd frontend && npm install && cd ..
start.bat
```

- Photos go in `Family Archive/` next to `backend/` (created on first use), or set `ARCHIVE_ROOT`.
- App data (names, settings, upload history) is created in `backend/data/` on first run. It is git-ignored; copy that folder across if you want to keep names and settings.
- Face models: open digiKam once and run face detection so its models exist in `%LOCALAPPDATA%\digikam\facesengine` (needed only to build the package).

## Sending photos from a phone (Android or iPhone)

1. In the app open **Import & Backup** and switch on phone upload. Allow Node.js on **Private networks** if Windows asks.
2. Phone on the same Wi-Fi (not guest Wi-Fi). Scan the QR code, open the link.
3. Tap **Choose photos & videos**, select all, **Upload**. Keep the page open and the screen on.
4. On Android, if some photos are missing, choose *Browse/Files* and pick the Camera folder instead of the Photo Picker; this also keeps location data.

Files already sent are skipped. Each file keeps its real capture date (EXIF, video metadata, or a date in the file name) and lands in `Family Archive/Imports/<year>-Q<n>/`.

## Back up

Copy the whole `Family Archive` folder, or use **Import & Backup > Back up your archive**. Also keep `data/` (packaged build) or `backend/data/` (dev) to preserve names and settings.

## Troubleshooting

- **Port in use**: it is already running; close the old windows.
- **Phone can't open the link**: same Wi-Fi, upload switched on, Node.js allowed on Private networks.
- **Wrong date on a photo**: it has no date inside it; fix it in digiKam.

## Linux

Works with Node 20+. There is no `start.bat`; start the two parts yourself:

```
cd backend  && npm install && npm start      # API on :4000
cd frontend && npm install && npx vite dev   # web app on :8080
```

- Install digiKam from your package manager (`digikam` must be on the PATH, or set `DIGIKAM_EXE` to its full path). The app then detects it, can open it after an import, and reads its settings from `~/.config/digikamrc` and its face models from `~/.local/share/digikam`.
- If digiKam keeps its database somewhere unusual, set `DIGIKAM_DB` to the full path of `digikam4.db`. Models can also be pointed to with `MODELS_DIR`.
- The Flatpak/Snap versions of digiKam are not detected; use the native package or set `DIGIKAM_EXE`.
- On Linux digiKam opens in a normal window (it cannot be started minimized).

## App on Linux, digiKam on a Windows PC

The two only share files, so this works without any code link:

1. Share `Family Archive` from the Linux machine (Samba) and add that share as a collection in digiKam on Windows.
2. In the app, turn off **autoLaunchDigikam** (digiKam is not on the same computer, so it is simply skipped anyway). After an import, open digiKam on the Windows PC and let it re-scan, then run face detection.
3. Names you give in the app are written to the `.xmp` sidecars next to the photos, so digiKam sees them through the share (Item > Reread Metadata from File).
4. To also use the faces digiKam found, make its database reachable from Linux (share or copy `digikam4.db`, ideally while digiKam is closed) and set:
   - `DIGIKAM_DB` = path to that `digikam4.db`
   - `DIGIKAM_ALBUM_ROOT` = (optional) the end of the collection's path as digiKam stores it, e.g. `Family Archive`. If unset, the app matches the same path, then the same folder name, then the only collection.
5. Without a database file the app works normally; it just has no digiKam faces to read.
6. Put the two face models on the Linux machine and set `MODELS_DIR` to their folder.
