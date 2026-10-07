#!/bin/sh
# Starts Chromium for one task. DevTools stays on loopback (the runner reaches it from inside).
#   BROWSER_PROXY    the egress proxy (empty: no proxy, for tests on a closed network)
#   BROWSER_SANDBOX  "no" turns Chromium's own sandbox off (hosts that forbid user namespaces)
#   BROWSER_BYPASS   hosts reached without the proxy (tests only)
set -eu

# A profile is only ever used by one browser at a time (the runner and the API make sure), so a lock
# left behind by a crash or a killed container is stale.
rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie

set -- \
  --headless=new \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-component-update \
  --disable-sync \
  --disable-dev-shm-usage \
  --disable-features=Translate,OptimizationHints,MediaRouter \
  --webrtc-ip-handling-policy=disable_non_proxied_udp \
  --force-webrtc-ip-handling-policy \
  --window-size=1280,800

if [ -n "${BROWSER_PROXY:-}" ]; then
  set -- "$@" --proxy-server="$BROWSER_PROXY" --proxy-bypass-list="<-loopback>${BROWSER_BYPASS:+;$BROWSER_BYPASS}"
fi
if [ "${BROWSER_SANDBOX:-yes}" = "no" ]; then
  set -- "$@" --no-sandbox
fi

exec chromium "$@" about:blank
