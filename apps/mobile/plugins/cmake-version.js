// Native modules (Reanimated's worklets, Screens, the app's own) build with the Android SDK's CMake
// 3.31.6: its ninja (1.12) handles Windows paths over 260 characters, which pnpm's node_modules reach.
// The SDK's default CMake (3.22.1) ships ninja 1.10, which loops ("build.ninja still dirty") on them.
// Gradle installs this version where it's missing, as it does the NDK.
const { withProjectBuildGradle } = require('expo/config-plugins');

const CMAKE_VERSION = '3.31.6';
const MARK = '// superagent: CMake version';

// Before the root plugins: React Native's makes every module wait for :app, which evaluates :app as it
// is applied, and a hook registered after that would come too late for it.
const BLOCK = `${MARK}
subprojects { project ->
  project.afterEvaluate {
    def android = project.extensions.findByName('android')
    // Set everywhere: React Native gives the app its CMake build later than this, and a module without
    // native code never runs CMake.
    if (android != null) android.externalNativeBuild.cmake.version = '${CMAKE_VERSION}'
  }
}

`;

module.exports = function withCmakeVersion(config) {
  return withProjectBuildGradle(config, (mod) => {
    const contents = mod.modResults.contents;
    if (contents.includes(MARK)) return mod;
    const anchor = contents.indexOf('apply plugin: "expo-root-project"');
    if (anchor < 0) throw new Error('cmake-version: the root build.gradle has no expo-root-project plugin');
    mod.modResults.contents = contents.slice(0, anchor) + BLOCK + contents.slice(anchor);
    return mod;
  });
};
