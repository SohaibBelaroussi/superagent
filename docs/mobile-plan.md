# Superagent mobile app: development plan

**Status:** planned 2026-10-09; P1 and P2 done the same day. Builds on the API of [api-plan.md](api-plan.md) (M0–M9 merged) and sits beside the web app of [web-plan.md](web-plan.md) (W1–W6 merged).

**Progress:**
- P1 (foundation, sign-in and the board): done. Verified on the emulator against the API in development:
  - the app paired from the web app's Devices page;
  - a task created in the web app appeared on the board without a refresh;
  - approving its waiting call let the lead finish, and accepting closed it;
  - both themes.

  The Maestro flows pass on the emulator against a release build made for testing, as they do in CI. Found along the way:
  - Android draws edge to edge from Android 15, so the system no longer makes room for the keyboard, and the forms' buttons sat behind it. Screens with fields now sit in `AvoidKeyboard`, which measures where it is on screen. React Native's KeyboardAvoidingView measures from its parent, so it fell short under a header.
  - A development build needs a 4 GB emulator: at 2 GB it swapped, and the app stopped responding under the flows.
  - `adb reverse` lost its forwards whenever the emulator's adb connection reset under load, so the flows reach this PC at `10.0.2.2`.
  - Hermes has no `crypto`: `src/boot.ts` installs expo-crypto's before anything needs it.
  - CMake 3.22's ninja can't handle pnpm's long paths on Windows: a config plugin asks every native module for CMake 3.31.6.
  - The query cache's timers kept Jest running for minutes after the tests: the test setup lets them go.
- P2 (conversations): done. The conversation reducer, its reconciliation with the history, the stream, your pending messages and the words for tools and reports moved to `packages/client`, and the web app uses them as before. On the emulator, against the API driven by a scripted model:
  - the chief's answer streamed in and gave way to the stored answer, shown once;
  - a task's transcript stayed whole while a call waited for approval, and the rest of the turn streamed in after approving it;
  - Home's quick ask opened the conversation with the message sent.

  A message sent while the chief answers waits its turn: the Jest tests check the phone shows it so, and the API's integration tests the queue; the demo model answers the chief too fast to catch it on the emulator. `chief.yaml` runs a conversation in CI, on the tests' fake model. Found along the way:
  - React Native's `maintainVisibleContentPosition` re-anchors on every change, so a turn replaced by its stored copy pulled the view away from the newest message. The chief's screen keeps its place by hand instead, only when older messages load, and only your own scrolling lets go of the end.
  - An empty text block between two tool calls took room: empty parts aren't drawn.

**Related docs:**
- [decisions.md](decisions.md): D50–D56 cover the mobile app. It follows the web app's D45–D48 (sign-in, live updates, conversations, notifications) where a phone allows.
- [web-plan.md](web-plan.md): the design and the data layer the app shares.
- [runbooks/server.md](runbooks/server.md): how the server is reached (`tailscale serve`).

## 1. Goal and scope

A native app for Android and iOS, from one Expo codebase, to run the organization from your phone: what needs you, decided from the notification; the chief; the board and your tasks; a task's files, and its browser when an agent needs a code typed.

The web app already works in a phone's browser. The app is for what a page can't do well there:
- notifications with the app closed, with Approve and Decline on the notification (a phone's browser refuses notifications from a page, D48);
- a native feel: tabs, sheets, gestures, haptics, and a chat that knows where the keyboard is;
- sharing from other apps into superagent;
- a token kept in the phone's keystore, behind an optional app lock.

**Platforms.** You have no iPhone or Mac for now, so Android comes first, verified on the Android emulator on this PC.
- iOS stays in the code from the first day.
- CI builds it for the iOS simulator on GitHub's macOS runners, which are free for public repositories and need no Apple account. That way iOS can't quietly break.
- Running on an iPhone, and push there, wait for an iPhone and Apple's developer program (99 USD a year). Free Apple accounts can't use push at all.

**What it covers, milestone by milestone:**
- sign-in by pairing, the board and tasks, live (P1);
- conversations with the chief, and task transcripts (P2);
- the inbox, and push notifications with actions (P3);
- work from anywhere: sharing into the app, a task's files, its live browser (P4);
- an app lock, offline reading, and a release build for a real phone (P5).

**Not in scope:**
- Managing the organization (departments, agents, schedules, knowledge), settings, plugins, MCP servers and usage beyond a task's cost. The web app does these, and the app's settings link to it.
- The Play Store and the App Store: the app is installed from its own build, for one owner.
- Over-the-air updates: a new version is a new build.
- Chat channels (D04).

## 2. Design

The app looks like the web app and behaves like a phone app. Same tokens and roles, so a task, a phase or a department reads the same on both. Native navigation and controls, so it feels at home on Android and on iOS.

### What carries over from the web app

- **Colour:** neutral greys carry the interface, and hues are kept for meaning (phases with their icons and tones, priorities, department colours, status dots, tinted badges). Dark by default, light from the same roles, and the system setting followed unless you pick one.
- **Material:** surfaces drawn with a 1px inset rim and a short shadow (React Native's `boxShadow`), cards one step lighter than the screen, pressed states as translucent layers of the foreground colour.
- **Type:** Mona Sans, with text styles as named roles. The roles keep their names and grow for a phone, where the web's 14 px body is small:

  | Role | Size |
  |---|---|
  | display (large titles) | 28 |
  | title | 20 |
  | heading | 17 |
  | body | 16 |
  | label | 15 |
  | caption | 13 |
  | meta | 11 |

  They follow the system's text size, up to a cap.
- **Controls:** pills for buttons and chips; the primary button is the inverse colour.
- **Patterns:**
  - board cards: a meta line, a title, chips and a status line;
  - a conversation: your messages in bubbles, agents' answers as plain text, tool calls as rows that fold, and a composer that lights up while an agent works;
  - live dots, and skeletons while loading;
  - costs and tokens wherever work happens.

### What changes on a phone

- **Navigation:**
  - Tabs at the bottom (Home, Inbox, Chief, Board), native on each platform (Expo Router's native tabs), each with its own stack.
  - A task opens as a pushed screen, its overview, transcript and files in a segmented control; its browser opens full screen.
  - Dialogs become sheets.
- **The board:** one phase at a time, since side-by-side columns don't fit a phone. A strip of phases with their counts sits at the top; you swipe or tap between them, and a department filter narrows them.
- **Touch:** every target is at least 48 dp (44 pt on iOS), so the web's 28–32 px pills become 44–48. Small icons get a larger hit area.
- **Feedback:** haptics on approve, decline and send. Lists take a pull to refresh, though live updates keep them fresh anyway.
- **Approvals:** a call's tool and arguments show in a sheet before you decide. No swipe gestures for approvals, so nothing gets approved by accident.
- **Links** agents wrote open in the in-app browser (Custom Tabs on Android, Safari's view on iOS), and only when they're http(s).
- **Accessibility:** every control has a role and a label for TalkBack and VoiceOver, and motion is reduced when the system asks.

### Platform conventions

- **Android:** the system's back gesture, edge-to-edge drawing (the default from Android 15), a themed (monochrome) icon, and a notification channel per kind.
- **iOS:** large titles in stacks, swipe-back, native sheets. They're in the code from P1, and get checked on a device later.

## 3. Architecture

**App (`apps/mobile`):**
- **Expo SDK 57:** React Native 0.86 and React 19.2. SDK 58 (React Native 0.88 and React 19.3, the web app's React) was still in beta when P1 started; moving to it is a PR of its own once it ships.
- **Runtime:** the New Architecture and Hermes, both mandatory now; TypeScript, strict, as everywhere else.
- **Expo Router:** screens are files, with a deep link for every screen (`superagent://`), and native tabs (`unstable-native-tabs` in SDK 57). Typed routes are off: the dev server generates them, and the typecheck runs without it.
- **Continuous Native Generation:**
  - `android/` and `ios/` are generated by `expo prebuild` and kept out of git. Native settings live in `app.config.ts` and config plugins.
  - The app runs as a development build, not in Expo Go, which can't receive push on Android.
- **Libraries:** few, each with a job:

  | Library | Job |
  |---|---|
  | expo-secure-store | the token and the push key |
  | expo-notifications, expo-task-manager | push |
  | expo-camera | scanning the pairing code |
  | expo-sqlite's key-value store | the query cache |
  | expo-haptics, expo-image, expo-web-browser | feedback, images, links |
  | expo-sharing | receiving what other apps share (Expo's own, since SDK 55), and sharing a task's files out |
  | expo-file-system | a task's files on the phone |
  | expo-local-authentication | the app lock |
  | Reanimated, Gesture Handler | motion and gestures |
  | Keyboard Controller | the composer |
  | Legend List | the conversation: no inverted list, so a streaming answer grows in place |
  | lucide | icons |
  | `@noble/ciphers` | decrypting notifications (plain JavaScript, audited) |

  Markdown is parsed with the parser the web app uses (`mdast-util-from-markdown` with GFM) and drawn with our own components:
  - raw HTML is dropped;
  - links work only when they're http(s);
  - images show as links, as on the web.

**Styling:**
- `StyleSheet` and a token module, with no styling library: nothing to migrate when Tailwind or an SDK changes.
- A script generates the tokens from the web app's `theme.css`. React Native has no `oklch()`, `color-mix()` or CSS variables, so each value is computed for each theme. A test fails when the generated module and `theme.css` disagree, so the two apps can't drift.
- Components take roles (`card`, `label`, the tones), never raw colours or sizes, as in the web app.
- Mona Sans, in three static cuts (Regular, Medium, SemiBold), since SDK 57 can't read a variable font's weight axis. One variable font once SDK 58 can. It's OFL, credited in `THIRD-PARTY-NOTICES.md`.
- Native controls where they exist, such as Expo UI's menus and pickers, rather than imitations.

**Shared code (`packages/client`):**
- The web app's data layer, the parts that don't touch the DOM or React DOM, moves to a package both apps use:
  - the HTTP client, with the base URL, the token and `fetch` passed in; zod parsing with `@superagent/shared`; problem errors;
  - query keys, and query and mutation definitions (TanStack's query options), so both apps ask for the same things the same way;
  - the SSE reader (`fetch` passed in), the event stream, and the map of which queries each event refreshes;
  - the conversation reducer, and the reconciliation of history with the live turn (D47);
  - the live view's protocol helpers (keystrokes, modifiers);
  - formatting, phases, priorities and department tones.
- It depends on neither React nor React DOM, only on TanStack's query core for its types, so the two apps' React versions never meet. Each app keeps its own hooks (a line or two each), storage and screens.
- The move changes nothing: the web app behaves as before, and its unit and browser tests stay as they are.

**Data:**
- TanStack Query, the web app's version. The app's state (in the foreground or not) drives its focus, and the network's state its online status.
- The cache is kept on the phone for 24 hours (expo-sqlite's key-value store), so the app opens on what it last knew, marked as such until it refreshes. The token is never in it.
- The app reads the server's version and shows it. A response it can't parse says the app and the server are out of step, rather than failing silently.

**Live updates (D46, on a phone):**
- One connection to `/v1/events` while the app is in the foreground, read with `expo/fetch` (Expo installs it as the global `fetch`; the token in a header) and resumed with `Last-Event-ID`.
- It closes when the app goes to the background, which the system would do anyway, and push covers that time. Back in the foreground, it resumes and refreshes what's on screen.
- Conversations stream the same way while they're on screen (D47).

**Sign-in (D45, on a phone):**
- **Pairing:**
  - The web app's Devices page, with the admin token, shows a pairing code as a QR code and as a link (`superagent://pair?...`).
  - The phone scans it, or opens the link, and claims a device token with the code. A code works once, within 10 minutes.
  - API: `POST /v1/tokens/pairing` (admin only) and `POST /v1/tokens/claim`. A pairing code is accepted on that one route only, so every other route still answers 401 without a real token.
- **Or a pasted token:** the server's address and a token. An admin token is exchanged for a device token, as on the web.
- **The device token:**
  - It's named after the phone ("App: Pixel 9, Android 16") and kept in the phone's keystore (expo-secure-store).
  - Signing out revokes it, and a revoked token brings back the sign-in screen.

**Push (D54):**
- **Sending:** the API sends notifications itself, straight to Google's FCM for Android (APNs for iOS later), with no relay such as Expo's push service.
- **What triggers one:** `PushService` follows the event bus:
  - a call waiting for approval;
  - a question (a `blocked` report);
  - a result to review;
  - a task that failed or wasn't dispatched.

  It also hears when the chief finishes an answer. Each becomes a notification for every device that registered and asked for that kind.
- **Content:** the push carries only ciphertext.
  - Each registration has its own key, made on the phone and kept in its keystore and, sealed with SecretBox, on the server.
  - The app decrypts the push and shows it: "Approve `send_email`?", "Task #12 has a question".
  - Google sees that something was sent, and when, but not what.
  - Fetching the details on arrival was the alternative, but it would need Tailscale up at that moment.
- **Actions:**
  - On Android the app draws notifications itself, from FCM data messages handled in the background even when the app is closed. That's what lets them carry actions: Approve and Decline on an approval, Reply on a question or the chief's answer, Accept on a result.
  - Actions work only on an unlocked phone. They call the inbox's routes, with an idempotency key made when the notification arrived, so a retry can't decide twice.
- **When the server can't be reached** (Tailscale off), the action says so and opens the app on the item. Tapping a notification opens its task, or the inbox.
- **Registrations** belong to the device token, so revoking it stops its pushes.
- **Setup:** the Firebase project's service account goes into the web app's settings, sealed and write-only like provider keys.
- **Without push,** the app still works: what needs you shows whenever it's open.

**Networking:**
- Release builds reach the server only over HTTPS, at its tailnet name from `tailscale serve`.
- Development and test builds may also use plain HTTP, to this PC only: `localhost`, or `10.0.2.2`, the emulator's name for it. The flows use `10.0.2.2`: `adb reverse`, which forwards localhost's ports, loses them whenever the emulator's connection resets.
- A request that can't connect says so: "Can't reach superagent. Is Tailscale on?"

**Tests:**
- **Unit and component:** Jest (jest-expo) and React Native Testing Library. They render the whole app through Expo Router (`ExpoRoot` with its test context, on real timers, since the test renderer's fake timers stall streamed responses), with MSW mocking only the network (the web app's rule). MSW stays on 2.15, the web app's version, since MSW 3 dropped Jest. They run in `pnpm check`.
- **End to end:** Maestro flows on an Android emulator in CI, in a job of their own, against the API run from source with its database: the packaged stack's job is long enough already, and it's the same API. They test a release build made for testing (a debug build needs Metro running), which may use plain HTTP to reach the API.
- **iOS:** CI builds the app for the iOS simulator on a macOS runner and runs a short flow on it. Docker doesn't run on those runners, so there's no stack for the flow to reach: it checks the app up to the point where it needs a server.
- **API:** pairing, push registration and sending, against a fake FCM server.

## 4. Screens

| Route | Screen | Milestone |
|---|---|---|
| `/sign-in`, `/pair` | Pair with a code (scanned or a link), or a server and a token | P1 |
| `/` (Home tab) | What needs you, what's running, what finished | P1 |
| `/board` | The board, a phase at a time, filtered by department | P1 |
| `/tasks/[id]` | A task: brief, report, checklist, artifacts, history and cost; its actions; a message to the lead | P1 |
| `/new-task` | A new task, in a sheet | P1 |
| `/settings` | The server, this device, theme, notifications, signing out, a link to the web app | P1, P3 |
| `/chief` | The conversation with the chief | P2 |
| `/tasks/[id]` (transcript) | The lead's thread | P2 |
| `/inbox` | What needs you, each kind with its action | P3 |
| `/share` | What another app shared: to the chief, a new task, or knowledge | P4 |
| `/tasks/[id]` (files), `/tasks/[id]/browser` | A task's files, and its live browser | P4 |
| `/lock` | The app lock | P5 |

## 5. Milestones

Each milestone ends like the web app's: tests pass, a PR, one review, fixes, CI green, merged. Branches follow the milestones (`p1-mobile-foundation`, `p2-mobile-conversations`, and so on).

### P1: foundation, sign-in and the board

**Build:**
- `packages/client`: the web app's data layer moves here:
  - the HTTP client;
  - query keys and definitions;
  - the SSE reader, the event stream and the refresh map;
  - formatting, phases and tones.

  The web app uses it, and its tests pass unchanged.
- `apps/mobile`:
  - the Expo app, with Expo Router and native tabs;
  - the design system (generated tokens, Mona Sans, type roles, buttons, chips and badges, list rows, cards, sheets, banners, skeletons, empty states, Markdown), light and dark.
- **Sign-in:**
  - pairing (web: "Pair a phone" on the Devices page, with a QR code and a link), or a server and a token;
  - the token in the keystore, and signing out;
  - a revoked token signs the app out.
- **API:** pairing codes (`POST /v1/tokens/pairing`, `POST /v1/tokens/claim`), and the server's version in `GET /v1/me`.
- **Live events** in the foreground, resumed on return.
- **Screens:** home, the board, a task (with its waiting calls to approve or decline), a new task, and settings.
- **Development:**
  - `pnpm dev:mobile` starts Metro, and one command builds the app and installs it on the emulator.
  - `docs/runbooks/mobile.md` covers setting up this PC:
    - the Android command-line tools (Android Studio isn't needed) with the Android 16 SDK (platform 36), and JDK 17;
    - an emulator with Google APIs and 4 GB, which runs on the Windows hypervisor Docker Desktop already uses;
    - CMake 3.31.6, for the long paths of pnpm's `node_modules`;
    - the Maestro flows.
- **CI:**
  - the mobile unit tests in `pnpm check`;
  - a job that builds the Android app, starts the stack and runs the Maestro flows on an emulator;
  - a job that builds for the iOS simulator and runs a short flow on it.

**Done when:**
- On the emulator, against the API in development:
  - the app pairs from the web app's Devices page;
  - a task created in the web app appears on the board without a refresh;
  - on its task screen, approving its waiting call lets the lead finish, and accepting closes it;
  - both themes work.
- Lint, typecheck, the unit tests and the Maestro flows pass in CI, and so does the iOS simulator build.

### P2: conversations

**Build:**
- `packages/client` gains the conversation reducer and reconciliation, moved from the web app, and a stream that both apps' hooks follow.
- The Chief tab:
  - answers streaming in;
  - tool calls as rows that open to their arguments and results;
  - reports as cards linked to their tasks, and notes;
  - a stop button, and earlier messages as you scroll up;
  - a composer above the keyboard that holds a message until the chief's answer is done.
- A task's transcript, among the task's segments.
- Asking the chief from Home.

**Done when:**
- On the emulator, against an API driven by a scripted model:
  - the chief's answer streams in and gives way to the stored answer without a flicker or a repeat;
  - a message sent while it answers waits its turn;
  - a task's transcript stays whole while a call waits for approval, and the rest of the turn streams in after it.
- The Maestro flows cover a conversation.

### P3: the inbox and push

**Build:**
- **The Inbox tab:** approvals first, then questions, problems, results to review and setup. Each has its action:
  - approve, or decline with a reason;
  - answer a question;
  - accept a result, or send it back;
  - open a problem's task;
  - for setup items, what to fix in the web app.

  A count shows on the tab, and on the icon where the launcher shows one.
- **API:**
  - `PushService`, with the chief's finished answers reaching it as well as task events;
  - device registrations: `GET`, `PUT` and `DELETE /v1/push/device` and `POST /v1/push/device/test` for a phone, `GET /v1/push` and `PUT`/`DELETE /v1/push/config` for the owner;
  - the FCM sender: no SDK, just a token signed with the service account, sent to FCM's HTTP v1 API;
  - encrypted payloads;
  - a fake FCM server for tests.
- **Web:** Settings → Notifications, for the Firebase service account (sealed) and the devices that get pushes.
- **App:**
  - turning push on, with Android 13's permission asked once its channels exist;
  - a channel per kind, and which kinds to get, in settings;
  - notifications drawn by the app, with their actions. On the lock screen they show only their kind, and their actions wait for the phone to be unlocked;
  - a tap opens the item;
  - while the app is open, a banner inside it instead.
- **Runbook:** setting up a Firebase project, which is free.
  - The Android app's `google-services.json` stays out of git; the build is given its path.
  - The service account goes to the API.

**Done when:**
- On an emulator with Google APIs, with your Firebase project, and the app closed:
  - a call that needs approval shows a notification within seconds, naming its tool;
  - Approve on the notification lets the lead finish;
  - a question answered from its notification reaches the lead;
  - a revoked device gets nothing more.
- Unit tests cover the payloads, and the sender against the fake FCM server. The Maestro flows cover the inbox.

### P4: work from anywhere

**Build:**
- **Sharing into the app:** text and links go to the chief or a new task. Files go to knowledge, for every department or one, uploaded with their length declared, which the API's 20 MiB limit for uploads requires.
- **A task's files:**
  - listed a folder at a time;
  - text, Markdown and images previewed;
  - anything opened in another app, or saved, through the system's share sheet.
- **A task's browser:** the live view, over its WebSocket with the token in a header:
  - frames as they come, the newest one winning (in expo-image, or drawn with Skia if that stutters);
  - taking it over, and giving it back;
  - a tap to click and a drag to scroll;
  - a field whose typing goes to the page;
  - closing it.

  An identity's sign-in uses the same view.

**Done when:**
- On the emulator, with a runner of its own starting a real browser:
  - a code typed on the phone reaches the page the agent opened;
  - a link shared from Chrome starts a task;
  - a file the agent wrote opens in another app.

### P5: lock, offline and release

**Build:**
- **An app lock:** your fingerprint, face or the phone's PIN after a few minutes away (you choose how long, or turn it off). The app's content is hidden in the recent apps.
- **Offline:** the app opens on what it last knew, says it's offline, and holds actions until it's back.
- **Icons and splash screen** from the web app's icon, adaptive and monochrome on Android.
- **A release build:**
  - CI builds a signed APK for each release and attaches it to the GitHub release. The signing key stays out of git.
  - The runbook covers installing it on a phone, with Tailscale set to always on.
- **An accessibility pass** with TalkBack and large text.

**Done when:**
- The release APK from CI installs on the emulator. With this PC serving the stack through `tailscale serve`, it pairs over HTTPS and passes the Maestro flows.
- The lock and the offline states work.

### Later: the iPhone

When you have an iPhone and Apple's developer program:
- **APNs** in `PushService`, with a .p8 key (sealed) and the same encrypted payloads.
- **Decryption on iOS:** a Notification Service Extension decrypts notifications there.
- **Background actions:** expo-notifications hands control back to iOS at once, so a small native module keeps an action's request alive.
- **Signing and TestFlight** in CI.
- **Device checks:** P1–P5's checks, repeated on a device.

And for a phone without Google's services: UnifiedPush, through a self-hosted ntfy, with a sender that speaks Web Push.

## 6. Risks

| Risk | Mitigation |
|---|---|
| `expo/fetch` streams differently from a browser's `fetch`. On Android a compressed stream is held back until it ends, and a cut connection can look like a finished one | The API doesn't compress `/v1`. The reader treats any end of the stream as a drop, and a watchdog catches silence. P1 runs the stream against the real stack on the emulator. The SSE reader takes any `fetch`, so another one can replace it |
| Receiving shares is experimental in `expo-sharing` | `expo-share-intent` does the same job, if needed |
| Windows' 260-character path limit breaks the Android build (pnpm's folders run deep) | The runbook turns on long paths (a Windows setting, yours to change) |
| The repository's TypeScript 7 and Expo's TypeScript config or types disagree | Checked first in P1. The app can pin its own TypeScript if it must |
| Expo ships about three SDKs a year | One SDK at a time, each upgrade its own PR. Generated native code stays out of git, and native libraries stay few |
| Push goes through Google (and Apple later) | Payloads are encrypted per device, and the app works without push |
| An action from a notification can't reach the server (Tailscale off, phone asleep) | It says so and opens the app on the item. Idempotency keys make a retry safe, and the runbook sets Tailscale to always on |
| A token on a lost phone | It's in the keystore and revocable from the web app's Devices page, with an optional app lock. Pairing codes work once, for 10 minutes |
| Moving the data layer breaks the web app | The move changes no behaviour, and the web app's unit and browser tests stay unchanged and must pass |
| The app and the server update separately | Both parse with the shared schemas. The app shows the server's version, and says so when it can't read a response |
| iOS is never run on a device | CI builds it and runs it on the simulator, and the iPhone work is listed above |
| The emulator in CI is slow or flaky | Gradle and the emulator image are cached, flows are retried, and the mobile jobs run beside the main one |
| Google's developer verification for apps installed outside the Play Store | Installs with `adb` (the emulator's) are exempt. A real phone can use the free limited-distribution account when it's needed; the worldwide rollout is planned for 2027 |
