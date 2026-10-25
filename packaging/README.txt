FAMILY VAULT - SETUP GUIDE
==========================

What you need
-------------
- A Windows 10/11 (64-bit) laptop.
- digiKam (free, digikam.org). It is the part that finds faces.
- Nothing else. No internet, account or Docker.

Step 1 - Unzip
--------------
Right-click FamilyVault.zip > Extract All. Put the folder somewhere permanent, for example
C:\FamilyVault or Documents. Do not run it from inside the zip.

Step 2 - Start it
-----------------
Double-click "Start Family Vault.bat". A black window opens and your browser goes to
http://localhost:8080. Keep the black window open while you use the app; close it to stop.
If Windows says "Windows protected your PC", click More info > Run anyway.

Step 3 - Set up digiKam (once)
------------------------------
1. Install digiKam and open it once.
2. Add the collection folder:  <your Family Vault folder>\Family Archive
   (or the archive folder you chose in the app under Import & Backup > Back up your archive).
3. Let digiKam scan, then run its face detection.
   Names you give in the app's Library are saved next to each photo, so they survive moving the folder.

Step 4 - Send photos from a phone (Android or iPhone)
-----------------------------------------------------
1. On the laptop, open Import & Backup and switch on phone upload. A QR code appears.
   The first time, Windows asks to allow Node.js on the network: choose "Private networks".
2. Put the phone on the SAME Wi-Fi as the laptop.
3. Scan the QR code with the phone camera and open the link.
4. Tap "Choose photos & videos". On Android, if you do not see all your photos, use the
   "Browse..." / Files option and pick the Camera folder rather than the Photo Picker; that also
   keeps location data.
5. Select all and tap Upload. Keep the page open and the screen on until it says Done.
   Anything sent before is skipped automatically, so you can safely pick everything every time.

Photos keep their real date (taken from the photo itself, not the day you upload). They are saved in
Family Archive\Imports\<year>-Q<quarter>.
Switch phone upload off when you are finished.

Where things are
----------------
Family Archive\   your photos and videos (the master copy)
data\             the app's notes: names, covers, upload history, settings
logs\             api.log and web.log, if something goes wrong

Backups
-------
Use Import & Backup > Back up your archive regularly, or just copy the whole "Family Archive" folder.
Moving to a bigger drive: copy the folder there, then change "Archive folder" in the app.

Problems
--------
- "Port is in use": Family Vault is probably already running. Close all its windows and start again.
- Phone cannot open the link: check it is on the same Wi-Fi (not guest Wi-Fi), phone upload is switched on,
  and Windows allowed Node.js on Private networks.
- A photo shows the wrong date: it had no date inside it. Rename or fix the date in digiKam.
