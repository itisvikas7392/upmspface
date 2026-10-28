const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// Load environment variables from .env file
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  } else {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    });
  }
}

/* ----- CONFIGURATION (loaded from .env) ----- */
const PORTAL_USER = process.env.PORTAL_USER || '';
const PORTAL_PASS = process.env.PORTAL_PASS || '';
const SHEET_URL = process.env.SHEET_URL || 'https://script.google.com/macros/s/AKfycbw8Ehd-0ssiaaJ0i9yrvy2r7_c67Wx1qH7cZHGHny0VR9C3PZRO2C9gsw0PAy_hQSk/exec';
const SHEET_TOKEN = process.env.SHEET_TOKEN || '';
/* ------------------------------------------- */

const START_HOUR = 10; // only run 10 AM or later

/** Fetch today's presence from the Google Sheet via Apps Script. */
async function fetchViewedAttendance() {
  const res = await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'portalAttendance', token: SHEET_TOKEN }),
  });
  const data = await res.json();
  if (!data || !Array.isArray(data.people)) {
    throw new Error('Unexpected sheet response: ' + JSON.stringify(data));
  }
  return data;
}

/** Normalize a registration number for comparison. */
function regKey(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

/** Normalize a name for comparison. */
function nameKey(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Batch-set every student dropdown from presentRegs: matched -> P, all else -> AB. */
async function markStudents(page, presentRegs) {
  return page.evaluate((presentList) => {
    const rows = document.querySelectorAll('#ctl00_cphBody_GridView_CandidateList tr');
    let present = 0, absent = 0;
    rows.forEach((row) => {
      const sel = row.querySelector('select.ddl_vc_ABS');
      if (!sel) return;
      const tds = row.querySelectorAll('td');
      const reg = (tds[3] ? (tds[3].innerText || '') : '').replace(/\s+/g, '').toUpperCase();
      const value = presentList.includes(reg) ? 'P' : 'AB';
      sel.value = value;
      if (value === 'P') present++; else absent++;
    });
    return { present: present, absent: absent };
  }, Array.from(presentRegs));
}

/** Batch-set teacher/staff dropdowns by matching registration number in each row: matched -> P, else AB. */
async function markByReg(page, presentRegs) {
  return page.evaluate((presentList) => {
    const sels = document.querySelectorAll('select.ddl_vc_ABS');
    let present = 0, absent = 0;
    sels.forEach((sel) => {
      const tr = sel.closest('tr');
      if (!tr) return;
      const tds = Array.from(tr.querySelectorAll('td'));
      const cellTexts = tds.map((td) => (td.innerText || '').replace(/\s+/g, '').toUpperCase());
      const rowClean = (tr.innerText || '').replace(/\s+/g, '').toUpperCase();
      const matched = presentList.some((reg) => reg && (cellTexts.includes(reg) || rowClean.includes(reg)));
      const value = matched ? 'P' : 'AB';
      sel.value = value;
      if (value === 'P') present++; else absent++;
    });
    return { present: present, absent: absent };
  }, Array.from(presentRegs));
}

/** Read back every attendance dropdown and count what would be saved. */
async function verifyMark(page) {
  return page.evaluate(() => {
    const sels = document.querySelectorAll('select.ddl_vc_ABS');
    let p = 0, ab = 0, other = 0;
    sels.forEach((s) => {
      if (s.value === 'P') p++; else if (s.value === 'AB') ab++; else other++;
    });
    return { p: p, ab: ab, other: other };
  });
}

(async () => {
  const now = new Date();
  const FORCE_RUN = process.argv.includes('--force') || process.env.FORCE_RUN === 'true';

  if (!FORCE_RUN && now.getDay() === 0) {
    console.log('Sunday detected; attendance script will not run.');
    return;
  }
  if (!FORCE_RUN && now.getHours() < START_HOUR) {
    console.log('Before 10 AM; attendance script will not run yet.');
    return;
  }

  // Fetch real attendance BEFORE touching the portal.
  let attended;
  try {
    attended = await fetchViewedAttendance();
  } catch (err) {
    console.log('Could not fetch attendance from the sheet:', err.message);
    console.log('Nothing was marked on the portal.');
    return;
  }
  console.log('Fetched attendance for', attended.date, '-',
    attended.people.filter((p) => p.present).length, 'present /', attended.people.length, 'registered');

  const presentRegs = new Set(
    attended.people.filter((p) => p.present).map((p) => regKey(p.registration))
  );
  const presentTeachers = new Set(
    attended.people.filter((p) => p.category === 'teacher' && p.present && p.registration).map((p) => regKey(p.registration))
  );
  const presentStaff = new Set(
    attended.people.filter((p) => p.category === 'staff' && p.present && p.registration).map((p) => regKey(p.registration))
  );

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  page.on('dialog', async dialog => {
    console.log("Popup:", dialog.message());
    await dialog.accept();
  });

  await page.goto(
    'https://attendance.upmsp.edu.in/SectionSchool/LoginSchool.aspx',
    { waitUntil: 'networkidle' }
  );

  await page.waitForSelector('#ctl00_cphBody_txt_UserName');
  await page.waitForSelector('#ctl00_cphBody_txt_Password');

  await page.locator('#ctl00_cphBody_txt_UserName').fill(PORTAL_USER);
  await page.locator('#ctl00_cphBody_txt_Password').fill(PORTAL_PASS);

  console.log('Username and Password filled');

  const captchaCode = await page.locator(
    '#ctl00_cphBody_HiddenField_CaptchaCode'
  ).inputValue();

  console.log('CAPTCHA Code:', captchaCode);

  await page.locator('#ctl00_cphBody_TxtCAPTCHA').fill(captchaCode);

  console.log('CAPTCHA filled');

  await page.locator('#ctl00_cphBody_btn_LoginButton').click();

  console.log('Login button clicked');

  await page.waitForLoadState('networkidle').catch(() => { });

  console.log('Current URL:', page.url());

  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => { });

  await page.waitForSelector('#A1');

  await page.locator('#A1').click();

  console.log('छात्रों की उपस्थिति clicked');

  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => { });

  console.log('Attendance page loaded');

  const classes = ['09', '10', '11', '12'];

  for (const classValue of classes) {

    console.log(`Processing Class ${classValue}`);

    await page.locator('#ctl00_cphBody_ddl_Class').selectOption(classValue);

    await page.locator('#ctl00_cphBody_btn_SearchStudent').click();

    await page.waitForLoadState('networkidle').catch(() => { });

    // Mark every student's dropdown in one pass: scanned-today (by reg) -> P, all else -> AB.
    const stats = await markStudents(page, presentRegs);
    const ver = await verifyMark(page);
    console.log(`Class ${classValue}: ${stats.present} present, ${stats.absent} absent (from sheet); verified P=${ver.p} AB=${ver.ab}`);

    await page.locator('#ctl00_cphBody_btn_SaveAttendance').click();

    console.log(`Class ${classValue} saved successfully`);

    await page.waitForLoadState('networkidle').catch(() => { });

    await page.waitForTimeout(2000);
  }

  console.log('All Classes 9, 10, 11, 12 completed');
  await page.waitForLoadState('networkidle').catch(() => { });

  await page.waitForSelector('#A2');
  await page.locator('#A2').click();

  console.log('शिक्षकों की उपस्थिति clicked');
  await page.locator('input#ctl00_cphBody_btn_SearchTeacher').click();

  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => { });

  console.log('Teachers Attendance page loaded');

  const count = await page.locator('select.ddl_vc_ABS').count();
  console.log(`Teacher attendance select boxes found: ${count}`);

  if (count === 0) {
    throw new Error('No teacher attendance select boxes were found');
  }

  // Mark all teacher dropdowns in one pass: scanned-today (by name) -> P, all else -> AB.
  const teacherStats = await markByReg(page, presentTeachers);
  const teacherVer = await verifyMark(page);
  console.log(`Teachers: ${teacherStats.present} present, ${teacherStats.absent} absent (from sheet); verified P=${teacherVer.p} AB=${teacherVer.ab}`);

  await page.locator('#ctl00_cphBody_btn_SaveAttendance').click();
  await page.waitForLoadState('networkidle').catch(() => { });
  console.log('Teacher attendance saved successfully');

  await page.waitForSelector('#A3');
  await page.locator('#A3').click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => { });
  console.log('Non-teaching staff attendance page loaded');

  await page.locator('#ctl00_cphBody_btn_SearchTeacher').click();
  await page.waitForLoadState('networkidle').catch(() => { });
  await page.waitForSelector('select.ddl_vc_ABS');

  // Mark all staff dropdowns in one pass: scanned-today (by name) -> P, all else -> AB.
  const staffStats = await markByReg(page, presentStaff);
  const staffVer = await verifyMark(page);
  console.log(`Non-teaching staff: ${staffStats.present} present, ${staffStats.absent} absent (from sheet); verified P=${staffVer.p} AB=${staffVer.ab}`);

  await page.locator('#ctl00_cphBody_btn_SaveAttendance').click();
  await page.waitForLoadState('networkidle').catch(() => { });
  console.log('Non-teaching staff attendance saved successfully');

  await page.locator('#ctl00_LoginView1_LoginStatus1').click();
  await page.waitForLoadState('networkidle').catch(() => { });
  console.log('Logged out successfully');

  await browser.close();
})().catch(err => {
  const msg = String((err && err.message) || err);
  if (msg.includes("Cannot find module 'playwright'")) {
    console.log('playwright is not installed here. Run this from the "open" folder (or phone_app) that has node_modules, then:');
    console.log('  npm install');
    console.log('  npx playwright install chromium');
  } else if (msg.includes('Executable doesn\'t exist') || msg.includes('npx playwright install')) {
    console.log('The browser is not installed. Run: npx playwright install chromium');
  } else {
    console.log('Script failed:', msg);
  }
  process.exit(1);
});
