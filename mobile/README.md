# Lochie College — Campus (iOS)

The phone surface of the College. A real native app: Expo/React Native
renders actual `UIView`s, not a webview, and EAS builds a genuine `.ipa` in
the cloud — **no Mac required**.

## What this app is, and is not

It is **another institutional surface, not another institution**. It holds no
state the server doesn't hold and computes no interpretation of its own. Every
sentence you read in it was written by the College, because the moment the
phone starts deriving "you're 4 sessions behind" locally there are two
accountability systems that can disagree.

There is **no second backend**. It talks to the same Arena API and the same
PostgreSQL database as the desktop.

## What the phone may do

Enforced server-side by the surface ceiling in `src/lib/college/surfaces.ts`:

| Capability | Campus (phone) | Control Room (desktop) |
|---|:--:|:--:|
| read state | ✅ | ✅ |
| run a session | ✅ | ✅ |
| record commitments | ✅ | ✅ |
| capture evidence | ✅ | ✅ |
| record external (TAFE) | ✅ | ✅ |
| edit curriculum | ❌ | ✅ |
| edit timetable | ❌ | ✅ |
| configure faculty | ❌ | ✅ |
| institutional decisions | ❌ | ✅ |
| bootstrap | ❌ | ✅ |

The phone can **be a student**. It cannot **be the institution**. That ceiling
is structural: it is derived from the surface, not stored per device, so there
is no field an attacker could flip to escalate.

## Setup

```bash
cd mobile
npm install
npx expo start          # scan the QR with Expo Go for instant iteration
```

## Building a real .ipa without a Mac

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform ios --profile preview
```

EAS builds on Apple hardware in the cloud and hands back an installable
`.ipa`.

**With a free Apple ID** the build is signed for 7 days and must be
re-installed weekly — workable, mildly annoying. The $99/yr Apple Developer
Program removes that and unlocks TestFlight, which is the point at which this
stops feeling like a side project.

## Pairing

1. Desktop → **College → Devices →** → *Pair a phone (Campus)*
2. An 8-character code appears. It lives for **ten minutes** and works **once**.
3. Type it into the app with the College's address.
4. The app receives a token, stored in the **iOS keychain** (`expo-secure-store`).

Lost the phone? Revoke it from the same page. It stops working on the very
next request, and the device stays listed — which devices were trusted, and
when that ended, is part of the record.

## Pointing the app at a real server

The College address is entered at pairing time and stored alongside the token,
so there is no build-time API URL to bake in. Repointing the app at a new
deployment is: unpair, re-pair with the new address.

## Deployment requirement

Set **`COLLEGE_AUTH_MODE=strict`** on the server before exposing it to the
internet. Without it, loopback requests are granted Control Room authority
with no token — convenient for local development, catastrophic in public.

## Not built yet, deliberately

Camera capture, notifications and session controls are scaffolded in
`lib/college.ts` (`captureEvidence`) and permitted by the ceiling, but no UI
fires them. Live with the arrival screen first and find out what the phone is
actually for before building machinery for it.
