/** Face Attendance -> Google Sheets bridge
 *
 * SETUP:
 * 1. Create a Google Sheet (https://sheets.new) and keep its URL.
 * 2. Extensions -> Apps Script. Delete the default code and paste ALL of this.
 * 3. Run the `setup()` function once (authorize when asked).
 * 4. Deploy -> New deployment -> type Web app:
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Copy the /exec URL into the phone app's Settings.
 *
 * People: the "People" sheet holds everyone from ALL colleges. Each row keeps
 * the college, name, registration number (students), category
 * (student | staff) and the face descriptor.
 *
 * Attendance: the "Attendance" sheet is a DATEWISE MATRIX. Rows are people
 * (College | Name | Registration | Category), and each new date adds a column.
 * Scanning a face is recorded as "P" in that day's column.
 *
 * The phone matches faces using locally-cached face data, then queues the marks
 * and flushes them here in batches (scanBatch) every ~30 seconds.
 *
 * Users: college accounts (role: college) live in the "Users" sheet with
 * SHA-256 password hashes only (the phone hashes before sending).
 */

var PEOPLE_SHEET = 'People';
var ATTENDANCE_SHEET = 'Attendance';
var USERS_SHEET = 'Users';
var USERS_HEADERS = ['Name', 'Email', 'PasswordHash', 'Role', 'RecoveryPin', 'CreatedAt'];

function doGet() {
  return json_({ ok: true, message: 'Face Attendance service running.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!tokenOk_(body.token)) return json_({ ok: false, error: 'bad token' });

    switch (body.action) {
      case 'signup':
        return json_(signup_(body.name, body.email, body.passwordHash, body.role));
      case 'login':
        return json_(login_(body.email, body.passwordHash));
      case 'sendResetCode':
        return json_(sendResetCode_(body.email));
      case 'resetPassword':
        return json_(resetPassword_(body.email, body.code, body.newPasswordHash));
      case 'resetWithPin':
        return json_(resetWithPin_(body.email, body.pin, body.newPasswordHash));
      case 'enroll':
        return json_(enroll_(body.college, body.name, body.regNo, body.category, body.cls, body.descriptor));
      case 'scan':
        return json_(scan_(body.college, body.name, body.regNo, body.category, body.cls));
      case 'scanBatch':
        return json_(scanBatch_(body.college, body.marks));
      case 'people':
        return json_({ ok: true, people: people_(body.college) });
      case 'attendance':
        return json_({ ok: true, matrix: attendance_(body.college) });
      case 'portalAttendance':
        return json_(portalAttendance_());
      default:
        return json_({ ok: false, error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, PEOPLE_SHEET, ['College', 'Name', 'Registration', 'Category', 'Class', 'Descriptor', 'EnrolledAt']);
  matrixSheet_(ss);
  ensureSheet_(ss, USERS_SHEET, USERS_HEADERS);
  repairAttendance_();
  return 'Sheets ready: People, Attendance (datewise matrix), Users.';
}

/* ---------------- AUTH ---------------- */

function signup_(name, email, passwordHash, role, recoveryPin) {
  name = String(name || '').trim();
  email = String(email || '').toLowerCase().trim();
  passwordHash = String(passwordHash || '').trim();
  recoveryPin = String(recoveryPin || '').trim();
  if (!name || !email || !passwordHash) return { ok: false, error: 'name, email and password required' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'invalid email' };
  if (recoveryPin && recoveryPin.length < 4) return { ok: false, error: 'recovery pin must be at least 4 characters' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, USERS_SHEET, USERS_HEADERS);
  var hm = headerMap_(sheet);
  var last = sheet.getLastRow();
  var emails = last < 2 ? [] :
    sheet.getRange(2, hm['Email'], last - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); });
  if (emails.indexOf(email) >= 0) return { ok: false, error: 'email already registered' };

  appendRowByHeaders_(sheet, hm, USERS_HEADERS,
    [name, email, passwordHash, String(role || 'college').trim(), recoveryPin, now_()]);
  return { ok: true };
}

function login_(email, passwordHash) {
  email = String(email || '').toLowerCase().trim();
  passwordHash = String(passwordHash || '').trim();
  if (!email || !passwordHash) return { ok: false, error: 'email and password required' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, USERS_SHEET, USERS_HEADERS);
  var hm = headerMap_(sheet);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: false, error: 'invalid login' };
  var rows = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][hm['Email'] - 1]).toLowerCase() === email &&
        String(rows[i][hm['PasswordHash'] - 1]) === passwordHash) {
      return { ok: true, user: {
        name: String(rows[i][hm['Name'] - 1]),
        email: String(rows[i][hm['Email'] - 1]),
        role: String(rows[i][hm['Role'] - 1]),
      } };
    }
  }
  return { ok: false, error: 'invalid login' };
}

/* ---------------- FORGOT PASSWORD (email reset code) ---------------- */

function sendResetCode_(email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return { ok: false, error: 'email required' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, USERS_SHEET, USERS_HEADERS);
  var hm = headerMap_(sheet);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: false, error: 'email not registered' };
  var rows = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  var found = false;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][hm['Email'] - 1]).toLowerCase() === email) { found = true; break; }
  }
  if (!found) return { ok: false, error: 'email not registered' };

  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  var lastSent = Number(props.getProperty('SENT:' + email) || 0);
  var wait = Math.ceil((lastSent + 60000 - now) / 1000);
  if (wait > 0) return { ok: false, error: 'wait ' + wait + 's before requesting another code' };

  var code = String(Math.floor(100000 + Math.random() * 900000));
  props.setProperty('RESET:' + email, code + '|' + (now + 15 * 60 * 1000));
  props.setProperty('SENT:' + email, String(now));
  props.deleteProperty('FAIL:' + email);
  props.deleteProperty('FAILT:' + email);

  try {
    MailApp.sendEmail(email, 'Face Attendance - password reset code',
      'Your password reset code is ' + code + '. It is valid for 15 minutes.\n' +
      'If you did not request this, you can ignore this email.');
  } catch (mailErr) {
    props.deleteProperty('RESET:' + email);
    props.deleteProperty('SENT:' + email);
    return { ok: false, error: 'Could not send the email. Open the Apps Script project, run File > Manage versions > authorize (or run a function once), then redeploy a new version.' };
  }
  return { ok: true };
}

function resetPassword_(email, code, newPasswordHash) {
  email = String(email || '').toLowerCase().trim();
  code = String(code || '').trim();
  newPasswordHash = String(newPasswordHash || '').trim();
  if (!email || !code || !newPasswordHash) return { ok: false, error: 'email, code and new password required' };

  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('RESET:' + email);
  if (!stored) return { ok: false, error: 'no reset code pending; request a new one' };

  var parts = String(stored).split('|');
  var savedCode = parts[0];
  var expiry = Number(parts[1] || 0);

  var failKey = 'FAIL:' + email;
  var failTimeKey = 'FAILT:' + email;
  var failCount = Number(props.getProperty(failKey) || 0);
  var failWindow = Number(props.getProperty(failTimeKey) || 0);
  if (failWindow && Date.now() > failWindow) { failCount = 0; props.deleteProperty(failKey); props.deleteProperty(failTimeKey); }

  if (code !== savedCode) {
    failCount++;
    props.setProperty(failKey, String(failCount));
    props.setProperty(failTimeKey, String(Date.now() + 15 * 60 * 1000));
    if (failCount >= 5) props.deleteProperty('RESET:' + email);
    return { ok: false, error: 'wrong code (' + failCount + '/5 attempts)' };
  }
  if (Date.now() > expiry) { props.deleteProperty('RESET:' + email); return { ok: false, error: 'code expired; request a new one' }; }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, USERS_SHEET, USERS_HEADERS);
  var hm = headerMap_(sheet);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: false, error: 'email not registered' };
  var rows = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  var foundRow = -1;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][hm['Email'] - 1]).toLowerCase() === email) { foundRow = i; break; }
  }
  if (foundRow < 0) return { ok: false, error: 'email not registered' };

  sheet.getRange(foundRow + 2, hm['PasswordHash'], 1, 1).setValue(newPasswordHash);
  props.deleteProperty('RESET:' + email);
  props.deleteProperty('FAIL:' + email);
  props.deleteProperty('FAILT:' + email);
  return { ok: true };
}

function resetWithPin_(email, pin, newPasswordHash) {
  email = String(email || '').toLowerCase().trim();
  pin = String(pin || '').trim();
  newPasswordHash = String(newPasswordHash || '').trim();
  if (!email || !pin || !newPasswordHash) return { ok: false, error: 'email, pin and new password required' };

  var props = PropertiesService.getScriptProperties();
  var failKey = 'PINFAIL:' + email;
  var failTimeKey = 'PINFAILT:' + email;
  var failCount = Number(props.getProperty(failKey) || 0);
  var failWindow = Number(props.getProperty(failTimeKey) || 0);
  if (failWindow && Date.now() > failWindow) { failCount = 0; props.deleteProperty(failKey); props.deleteProperty(failTimeKey); }
  if (failCount >= 4) return { ok: false, error: 'too many wrong pins; try again later' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, USERS_SHEET, USERS_HEADERS);
  var hm = headerMap_(sheet);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: false, error: 'email not registered' };
  var rows = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  var foundRow = -1;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][hm['Email'] - 1]).toLowerCase() === email) { foundRow = i; break; }
  }
  if (foundRow < 0) return { ok: false, error: 'email not registered' };

  var savedPin = String(rows[foundRow][hm['RecoveryPin'] - 1]).trim();
  if (!savedPin) return { ok: false, error: 'no recovery pin set for this account; use email code instead' };
  if (savedPin !== pin) {
    failCount++;
    props.setProperty(failKey, String(failCount));
    props.setProperty(failTimeKey, String(Date.now() + 15 * 60 * 1000));
    return { ok: false, error: 'wrong pin (' + failCount + '/4 attempts)' };
  }

  sheet.getRange(foundRow + 2, hm['PasswordHash'], 1, 1).setValue(newPasswordHash);
  props.deleteProperty(failKey);
  props.deleteProperty(failTimeKey);
  return { ok: true };
}

/* ---------------- PEOPLE ---------------- */

function enroll_(college, name, regNo, category, cls, descriptor) {
  college = String(college || '').trim();
  name = String(name || '').trim();
  if (!college) return { ok: false, error: 'college required' };
  if (!name) return { ok: false, error: 'name required' };
  if (!descriptor) return { ok: false, error: 'descriptor required' };
  regNo = String(regNo || '').trim();
  category = String(category || 'student').trim();
  cls = String(cls || '').trim();

  // Serialize concurrent enrollments so two overlapping requests can't both append.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return { ok: false, error: 'server busy, please try again' };
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ensureSheet_(ss, PEOPLE_SHEET, ['College', 'Name', 'Registration', 'Category', 'Class', 'Descriptor', 'EnrolledAt']);
    var hm = headerMap_(sheet);
    var last = sheet.getLastRow();
    var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
    var nl = function (s) { return String(s || '').toLowerCase(); };

    // The registration number must not already belong to a different person in this college.
    if (regNo) {
      for (var x = 0; x < rows.length; x++) {
        var regHeld = nl(rows[x][hm['Registration'] - 1]);
        if (nl(rows[x][hm['College'] - 1]) === nl(college) && regHeld === nl(regNo) &&
            !(nl(rows[x][hm['Name'] - 1]) === nl(name) && String(rows[x][hm['Category'] - 1]) === category)) {
          return { ok: false, error: 'Registration number already registered to someone else.' };
        }
      }
    }

    for (var i = 0; i < rows.length; i++) {
      var sameCollegeName = String(rows[i][hm['College'] - 1]) === college && nl(rows[i][hm['Name'] - 1]) === nl(name) &&
        String(rows[i][hm['Category'] - 1]) === category;
      var sameCollegeReg = regNo && String(rows[i][hm['College'] - 1]) === college &&
        nl(rows[i][hm['Registration'] - 1]) === nl(regNo);
      if (sameCollegeName || sameCollegeReg) {
        var row = i + 2;
        sheet.getRange(row, hm['Registration']).setValue(regNo);
        sheet.getRange(row, hm['Category']).setValue(category);
        if (hm['Class']) sheet.getRange(row, hm['Class']).setValue(cls);
        sheet.getRange(row, hm['Descriptor']).setValue(descriptor);
        sheet.getRange(row, hm['EnrolledAt']).setValue(now_());
        return { ok: true };
      }
    }
    appendRowByHeaders_(sheet, hm, ['College', 'Name', 'Registration', 'Category', 'Class', 'Descriptor', 'EnrolledAt'],
      [college, name, regNo, category, cls, descriptor, now_()]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function people_(college) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, PEOPLE_SHEET, ['College', 'Name', 'Registration', 'Category', 'Class', 'Descriptor', 'EnrolledAt']);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var hm = headerMap_(sheet);
  var rows = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  return rows
    .filter(function (r) {
      if (college && r[hm['College'] - 1] !== college) return false;
      var nm = String(r[hm['Name'] - 1] || '');
      if (nm.trim().toUpperCase() === 'NAME') return false; // stray duplicate header row
      return nm && r[hm['Descriptor'] - 1];
    })
    .map(function (r) {
      return {
        college: String(r[hm['College'] - 1]),
        name: String(r[hm['Name'] - 1]),
        reg: String(r[hm['Registration'] - 1] || ''),
        cls: hm['Class'] ? String(r[hm['Class'] - 1] || '') : '',
        category: String(r[hm['Category'] - 1] || 'student'),
        descriptor: String(r[hm['Descriptor'] - 1]),
      };
    });
}

/* ---------------- ATTENDANCE MATRIX ---------------- */

function matrixSheet_(ss) {
  var BASE = ['College', 'Name', 'Registration', 'Category', 'Class'];
  var sheet = ss.getSheetByName('Attendance');
  if (!sheet) sheet = ss.insertSheet('Attendance');
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, BASE.length).setValues([BASE]);
    sheet.getRange(1, 1, 1, BASE.length).setFontWeight('bold');
    return sheet;
  }
  var hm = headerMap_(sheet);
  if (!hm['College']) {
    sheet.clear();
    sheet.getRange(1, 1, 1, BASE.length).setValues([BASE]);
    sheet.getRange(1, 1, 1, BASE.length).setFontWeight('bold');
  } else {
    var missing = BASE.filter(function (h) { return !hm[h]; });
    if (missing.length) {
      var lastPresent = 0;
      for (var b = 0; b < BASE.length; b++) {
        if (hm[BASE[b]]) lastPresent = Math.max(lastPresent, hm[BASE[b]]);
      }
      var anchor = Math.max(lastPresent, 1);
      sheet.insertColumnsAfter(anchor, missing.length);
      for (var k = 0; k < missing.length; k++) {
        var cell = sheet.getRange(1, anchor + 1 + k);
        cell.setValue(missing[k]);
        cell.setFontWeight('bold');
      }
    }
  }
  return sheet;
}

function scan_(college, name, regNo, category, cls) {
  var res = scanOne_(college, name, regNo, category, cls);
  if (res.error) return { ok: false, error: res.error };
  return { ok: true, added: res.added };
}

function scanBatch_(college, marks) {
  var arr = Array.isArray(marks) ? marks : [];
  var results = [];
  for (var i = 0; i < arr.length; i++) {
    var m = arr[i] || {};
    var reg = String(m.regNo || m.reg || '');
    var res = scanOne_(college, String(m.name || ''), reg, String(m.category || 'student'), String(m.cls || ''));
    results.push({
      name: String(m.name || ''),
      category: String(m.category || 'student'),
      reg: reg,
      added: !!res.added,
      error: res.error || '',
    });
  }
  return { ok: true, results: results };
}

function scanOne_(college, name, regNo, category, cls) {
  college = String(college || '').trim();
  name = String(name || '').trim();
  if (!college) return { added: false, error: 'college required' };
  if (!name) return { added: false, error: 'name required' };
  regNo = String(regNo || '').trim();
  category = String(category || 'student').trim();
  cls = String(cls || '').trim();

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Server-side guard: the person must belong to the logged-in college.
  var peopleSheet = ensureSheet_(ss, PEOPLE_SHEET, ['College', 'Name', 'Registration', 'Category', 'Class', 'Descriptor', 'EnrolledAt']);
  var phm = headerMap_(peopleSheet);
  var pLast = peopleSheet.getLastRow();
  var pRows = pLast < 2 ? [] : peopleSheet.getRange(2, 1, pLast - 1, peopleSheet.getLastColumn()).getValues();
  var found = false;
  for (var p = 0; p < pRows.length; p++) {
    if (String(pRows[p][phm['College'] - 1]) === college &&
        String(pRows[p][phm['Name'] - 1]) === name &&
        String(pRows[p][phm['Category'] - 1]) === category) {
      found = true;
      break;
    }
  }
  if (!found) return { added: false, error: 'not registered in this college' };

  var sheet = matrixSheet_(ss);
  var hm = headerMap_(sheet);
  var dateHeader = date_();

  var rowIdx = matrixRow_(sheet, hm, college, name, regNo, category, cls);
  if (rowIdx < 0) return { added: false, error: 'person not found' };

  var dateCol = findHeaderCol_(sheet, dateHeader);
  if (!dateCol) {
    dateCol = sheet.getLastColumn() + 1;
    var h = sheet.getRange(1, dateCol);
    h.setNumberFormat('@'); // plain text: stop Sheets auto-converting the date string
    h.setValue(dateHeader);
    h.setFontWeight('bold');
    coalesceColumns_(sheet, dateHeader);
  }

  var already = sheet.getRange(rowIdx, dateCol).getValue() === 'P';
  if (!already) sheet.getRange(rowIdx, dateCol).setValue('P');
  return { added: !already };
}

function matrixRow_(sheet, hm, college, name, regNo, category, cls) {
  var last = sheet.getLastRow();
  var nl = function (s) { return String(s || '').toLowerCase(); };
  var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (nl(rows[i][hm['College'] - 1]) === nl(college) &&
        nl(rows[i][hm['Name'] - 1]) === nl(name) &&
        nl(rows[i][hm['Category'] - 1]) === nl(category)) {
      if (regNo && String(rows[i][hm['Registration'] - 1]) === '') {
        sheet.getRange(i + 2, hm['Registration']).setValue(regNo);
      }
      if (cls && hm['Class'] && String(rows[i][hm['Class'] - 1]) === '') {
        sheet.getRange(i + 2, hm['Class']).setValue(cls);
      }
      return i + 2;
    }
    if (regNo && nl(rows[i][hm['College'] - 1]) === nl(college) &&
        nl(rows[i][hm['Registration'] - 1]) === nl(regNo)) {
      if (cls && hm['Class'] && String(rows[i][hm['Class'] - 1]) === '') {
        sheet.getRange(i + 2, hm['Class']).setValue(cls);
      }
      return i + 2;
    }
  }
  var row = sheet.getLastRow() + 1;
  sheet.getRange(row, hm['College']).setValue(college);
  sheet.getRange(row, hm['Name']).setValue(name);
  sheet.getRange(row, hm['Registration']).setValue(regNo);
  sheet.getRange(row, hm['Category']).setValue(category);
  if (hm['Class']) sheet.getRange(row, hm['Class']).setValue(cls);
  return row;
}

function findHeaderCol_(sheet, header) {
  if (sheet.getLastColumn() === 0) return 0;
  var first = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (var i = 0; i < first.length; i++) {
    if (headerText_(first[i]) === String(header)) return i + 1;
  }
  return 0;
}

/** If the header already exists more than once (rare write race), fold the later
 *  columns' 'P' cells into the first and delete the duplicates. */
function coalesceColumns_(sheet, header) {
  if (sheet.getLastColumn() === 0) return;
  var first = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cols = [];
  for (var c = 1; c <= first.length; c++) {
    if (headerText_(first[c - 1]) === String(header)) cols.push(c);
  }
  if (cols.length < 2) return;
  var keep = cols[0];
  var last = sheet.getLastRow();
  for (var i = cols.length - 1; i >= 1; i--) {
    var del = cols[i];
    if (last >= 2) {
      var vals = sheet.getRange(2, del, last - 1, 1).getValues();
      for (var r = 0; r < vals.length; r++) {
        if (String(vals[r][0]) === 'P' && sheet.getRange(r + 2, keep).getValue() !== 'P') {
          sheet.getRange(r + 2, keep).setValue('P');
        }
      }
    }
    sheet.deleteColumn(del);
  }
}

/** Merge duplicate date columns (keeps first, folds 'P' cells from later ones)
 *  and backfill Registration/Category into matrix rows from the People sheet. */
function repairAttendance_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Attendance');
  if (!sheet || sheet.getLastRow() === 0) return 0;
  var hm = headerMap_(sheet);
  if (!hm['College']) return 0;

  var first = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var migrated = false;
  for (var n = 0; n < first.length; n++) {
    if (first[n] instanceof Date) {
      var cell = sheet.getRange(1, n + 1);
      cell.setNumberFormat('@');
      cell.setValue(headerText_(first[n]));
      migrated = true;
    }
  }
  if (migrated || sheet.getLastColumn() > first.length) {
    first = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    hm = headerMap_(sheet);
  }
  var seen = {};
  var toMerge = [];
  for (var c = first.length; c >= 1; c--) {
    var h = headerText_(first[c - 1] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) continue;
    if (seen[h] !== undefined) toMerge.push({ from: c, to: seen[h] });
    else seen[h] = c;
  }
  toMerge.sort(function (a, b) { return b.from - a.from; });
  for (var m = 0; m < toMerge.length; m++) {
    var f = toMerge[m];
    var last = sheet.getLastRow();
    if (last >= 2) {
      var vals = sheet.getRange(2, f.from, last - 1, 1).getValues();
      for (var r = 0; r < vals.length; r++) {
        if (String(vals[r][0]) === 'P' && sheet.getRange(r + 2, f.to).getValue() !== 'P') {
          sheet.getRange(r + 2, f.to).setValue('P');
        }
      }
    }
    sheet.deleteColumn(f.from);
  }

  if (toMerge.length) hm = headerMap_(sheet);
  if (!hm['Registration'] || !hm['Category']) return toMerge.length;
  var mergedRows = mergeDuplicateRows_(sheet, hm);

  // Backfill Registration/Category from People where the matrix cell is blank.
  var peopleSheet = ss.getSheetByName('People');
  if (peopleSheet && peopleSheet.getLastRow() >= 2) {
    var phm = headerMap_(peopleSheet);
    var nl = function (s) { return String(s || '').toLowerCase(); };
    var pData = peopleSheet.getRange(2, 1, peopleSheet.getLastRow() - 1, peopleSheet.getLastColumn()).getValues();
    var lookup = {};
    for (var i = 0; i < pData.length; i++) {
      lookup[nl(pData[i][phm['College'] - 1]) + '::' + nl(pData[i][phm['Name'] - 1]) + '::' + nl(pData[i][phm['Category'] - 1])] = pData[i];
    }
    var mRows = sheet.getLastRow() >= 2
      ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
      : [];
    for (var j = 0; j < mRows.length; j++) {
      var key = nl(mRows[j][hm['College'] - 1]) + '::' + nl(mRows[j][hm['Name'] - 1]) + '::' + nl(mRows[j][hm['Category'] - 1]);
      var pr = lookup[key];
      if (!pr) continue;
      if (String(mRows[j][hm['Registration'] - 1]) === '' && pr[phm['Registration'] - 1]) {
        sheet.getRange(j + 2, hm['Registration']).setValue(String(pr[phm['Registration'] - 1]));
      }
      if (String(mRows[j][hm['Category'] - 1]) === '' && pr[phm['Category'] - 1]) {
        sheet.getRange(j + 2, hm['Category']).setValue(String(pr[phm['Category'] - 1]));
      }
      if (hm['Class'] && String(mRows[j][hm['Class'] - 1]) === '' && phm['Class'] && pr[phm['Class'] - 1]) {
        sheet.getRange(j + 2, hm['Class']).setValue(String(pr[phm['Class'] - 1]));
      }
    }
  }

  return toMerge.length;
}

/** If the matrix has 2+ rows for the same college+name+category, fold any 'P'
 *  cells into the row that carries the most reg/class info and delete the extras. */
function mergeDuplicateRows_(sheet, hm) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var nl = function (s) { return String(s || '').toLowerCase(); };
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var dateCols = [];
  for (var c = 1; c <= headers.length; c++) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(headerText_(headers[c - 1]))) dateCols.push(c);
  }
  var colC = hm['College'], colN = hm['Name'], colR = hm['Registration'],
      colCls = hm['Class'], colCat = hm['Category'];
  var rows = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  var groups = {};
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][colN - 1]) continue;
    var key = nl(rows[i][colC - 1]) + '::' + nl(rows[i][colN - 1]) + '::' + nl(rows[i][colCat - 1]);
    if (!groups[key]) groups[key] = [];
    groups[key].push(i);
  }
  var removed = 0;
  var toDelete = [];
  for (var key in groups) {
    var arr = groups[key];
    if (arr.length < 2) continue;
    var keeper = arr[0], best = -1;
    for (var j = 0; j < arr.length; j++) {
      var score = 0;
      if (String(rows[arr[j]][colR - 1] || '')) score += 2;
      if (colCls && String(rows[arr[j]][colCls - 1] || '')) score += 1;
      if (score > best) { best = score; keeper = arr[j]; }
    }
    for (var j2 = 0; j2 < arr.length; j2++) {
      var dup = arr[j2];
      if (dup === keeper) continue;
      for (var d = 0; d < dateCols.length; d++) {
        var dc = dateCols[d];
        if (String(rows[dup][dc - 1]) === 'P' && String(rows[keeper][dc - 1]) !== 'P') {
          sheet.getRange(keeper + 2, dc).setValue('P');
          rows[keeper][dc - 1] = 'P';
        }
      }
      toDelete.push(dup + 2);
      removed++;
    }
  }
  if (toDelete.length) {
    toDelete.sort(function (a, b) { return b - a; });
    for (var t = 0; t < toDelete.length; t++) sheet.deleteRow(toDelete[t]);
  }
  return removed;
}

function attendance_(college) {
  college = String(college || '').trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = matrixSheet_(ss);   // ensure base headers (incl. Class) before repair
  repairAttendance_();
  var hm = headerMap_(sheet);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return headerText_(h); });
  var last = sheet.getLastRow();
  var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  var filtered = college
    ? rows.filter(function (r) { return String(r[hm['College'] - 1]) === college; })
    : rows;
  return { headers: headers, rows: filtered };
}

/** Today's presence per registered person, keyed for the portal automation
 *  (open.js). College-agnostic: matches by registration number. */
function portalAttendance_() {
  var att = attendance_();
  var headers = att.headers;
  var today = date_();
  var regCol = -1, dateCol = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = headerText_(headers[i]);
    if (h === 'Registration') regCol = i;
    if (h === today) dateCol = i;
  }
  var present = {};
  var rows = att.rows || [];
  for (var i = 0; i < rows.length; i++) {
    if (regCol < 0) continue;
    var reg = String(rows[i][regCol] || '').trim().toUpperCase();
    if (!reg) continue;
    present[reg] = dateCol >= 0 && String(rows[i][dateCol]).toUpperCase() === 'P';
  }
  var seen = {};
  var people = people_().map(function (p) {
    var key = String(p.reg || '').trim().toUpperCase();
    return {
      name: p.name,
      registration: String(p.reg || '').trim(),
      category: p.category,
      cls: p.cls,
      present: present[key] ? 1 : 0,
    };
  }).filter(function (p) {
    var k = String(p.registration || '').replace(/\s+/g, '').toUpperCase();
    if (!k) return true;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
  return { ok: true, date: today, people: people };
}

/* ---------------- SHARED ---------------- */

function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sheet;
  }
  var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, sheet.getLastColumn() - missing.length + 1, 1, missing.length).setFontWeight('bold');
  }
  return sheet;
}

function headerMap_(sheet) {
  if (sheet.getLastColumn() === 0) return {};
  var first = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  for (var i = 0; i < first.length; i++) {
    if (first[i]) map[headerText_(first[i])] = i + 1;
  }
  return map;
}

function appendRowByHeaders_(sheet, hm, headers, values) {
  var rowIdx = sheet.getLastRow() + 1;
  for (var i = 0; i < headers.length; i++) {
    var col = hm[headers[i]];
    if (col) sheet.getRange(rowIdx, col).setValue(values[i]);
  }
}

function tokenOk_(sent) {
  var props = PropertiesService.getScriptProperties();
  var real = props.getProperty('TOKEN') || '';
  return real === '' || String(sent) === real;
}

function now_() {
  return Utilities.formatDate(new Date(), Session.getTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}
function date_() {
  return Utilities.formatDate(new Date(), Session.getTimeZone(), 'yyyy-MM-dd');
}

/** Normalize a header cell value to plain text. Sheets often stores
 *  date-like strings as a Date object; this gives us the yyyy-MM-dd string. */
function headerText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getTimeZone(), 'yyyy-MM-dd');
  return String(v);
}
function time_() {
  return Utilities.formatDate(new Date(), Session.getTimeZone(), 'HH:mm:ss');
}
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}