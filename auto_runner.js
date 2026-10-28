const dns = require('dns').promises;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(__dirname, 'attendance_schedule.log'), line + '\n', 'utf8');
  } catch {}
}

/** Check if internet is reachable */
async function checkInternet() {
  try {
    await dns.lookup('google.com');
    return true;
  } catch {
    try {
      await dns.lookup('cloudflare.com');
      return true;
    } catch {
      return false;
    }
  }
}

/** Run open.js using node child_process */
function runOpenScript() {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'open.js');
    log('Launching open.js with --force...');

    const child = spawn(process.execPath, [scriptPath, '--force'], {
      stdio: 'inherit',
      env: { ...process.env, FORCE_RUN: 'true' },
    });

    child.on('close', (code) => {
      if (code === 0) {
        log('open.js completed successfully (Exit Code 0).');
        resolve(true);
      } else {
        log(`open.js exited with failure code: ${code}`);
        resolve(false);
      }
    });

    child.on('error', (err) => {
      log('Execution error: ' + err.message);
      resolve(false);
    });
  });
}

async function main() {
  log('==============================================');
  log('Windows Scheduled Attendance Task Started');
  log('==============================================');

  const RETRY_INTERVAL_MS = 60 * 1000; // Retry every 1 minute
  let attempt = 1;

  while (true) {
    log(`[Attempt #${attempt}] Checking internet connection...`);
    const isOnline = await checkInternet();

    if (!isOnline) {
      log('No internet connection. Waiting 1 minute to retry...');
      await sleep(RETRY_INTERVAL_MS);
      attempt++;
      continue;
    }

    log('Internet connected. Executing attendance submission...');
    const success = await runOpenScript();

    if (success) {
      log('SUCCESS: Attendance marked and saved on UPMSP portal!');
      log('==============================================\n');
      break;
    } else {
      log('Script failed or portal temporary glitch. Waiting 1 minute before retrying...');
      await sleep(RETRY_INTERVAL_MS);
      attempt++;
    }
  }
}

main().catch((err) => {
  log('Fatal Task Runner Error: ' + err.message);
  process.exit(1);
});

