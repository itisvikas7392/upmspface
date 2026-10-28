const readline = require('readline');
const { execSync } = require('child_process');
const path = require('path');

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

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return `${hh}:${mm}`;
}

function format12(time24) {
  const [hStr, mStr] = time24.split(':');
  let h = parseInt(hStr, 10);
  const m = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${mStr} ${m}`;
}

async function main() {
  console.clear();
  console.log('========================================================');
  console.log('   Register Attendance Bot in Windows Task Scheduler');
  console.log('========================================================\n');
  console.log('This will configure Windows to run the bot automatically');
  console.log('every single day at your chosen time, even after reboots!\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (q) => new Promise((resolve) => rl.question(q, resolve));

  let time24 = null;
  while (!time24) {
    const input = await question('Enter the daily run time (e.g. 04:00 AM, 10:30 AM): ');
    time24 = parseTime(input);
    if (!time24) {
      console.log('[!] Invalid time format. Examples: 4:00 AM, 04:00 AM, 10:30 AM, 16:00\n');
    }
  }
  rl.close();

  const batPath = path.join(__dirname, 'run_scheduled.bat');
  const taskName = 'UPMSP_FaceAttendance';

  console.log(`\nRegistering task for ${format12(time24)} (${time24} 24-hr)...`);

  const cmd = `schtasks /create /tn "${taskName}" /tr "\\"${batPath}\\"" /sc daily /st ${time24} /f`;

  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log('\n========================================================');
    console.log(' [SUCCESS] Task Successfully Scheduled in Windows!');
    console.log('========================================================');
    console.log(`- Daily Schedule Time: ${format12(time24)}`);
    console.log(`- Task Name: ${taskName}`);
    console.log(`- Activity Log File: attendance_schedule.log`);
    console.log('\nWindows will now trigger this automatically every day.');
    console.log('You do NOT need to keep any window open.');
  } catch (err) {
    console.error('\n[ERROR] Failed to create scheduled task:', err.message);
  }
}

main();

