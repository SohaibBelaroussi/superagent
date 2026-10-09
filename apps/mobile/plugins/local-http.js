// Development and test builds may use plain HTTP to this computer only: localhost, which `adb reverse`
// forwards to it, and 10.0.2.2, the emulator's own name for it (where React Native's debug builds look
// for Metro, and the end-to-end flows reach the stack). Everything else stays HTTPS. Release builds for a phone don't
// get this plugin at all (app.config.ts).
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
</network-security-config>
`;

module.exports = function withLocalHttp(config) {
  config = withDangerousMod(config, [
    'android',
    (mod) => {
      const dir = join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'network_security_config.xml'), CONFIG);
      return mod;
    },
  ]);
  return withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return mod;
  });
};
