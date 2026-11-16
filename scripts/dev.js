import { spawn } from 'node:child_process';

const configuredTimeout = Number(process.env.YOURTUBE_SHUTDOWN_TIMEOUT_MS);
const shutdownTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
  ? Math.floor(configuredTimeout)
  : 2500;
const watchProcess = spawn(process.execPath, [
  '--watch',
  '--watch-preserve-output',
  '--watch-path=server.js',
  'server.js'
], {
  stdio: 'inherit',
  env: { ...process.env, YOURTUBE_SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs) }
});

let forwardedSignals = 0;
let forcedExitTimer = null;
const forwardSignal = signal => {
  forwardedSignals += 1;
  if (forwardedSignals > 1) {
    watchProcess.kill('SIGKILL');
    return;
  }
  watchProcess.kill(signal);
  forcedExitTimer = setTimeout(() => watchProcess.kill('SIGKILL'), shutdownTimeoutMs + 7000);
  forcedExitTimer.unref();
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

watchProcess.once('error', error => {
  console.error('Could not start the YourTube development watcher:', error.message || error);
  process.exitCode = 1;
});
watchProcess.once('exit', (code, signal) => {
  if (forcedExitTimer) clearTimeout(forcedExitTimer);
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
