# The phone app on this PC

How to work on the phone app (`apps/mobile`, decisions D50–D56) on Windows: the Android tools, the emulator, running the app against the API in development, the end-to-end flows, and push notifications. There's no Mac here, so the iPhone build is CI's job (section 6).

## 1. Tools

You don't need Android Studio, only its command-line tools.

1. **JDK 17**, for example Microsoft's build of OpenJDK. Point `JAVA_HOME` at it.
2. **The Android SDK command-line tools**, unpacked as `cmdline-tools/latest` inside the SDK folder (for example `%LOCALAPPDATA%\Android\Sdk`). Point `ANDROID_HOME` at the SDK folder, and put its `cmdline-tools\latest\bin`, `platform-tools` and `emulator` folders on your `PATH`. Then install the rest:

   ```bash
   sdkmanager "platform-tools" "emulator" "platforms;android-36" "build-tools;36.0.0" "cmake;3.31.6" "system-images;android-36;google_apis;x86_64"
   ```

   Gradle installs the NDK it needs on the first build.

   CMake 3.31.6 rather than the SDK's usual 3.22.1: the older one's ninja can't handle the long paths of pnpm's `node_modules` on Windows. The app's config plugin (`plugins/cmake-version.js`) asks every native module for it.
3. **An emulator** with Google APIs (push needs them, from P3):

   ```bash
   avdmanager create avd -n superagent -k "system-images;android-36;google_apis;x86_64" -d pixel_8
   ```

   Then give it 4 GB: set `hw.ramSize=4G` in `%USERPROFILE%\.android\avd\superagent.avd\config.ini`. With the default 2 GB, a development build swaps, and the app stops responding under the flows.

   It runs on the Windows hypervisor (WHPX), which Docker Desktop already uses.
4. **Maestro**, for the flows, from its [GitHub releases](https://github.com/mobile-dev-inc/maestro/releases) (CI uses 2.11.0). It runs on the same JDK.

## 2. Run the app

1. Start the API and the web app as usual: `pnpm db:up`, `pnpm dev`, `pnpm dev:web`.
2. Start the emulator: `emulator -avd superagent`.
3. Build the app, install it on the emulator and start Metro: `pnpm mobile:android`. The first build takes a while. It's a debug build, its JavaScript served by Metro, so after that `pnpm dev:mobile` (Metro alone) is enough until a native dependency or `app.config.ts` changes.

On the emulator, `10.0.2.2` is this PC. Development builds (and test builds, section 3) may use plain HTTP to it and to `localhost`; release builds for a phone use HTTPS only.

**Pair it.** In the web app, open Settings, Devices, and choose Pair a phone. The emulator has no camera to scan the code, so open its link instead, with the server swapped for `10.0.2.2` (the link names the web app's address, which is the emulator itself from the emulator's side):

```bash
adb shell am start -a android.intent.action.VIEW -d "superagent://pair?server=http%3A%2F%2F10.0.2.2%3A5173&code=sa_pair_…"
```

The app names the server and waits for you to confirm.

**Or sign in with a token:** choose "Use a server address and a token", enter `http://10.0.2.2:4111` and an admin token. The app swaps it for a token of its own and doesn't keep the admin token.

`adb reverse tcp:5173 tcp:5173` would let the link work unchanged, as `localhost`. It's fine for a quick look, but adb can drop its forwards when the emulator's connection resets under heavy traffic, so the flows don't rely on it.

## 3. The end-to-end flows

The [Maestro](https://maestro.dev) flows in `apps/mobile/e2e` drive a release build made for testing, as CI does: its JavaScript is built in, and it may reach this PC over plain HTTP.

1. Build it and install it on the running emulator:

   ```bash
   cd apps/mobile
   pnpm exec expo prebuild --platform android
   cd android
   APP_VARIANT=test NODE_ENV=production ./gradlew assembleRelease -PreactNativeArchitectures=x86_64
   adb install -r app/build/outputs/apk/release/app-release.apk
   ```

   Prebuild again after changing `app.config.ts` or a config plugin.
2. With the API running, run the flows from the repository's root (in Git Bash). Maestro hands its `MAESTRO_*` environment variables to the flows, so the admin token is read from `.env` and never appears on a command line:

   ```bash
   MAESTRO_API_URL=http://127.0.0.1:4111 MAESTRO_APP_SERVER=http://10.0.2.2:4111 MAESTRO_ADMIN_TOKEN="$(sed -n 's/^SUPERAGENT_ADMIN_TOKEN=//p' .env)" pnpm test:mobile
   ```

   - `MAESTRO_API_URL` is the API as this PC reaches it. The flows' setup script (`e2e/setup.js`) uses it to make a pairing code for each flow.
   - `MAESTRO_APP_SERVER` is the API as the app reaches it.
   - `MAESTRO_MODEL_URL`, for `chief.yaml`: the tests' fake model, which `setup.js` then makes the server's default and fast models. Start it with `pnpm --filter @superagent/api exec tsx test/support/fake-openai-server.ts 4199` and set `http://127.0.0.1:4199/v1`. Against your development server this replaces your model settings, so set them back in the web app afterwards, or use a throwaway API.

**What they leave behind:** a department called Phone check, without a lead, with a task in its inbox, plus a task for each run of `new-task.yaml`, and a device token for each flow. Against your development database, delete them in the web app afterwards, or point the flows at a throwaway API.

**When a flow fails,** Maestro keeps its screenshots and logs in `%USERPROFILE%\.maestro\tests`.

The flows: `board.yaml` (home, the board, a task), `inbox.yaml` (what needs you, answered from the Inbox tab), `new-task.yaml`, `sign-out.yaml`, `chief.yaml` (a conversation with the chief, on the fake model), and `sign-in.yaml`, which needs no server.

## 4. Push notifications

The API sends notifications itself, through Firebase Cloud Messaging (D54). FCM is free, and needs a Firebase project of your own: the app needs its Android config, and the API its service account. Google only ever sees ciphertext: each phone makes a key when you turn notifications on, and the API encrypts every notification with it.

1. **Create the project** at [console.firebase.google.com](https://console.firebase.google.com) (the free plan; Google Analytics isn't needed). New projects have the Cloud Messaging API (V1) on already.
2. **Add an Android app** to it, with the package name `dev.superagent.app`, and download its `google-services.json`. Keep it outside the repository (for example in `%USERPROFILE%\.superagent\`). It isn't a secret, but it names your project, and the repository is public.
3. **Build the app with it.** `GOOGLE_SERVICES_JSON` gives the build its path; set it for the prebuild, then build as in section 3:

   ```bash
   cd apps/mobile
   GOOGLE_SERVICES_JSON="$USERPROFILE/.superagent/google-services.json" APP_VARIANT=test pnpm exec expo prebuild --platform android --clean
   ```

   A build without it works, and says in its settings that it can't get notifications.
4. **Give the API the service account.** In the Firebase console, open Project settings, Service accounts, and generate a new private key: a JSON file. In the web app, open Settings, Notifications, give the admin token, and choose that file. The API checks it with Google and keeps it sealed, like provider keys; delete the downloaded file afterwards. Stop notifications there to forget it.
5. **Turn them on, on the phone:** Settings, Notifications, Get notifications. Android asks for the permission. Pick the kinds, and send a test.

**What a notification does.** Each kind has its own channel, which Android's settings can tune or silence. Approve, Decline, Answer, Accept and Reply work from the notification without opening the app, once the phone is unlocked. On a lock screen that hides private notifications (Android's setting), a notification shows only its kind. A tap opens its task, or the chief. With the app open, it shows as a banner inside the app instead.

**When one doesn't arrive:** the web app's Notifications page lists each phone with the last error FCM gave. A phone FCM no longer knows (the app was uninstalled) is dropped, as is one whose device token is revoked. Android can hold notifications back in battery saver and Doze. On the emulator, it must be a Google APIs image (the one in section 1 is).

## 5. Jest

`pnpm --filter @superagent/mobile test` runs the app's unit and component tests: whole screens rendered through Expo Router, with MSW answering the network. They're part of `pnpm check`.

`pnpm --filter @superagent/mobile tokens` regenerates `src/ui/tokens.ts` from the web app's `theme.css`. A test fails when they disagree.

## 6. The iPhone

CI builds the app for the iOS simulator on a macOS runner, which needs no Apple account, and runs `sign-in.yaml` on it. Docker doesn't run on those runners, so there's no server there for the other flows to reach.

Running it on an iPhone, and push there, wait for an iPhone and Apple's developer program.
