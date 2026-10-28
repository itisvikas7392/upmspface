const { chromium } = require('playwright');

async function saveSession() {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://auth.udiseplus.gov.in/login?response_type=code&client_id=udise-sdms-g1&scope=read%20user_info&state=0d71efde-d52a-43a1-acbe-a68c1459397a&redirect_uri=https://sdms.udiseplus.gov.in/p1/oauth2/callback&loginTxnId=e1c570fa-08df-4a44-80f6-7c854290df34');
  
    console.log('Log in manually and solve any initial CAPTCHA...');
    // Wait until user reaches the dashboard after successful login
    await page.waitForURL('https://sdms.udiseplus.gov.in/g1/#/academic-choice', { timeout: 120000 });

    // Save cookies and local storage to a file
    await context.storageState({ path: 'auth.json' });
    console.log('Saved authenticated session to auth.json');

    await browser.close();
}

saveSession();