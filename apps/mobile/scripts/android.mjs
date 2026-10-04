import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const android = fileURLToPath(new URL('../android/', import.meta.url));
const mode = process.argv[2];
if (!['apk', 'aab'].includes(mode)) throw new Error('Usage: node apps/mobile/scripts/android.mjs apk|aab');
const release = mode === 'aab';
const env = { ...process.env };
if (release) {
  if (env.CAP_SERVER_URL) throw new Error('Unset CAP_SERVER_URL before building for Google Play.');
  if (!/^[1-9][0-9]*$/.test(env.ANDROID_VERSION_CODE ?? '') || Number(env.ANDROID_VERSION_CODE) > 2100000000) {
    throw new Error('Set ANDROID_VERSION_CODE to an unused Play build number from 1 to 2100000000.');
  }
  // The web About page and Android versionName must agree, including when invoked after a dev build.
  env.MESHNET_VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url))).version;
  // Play updates the app itself and allows no other way, so this build never looks for an APK.
  env.MESHNET_FOR_PLAY = '1';
} else {
  delete env.MESHNET_FOR_PLAY;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const gradle = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
run('pnpm', ['--filter', '@meshnet/meshcore', 'build'], root);
run('pnpm', ['--filter', '@meshnet/web', 'build'], root);
// Syncing Android must not rewrite the iOS Swift package paths on Windows or Linux.
// Gradle must run after sync: a fresh checkout has no Cordova bridge and may carry another OS's pnpm paths.
run('pnpm', ['--filter', '@meshnet/mobile', 'exec', 'cap', 'sync', 'android'], root);
run(gradle, release ? ['bundleRelease', 'lintRelease', '--console=plain'] : ['assembleDebug', '--console=plain'], android);
console.log(`Android ${release ? 'bundle: apps/mobile/android/app/build/outputs/bundle/release/app-release.aab' : 'APK: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk'}`);
