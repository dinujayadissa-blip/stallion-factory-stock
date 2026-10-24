# Stallion (Android app)

A thin Expo shell: a full-screen WebView of the Factory Stock site, with the Stallion icon and splash.
The address lives in one constant, `APP_URL` in `App.js` (`https://stallion-stock.pages.dev`).

- Android back button: goes back inside the site; exits from the first page.
- No signal: shows "Waiting for signal…" with a Retry button.
- Links that leave the Stallion site open in the phone's browser.
- Cookies and local storage are kept, so you stay logged in after closing the app.
- Photo pickers: the app declares the CAMERA and READ_MEDIA_IMAGES permissions so `<input type=file>` can offer the camera.

## 1. Install (once)

    cd mobile
    npm install

(`.npmrc` sets `legacy-peer-deps=true`. If you add a package, use `npm install <pkg> --legacy-peer-deps`, not `expo install`.)

## 2. Try it in Expo Go on your phone

Do this after the site is live at the address above.

    npx expo start --tunnel

Scan the QR code with Expo Go. (Tunnel is needed because the Windows Firewall blocks the local network.)
Check:
1. The login page shows.
2. Logging in works, and after fully closing and reopening the app you are still logged in.
3. Tapping a photo field offers the camera (and gallery); the photo uploads.
4. Back button goes back a page; on the first page it leaves the app.
5. Turn on airplane mode and reopen: "Waiting for signal…" and Retry; turn it off and tap Retry.

## 3. Build the installable APK

    npx eas-cli login          # your Expo account
    npx eas-cli build --profile preview --platform android

The first time, EAS asks to create the project and a signing key; say yes (the key is kept by Expo, not in this repo).
When it finishes you get a build link. Open it on the phone, download the APK and install it
(allow "install unknown apps" for your browser if Android asks).

## Notes

- Icon and splash come from `assets/` (copies of `public/assets/app/`): `icon.png`, `adaptive-icon.png` (maskable), `splash-icon.png`. Colours: Espresso #201e16, Olive #6c724b, Limestone #f1ebe1.
- Changing `APP_URL` needs a new build. Changes to the site itself do not: the app just shows the live site.
