const readline = require('readline');
const dns = require('dns').promises;
const path = require('path');
const { spawn } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Parse various time formats like '4:00 AM', '04:00', '16:30', '4 AM' */
function parseTime(input) {
  const str = input.trim();
  const match = str.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  let minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3] ? match[3].toLowerCase() : null;

  if (minutes < 0 || minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  } else {
    if (hours < 0 || hours > 23) return null;
  }

  return { hours, minutes };
}

/** Format 24-hr time to human-readable 12-hr AM/PM */
function formatTime12(hours, minutes) {
  const m = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  const minStr = String(minutes).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${minStr} ${m}`;
}

/** Calculate milliseconds until target time */
function getTargetDate(hours, minutes) {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

/** Run open.js using node child_process */
function runOpenScript() {
  return new Promise((resolve) => {
    console.log('\n' + '='.repeat(60));
    console.log(`[${new Date().toLocaleTimeString()}] Starting open.js attendance bot...`);
    console.log('='.repeat(60) + '\n');

    const scriptPath = path.join(__dirname, 'open.js');
    const child = spawn(process.execPath, [scriptPath, '--force'], {
      stdio: 'inherit',
      env: { ...process.env, FORCE_RUN: 'true' }
    });

    child.on('close', (code) => {
      console.log('\n' + '='.repeat(60));
      if (code === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] open.js finished successfully (Exit Code 0).`);
        resolve(true);
      } else {
        console.log(`[${new Date().toLocaleTimeString()}] open.js failed or exited with code: ${code}`);
        resolve(false);
      }
      console.log('='.repeat(60) + '\n');
    });

    child.on('error', (err) => {
      console.error(`[ERROR] Failed to execute open.js: ${err.message}`);
      resolve(false);
    });
  });
}

/** Retry loop until open.js completes successfully */
async function executeWithRetry() {
  const RETRY_INTERVAL_MS = 60 * 1000; // Check and retry every 1 minute

  let attempt = 1;
  while (true) {
    console.log(`\n[Attempt #${attempt}] Checking internet connection...`);
    const isOnline = await checkInternet();

    if (!isOnline) {
      console.log(`[!] [${new Date().toLocaleTimeString()}] No internet connection.`);
      console.log(`[*] Waiting for internet connection... (retrying in 1 minute)`);
      await sleep(RETRY_INTERVAL_MS);
      attempt++;
      continue;
    }

    console.log(`[✓] [${new Date().toLocaleTimeString()}] Internet is connected.`);
    const success = await runOpenScript();

    if (success) {
      console.log(`[SUCCESS] [${new Date().toLocaleTimeString()}] Attendance was successfully marked!`);
      break;
    } else {
      console.log(`[!] [${new Date().toLocaleTimeString()}] Attendance could not be completed.`);
      console.log(`[*] Will retry in 1 minute until it succeeds...`);
      await sleep(RETRY_INTERVAL_MS);
      attempt++;
    }
  }
}

async function main() {
  console.clear();
  console.log('========================================================');
  console.log('      UPMSP Attendance Automated Scheduler');
  console.log('========================================================\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (query) => new Promise((resolve) => rl.question(query, resolve));

  let timeConfig = null;
  while (!timeConfig) {
    const input = await question('Enter the time you want open.js to run (e.g. 04:00 AM, 10:30 AM): ');
    timeConfig = parseTime(input);
    if (!timeConfig) {
      console.log('[!] Invalid time format. Examples: "4:00 AM", "04:00 AM", "10:30 AM", "16:00"\n');
    }
  }
  rl.close();

  const formattedTime = formatTime12(timeConfig.hours, timeConfig.minutes);
  console.log(`\n[✓] Attendance scheduler activated for: ${formattedTime} daily.`);
  console.log('--------------------------------------------------------');

  // Main Daily Scheduling Loop
  while (true) {
    const targetDate = getTargetDate(timeConfig.hours, timeConfig.minutes);
    const msUntilTarget = targetDate.getTime() - Date.now();

    const hoursLeft = Math.floor(msUntilTarget / (1000 * 60 * 60));
    const minsLeft = Math.floor((msUntilTarget % (1000 * 60 * 60)) / (1000 * 60));

    console.log(`\nNext run scheduled at: ${targetDate.toLocaleString()} (in ${hoursLeft}h ${minsLeft}m)`);
    console.log(`Waiting for target time... [Do not close this window]`);

    // Wait until target time
    await sleep(msUntilTarget);

    console.log(`\n[!] Scheduled time reached: ${formatTime12(timeConfig.hours, timeConfig.minutes)}`);
    
    // Execute and retry until successful
    await executeWithRetry();

    console.log(`\n[✓] Today's attendance run complete. Next run will be tomorrow at ${formattedTime}.`);
    console.log('--------------------------------------------------------');
  }
}

main().catch((err) => {
  console.error('Fatal scheduler error:', err);
});

