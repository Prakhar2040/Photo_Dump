# digiKam setup (face detection)

digiKam finds the faces. Family Vault reads what digiKam found, matches the rest of the faces to the people you name, and saves the names next to each photo. Do this once on each laptop.

## 1. Install digiKam
1. Download it from https://www.digikam.org and install it.
2. Open it once. If it asks for a **collection** or **database** location, continue to step 2.

## 2. Add the photo folder
1. In digiKam open **Settings > Configure digiKam > Collections**.
2. Click **Add Collection** and choose your `Family Archive` folder.
   - Packaged build: `<Family Vault folder>\Family Archive`
   - From GitHub: the `Family Archive` folder next to `backend`
3. Click **OK**. digiKam scans the folder. Wait until it finishes (progress is at the bottom right).

## 3. Detect the faces
1. Open **Tools > Maintenance**.
2. Tick **Detect and recognize faces** (scan the whole collection).
3. Click **Start**. The first run downloads the face models. This can take a while for many photos; leave it running.

The models are saved in:
- Windows: `%LOCALAPPDATA%\digikam\facesengine`
- Linux: `~/.local/share/digikam/facesengine`

## 4. Name a few people
Family Vault needs a few confirmed faces for each person to match the rest.
1. In digiKam, open the **People** view.
2. For each person, type their name on a few clear faces and confirm them. About 5 to 10 faces each is a good start.
3. Or open Family Vault, go to the **Library**, and name people there.

Do not skip this step: with no confirmed names there is nothing to match against.

## 5. Check it in Family Vault
1. Start Family Vault.
2. Open the **Library** and look at **People**.
3. The app re-reads digiKam about every 30 seconds, so new names and faces appear on their own.

## After you import new photos
1. Let the photos reach `Family Archive` (the inbox does this for you).
2. Open digiKam. It scans for the new files.
3. Run **Tools > Maintenance > Detect and recognize faces** again for the new photos.

If **autoLaunchDigikam** is on and digiKam is installed on the same Windows laptop, the app opens digiKam for you after an import.

## If something is wrong
- **No faces in Family Vault:** make sure digiKam finished the scan and the face detection, and that you named at least a few people.
- **Photos don't show new names in digiKam:** in digiKam, select the photos and use **Item > Reread Metadata from File**.
- **Face models not found:** open digiKam, run the face detection once so it downloads them. Or point `MODELS_DIR` at a folder holding `face_detection_yunet_2023mar.onnx` and `face_recognition_sface_2021dec.onnx`.
- **digiKam's database is somewhere unusual:** set `DIGIKAM_DB` to the full path of `digikam4.db`.
- **digiKam is on another computer, or you are on Linux:** see `SETUP.md`.
