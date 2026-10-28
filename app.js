const MODELS_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights/';

// Use the larger, more accurate detector (slower). Flip to false for low-end phones.
const USE_SSD = true;

const MATCH_THRESHOLD = 0.55;   // FaceNet euclidean distance; lower = stricter
const VERIFY_FRAMES = 4;        // frames a matched face must hold before marking PRESENT
const STABLE_FRAMES = 20;       // enrollment frames; descriptors are averaged

const CATEGORIES = { students: 'student', staff: 'staff' };

let staffRole = 'teacher';         // dropdown in the Teacher/Staff panel
const ROLE_LABELS = { student: 'Student', teacher: 'Teacher', staff: 'Staff' };
function roleLabel(cat) { return ROLE_LABELS[cat] || String(cat || 'Staff'); }

let settings = { url: 'https://script.google.com/macros/s/AKfycbw8Ehd-0ssiaaJ0i9yrvy2r7_c67Wx1qH7cZHGHny0VR9C3PZRO2C9gsw0PAy_hQSk/exec', token: '' };
let enrolled = [];              // { name, reg, category, descriptor }
let session = null;
let authMode = 'login';
let category = CATEGORIES.students;
let cam = { video: null, overlay: null, ctx: null };
let scanning = false;
let enrolling = false;
let enrollSubmitting = false;
let sessionLogged = new Set();
let modelsReady = false;
let tab = 'students';

const $ = (id) => document.getElementById(id);

function saveSettings() {
  localStorage.setItem('faceatt_config', JSON.stringify(settings));
}
function loadSettings() {
  try {
    const raw = localStorage.getItem('faceatt_config');
    if (raw) {
      const stored = JSON.parse(raw);
      if (stored && stored.url) settings.url = stored.url;
      if (stored && typeof stored.token !== 'undefined') settings.token = stored.token;
    }
  } catch (e) { /* ignore */ }
}

/* ---------------- AUTH ---------------- */
const SESSION_KEY = 'faceatt_session';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) session = JSON.parse(raw);
  } catch (e) { /* ignore */ }
}
function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(session || {})); }
function clearSession() { localStorage.removeItem(SESSION_KEY); session = null; }

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setAuthMsg(text, cls) {
  const el = $('auth-msg');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function applyAuthMode() {
  const isLogin = authMode === 'login';
  $('auth-title').textContent = isLogin ? 'College Log in' : 'College Sign up';
  $('auth-name').style.display = isLogin ? 'none' : 'block';
  $('auth-pin').style.display = isLogin ? 'none' : 'block';
  $('auth-submit').textContent = isLogin ? 'Log in' : 'Sign up';
  $('auth-toggle').textContent = isLogin ? 'Need an account? Sign up' : 'Already registered? Log in';
  setAuthMsg('', '');
}

function enterApp() {
  $('user-label').textContent = session.name;
  $('auth-modal').style.display = 'none';
  $('app').classList.remove('hidden');
  startSync();
}

function logout() {
  flushMarks();
  stopSync();
  clearSession();
  scanning = false;
  autoScanStarted = false;
  $('app').classList.add('hidden');
  $('auth-modal').style.display = 'flex';
  authMode = 'login';
  applyAuthMode();
}

async function authSubmit() {
  const email = $('auth-email').value.trim();
  const pwd = $('auth-pwd').value;
  const name = $('auth-name').value.trim();
  const recoveryPin = $('auth-pin').value.trim();
  if (!email || !pwd) { setAuthMsg('Enter email and password.', 'err'); return; }
  if (pwd.length < 6) { setAuthMsg('Password must be at least 6 characters.', 'err'); return; }
  if (authMode === 'signup' && !name) { setAuthMsg('Enter your full name.', 'err'); return; }
  if (authMode === 'signup' && recoveryPin && recoveryPin.length < 4) { setAuthMsg('Recovery PIN must be at least 4 characters.', 'err'); return; }
  $('auth-submit').disabled = true;
  try {
    const passwordHash = await sha256Hex(pwd);
    if (authMode === 'signup') {
      const res = await api('signup', { name, email, passwordHash, role: 'college', recoveryPin });
      if (!res.ok) { setAuthMsg(res.error || 'Signup failed.', 'err'); return; }
    }
    const res = await api('login', { email, passwordHash });
    if (!res.ok) { setAuthMsg(res.error || 'Login failed.', 'err'); return; }
    session = res.user;
    saveSession();
    enterApp();
    if (session && session.email) {
      try { await loadEnrolled(); } catch (e) { setStatus('People list load failed: ' + e.message, 'err'); }
    }
    beginAutoScan();
  } catch (e) {
    setAuthMsg(e.message, 'err');
  } finally {
    $('auth-submit').disabled = false;
  }
}

/* ---------------- FORGOT PASSWORD ---------------- */
let rstMode = 'code';

function setRstMode(mode) {
  rstMode = mode;
  const isPin = mode === 'pin';
  $('rst-code-row').style.display = isPin ? 'none' : 'block';
  $('rst-pin-row').style.display = isPin ? 'block' : 'none';
  $('rst-toggle').textContent = isPin ? 'Use email reset code instead' : 'Use recovery PIN instead';
}

function showForgotPanel(show) {
  $('forgot-panel').classList.toggle('hidden', !show);
  $('auth-forgot').style.display = show ? 'none' : '';
  setRstMode('code');
  if (!show) {
    $('rst-email').value = '';
    $('rst-code').value = '';
    $('rst-pin').value = '';
    $('rst-pwd').value = '';
  }
  setAuthMsg('', '');
}

async function sendResetCode() {
  const email = $('rst-email').value.trim();
  if (!email) { setAuthMsg('Enter your registered email.', 'err'); return; }
  const btn = $('rst-send');
  btn.disabled = true;
  btn.textContent = 'Sending\u2026';
  try {
    const res = await api('sendResetCode', { email });
    if (!res.ok) { setAuthMsg(res.error || 'Could not send the code.', 'err'); return; }
    setAuthMsg('Reset code sent to ' + email + '. Check the mailbox (and spam).');
  } catch (e) {
    setAuthMsg(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send reset code';
  }
}

async function submitReset() {
  const email = $('rst-email').value.trim();
  const code = $('rst-code').value.trim();
  const pin = $('rst-pin').value.trim();
  const pwd = $('rst-pwd').value;
  if (!email) { setAuthMsg('Enter your registered email.', 'err'); return; }
  if (rstMode === 'pin') {
    if (pin.length < 4) { setAuthMsg('Enter your recovery PIN.', 'err'); return; }
  } else if (!code) {
    setAuthMsg('Enter the 6-digit code.', 'err'); return;
  }
  if (pwd.length < 6) { setAuthMsg('New password must be at least 6 characters.', 'err'); return; }
  const btn = $('rst-submit');
  btn.disabled = true;
  try {
    const passwordHash = await sha256Hex(pwd);
    const payload = rstMode === 'pin'
      ? { email, pin, newPasswordHash: passwordHash }
      : { email, code, newPasswordHash: passwordHash };
    const res = await api(rstMode === 'pin' ? 'resetWithPin' : 'resetPassword', payload);
    if (!res.ok) { setAuthMsg(res.error || 'Reset failed.', 'err'); return; }
    showForgotPanel(false);
    setAuthMsg('Password updated. Logging you in\u2026');
    const login = await api('login', { email, passwordHash });
    if (!login.ok) { setAuthMsg(login.error || 'Please log in with your new password.', 'err'); return; }
    session = login.user;
    saveSession();
    enterApp();
  } catch (e) {
    setAuthMsg(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- API ---------------- */
async function api(action, payload) {
  if (!settings.url) throw new Error('Apps Script URL not set. Open settings.');
  const res = await fetch(settings.url, {
    method: 'POST',
    body: JSON.stringify(Object.assign({ action, device: 'phone', token: settings.token }, payload)),
  });
  if (!res.ok) throw new Error('Server error ' + res.status);
  return res.json();
}

function myCollege() { return session ? session.name : ''; }

/* ---------------- DESCRIPTORS ---------------- */
function encodeDescriptor(d) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(d.buffer)));
}
function decodeDescriptor(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const f = new Float32Array(128);
  f.set(new Float32Array(bytes.buffer));
  return f;
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

function matchFace(desc, list) {
  let best = null, bestDist = Infinity;
  for (const p of list) {
    const d = distance(desc, p.descriptor);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (!best || bestDist > MATCH_THRESHOLD) return null;
  return { person: best, distance: bestDist };
}

function enrolledOf(cat) {
  return enrolled.filter((p) => p.category === cat);
}

async function loadEnrolled() {
  const data = await api('people', { college: myCollege() });
  enrolled = (data.people || []).map((p) => ({
    name: p.name,
    reg: p.reg || '',
    cls: p.cls || '',
    category: p.category || 'student',
    descriptor: decodeDescriptor(p.descriptor),
  }));
  setStatus('Ready. ' + enrolled.length + ' face(s) registered (my college).' +
    ' Students: ' + enrolledOf('student').length + ', Staff: ' + enrolledOf('staff').length + '.');
}

/* ---------------- CAMERA ---------------- */
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  cam.video.srcObject = stream;
  await cam.video.play();
}

function drawFrame(displays) {
  if (!cam.overlay) return;
  cam.overlay.width = cam.video.videoWidth;
  cam.overlay.height = cam.video.videoHeight;
  cam.ctx.clearRect(0, 0, cam.overlay.width, cam.overlay.height);
  for (const d of displays) {
    const b = d.box;
    cam.ctx.strokeStyle = d.color || '#00c853';
    cam.ctx.lineWidth = 3;
    cam.ctx.strokeRect(b.x, b.y, b.width, b.height);
    cam.ctx.fillStyle = 'rgba(0,200,83,0.85)';
    cam.ctx.font = '15px sans-serif';
    cam.ctx.fillText(d.label, b.x, b.y - 8);
  }
}

function detect() {
  if (cam.video.readyState < 2) return Promise.resolve([]);
  const opts = USE_SSD
    ? new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
    : new faceapi.TinyFaceDetectorOptions({ inputSize: 320 });
  return faceapi
    .detectAllFaces(cam.video, opts)
    .withFaceLandmarks()
    .withFaceDescriptors()
    .then((r) => r.map((det) => ({ box: det.detection.box, descriptor: det.descriptor })));
}

/* ---------------- ENROLL ---------------- */
async function runEnroll(cat) {
  if (!modelsReady) { setStatus('AI models still loading\u2026', 'err'); return; }
  if (enrolling) {
    enrolling = false;
    buttonFor('enroll', cat).textContent = cat === 'student' ? 'Register student' : 'Register';
    setStatus('Enrollment cancelled.');
    return;
  }
  if (scanning) {
    scanning = false;
    resetScanButtons();
    setStatus('Stopped scanning to register a face.');
  }

  let name, reg = '', cls = '';
  if (cat === 'student') {
    name = $('stu-name').value.trim();
    reg = $('stu-reg').value.trim();
    cls = $('stu-class').value.trim();
    if (!name) { setStatus('Enter the student name.', 'err'); return; }
    if (!reg) { setStatus('Enter the registration number.', 'err'); return; }
    if (!cls) { setStatus('Enter the class / section.', 'err'); return; }
  } else {
    name = $('staff-name').value.trim();
    reg = $('staff-reg').value.trim();
    if (!name) { setStatus('Enter the name.', 'err'); return; }
    if (!reg) { setStatus('Enter the registration number.', 'err'); return; }
  }

  const catList = enrolledOf(cat);
  const existing = catList.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    // Re-registering an existing name updates their class/reg/face.
    setStatus('Updating existing registration \u2026');
  }
  if (reg && enrolled.some((p) => p.reg && p.reg.toLowerCase() === reg.toLowerCase() &&
      !(p.category === cat && p.name.toLowerCase() === name.toLowerCase()))) {
    setStatus('Registration number already registered to someone else.', 'err');
    return;
  }

  enrolling = true;
  let enrollDone = false;
  buttonFor('enroll', cat).textContent = 'Cancel';
  setStatus('Keep steady, face the camera (' + roleLabel(cat).toLowerCase() + ')\u2026');

  let stableCounter = 0;
  let lastDesc = null;
  let descBuffer = [];

  (async function enrollLoop() {
    while (enrolling && !enrollDone) {
      const detections = await detect();
      const displays = detections.map((d) => ({ box: d.box, label: '...' }));
      if (detections.length === 1) {
        const desc = detections[0].descriptor;
        const same = lastDesc ? distance(desc, lastDesc) < 0.7 : false;
        lastDesc = desc;
        if (same) {
          stableCounter++;
          descBuffer.push(desc);
          if (descBuffer.length > STABLE_FRAMES + 5) descBuffer.shift();
        } else {
          stableCounter = 1;
          descBuffer = [desc];
        }
        displays[0].label = 'Hold still ' + stableCounter + '/' + STABLE_FRAMES;
        if (stableCounter >= STABLE_FRAMES) {
          enrollDone = true;
          await sustainEnroll(cat, name, reg, cls, averageDescriptor(descBuffer));
          return;
        }
      } else {
        stableCounter = 0;
        lastDesc = null;
        descBuffer = [];
        displays.forEach((d) => (d.label = detections.length > 1 ? 'Remove other faces' : 'Show your face'));
      }
      drawFrame(displays);
      await sleep(90);
    }
  })().catch((e) => { setStatus('Enrollment failed: ' + e.message, 'err'); });
}

function averageDescriptor(list) {
  const avg = new Float32Array(128);
  for (const d of list) for (let i = 0; i < 128; i++) avg[i] += d[i];
  for (let i = 0; i < 128; i++) avg[i] /= list.length;
  return avg;
}

async function sustainEnroll(cat, name, reg, cls, desc) {
  if (enrollSubmitting) return;
  enrollSubmitting = true;
  enrolling = false;
  setStatus('Saving\u2026');
  const wasExisting = enrolled.some((p) =>
    p.category === cat && p.name.toLowerCase() === name.toLowerCase());
  try {
    const res = await api('enroll', {
      college: myCollege(), name, regNo: reg, cls, category: cat, descriptor: encodeDescriptor(desc),
    });
    if (res.ok) {
      enrolled = enrolled.filter((p) => !(p.name.toLowerCase() === name.toLowerCase() && p.category === cat));
      enrolled.push({ name, reg, cls, category: cat, descriptor: desc });
      setStatus((wasExisting ? 'Updated ' : 'Registered ') + name +
        (reg ? ' (' + reg + (cls ? ', ' + cls : '') + ')' : ''));
      if (cat === 'student') { $('stu-name').value = ''; $('stu-reg').value = ''; $('stu-class').value = ''; }
      else { $('staff-name').value = ''; $('staff-reg').value = ''; }
    } else {
      setStatus('Register failed: ' + (res.error || ''), 'err');
    }
  } catch (e) {
    setStatus('Register failed: ' + e.message, 'err');
  } finally {
    enrollSubmitting = false;
  }
  buttonFor('enroll', cat).textContent = cat === 'student' ? 'Register student' : 'Register';
}

/* ---------------- SCAN ---------------- */
let autoScanStarted = false;

function resetScanButtons() {
  $('scan-student').textContent = 'Start scanning (all)';
  $('scan-staff').textContent = 'Start scanning (all)';
}

async function beginAutoScan() {
  if (autoScanStarted) return;
  autoScanStarted = true;
  while (!modelsReady || !cam.video || cam.video.readyState < 2) await sleep(250);
  if (scanning || enrolling) { autoScanStarted = false; return; }
  if (enrolled.length === 0) {
    autoScanStarted = false;
    setStatus('Logged in. No faces registered yet \u2014 register students / teacher / staff first.');
    return;
  }
  runScan();
}

async function runScan() {
  if (!modelsReady) { setStatus('AI models still loading\u2026', 'err'); return; }
  if (enrolling) {
    enrolling = false;
    buttonFor('enroll', 'student').textContent = 'Register student';
    buttonFor('enroll', 'staff').textContent = 'Register';
  }
  scanning = !scanning;
  const label = scanning ? 'Stop scanning (all)' : 'Start scanning (all)';
  $('scan-student').textContent = label;
  $('scan-staff').textContent = label;
  if (!scanning) { setStatus('Stopped.'); return; }

  if (enrolled.length === 0) {
    scanning = false;
    resetScanButtons();
    setStatus('No faces registered yet. Register students / teacher / staff first.', 'err');
    return;
  }

  sessionLogged = new Set();
  const pending = {};
  clearLog('all');
  setStatus('Scanning all (students, teachers, staff) \u2026 hold each face steady 1 second.');
  while (scanning) {
    const detections = await detect();
    const displays = [];
    const seenThisFrame = new Set();
    for (const det of detections) {
      const match = matchFace(det.descriptor, enrolled);
      if (match) {
        const key = match.person.category + '::' + match.person.name.toLowerCase();
        seenThisFrame.add(key);
        pending[key] = (pending[key] || 0) + 1;
        if (pending[key] >= VERIFY_FRAMES) {
          const conf = Math.round((1 - match.distance) * 100);
          displays.push({ box: det.box, label: match.person.name + ' ' + conf + '%', color: '#00c853' });
          if (!sessionLogged.has(key)) {
            sessionLogged.add(key);
            queueMark(match.person, match.person.category);
          }
        } else {
          displays.push({ box: det.box, label: 'confirming\u2026', color: '#facc15' });
        }
      } else {
        displays.push({ box: det.box, label: 'unknown', color: '#f87171' });
      }
    }
    for (const k in pending) if (!seenThisFrame.has(k)) pending[k] = 0;
    drawFrame(displays);
    await sleep(80);
  }
  await flushMarks();
  resetScanButtons();
}

/* ---------------- LOCAL QUEUE + BATCHED SYNC ---------------- */
const SYNC_INTERVAL_MS = 30000; // flush local marks to the server every 30s
let pendingMarks = new Map();   // key -> { name, reg, category }
let syncTimer = null;
let syncFailures = 0;
let syncing = false;

function queueMark(person, cat) {
  const key = cat + '::' + person.name.toLowerCase();
  if (pendingMarks.has(key)) return;
  pendingMarks.set(key, { name: person.name, reg: person.reg || '', cls: person.cls || '', category: cat });
  appendLog(person.name + (person.reg ? ' [' + person.reg + ']' : '') + ' saved locally, syncing in \u226430s', cat);
}

async function flushMarks() {
  if (syncing || !pendingMarks.size) return;
  syncing = true;
  const marks = Array.from(pendingMarks.values());
  pendingMarks.clear();
  try {
    const res = await api('scanBatch', {
      college: myCollege(),
      marks: marks.map((m) => ({ name: m.name, regNo: m.reg, cls: m.cls, category: m.category })),
    });
    if (!res || res.ok === false) throw new Error((res && res.error) || 'server did not accept batch');
    const results = res.results || [];
    if (!results.length) throw new Error('server returned no results');
    syncFailures = 0;
    for (const r of results) {
      if (!r || !r.name) continue;
      if (r.error) {
        appendLog(r.name + ' sync failed: ' + r.error, r.category || 'student');
      } else {
        appendLog(r.name + ' ' + (r.added ? 'P marked on sheet' : 'already P today'),
          r.category || 'student');
      }
    }
  } catch (e) {
    syncFailures++;
    if (syncFailures > 60) {
      appendLog('Giving up syncing ' + marks.length + ' mark(s): ' + e.message,
        marks[0] && marks[0].category);
      return;
    }
    marks.forEach((m) => pendingMarks.set(m.category + '::' + m.name.toLowerCase(), m));
    appendLog('Sync failed (' + e.message + '), will retry\u2026', marks[0] && marks[0].category);
  } finally {
    syncing = false;
    if (pendingMarks.size) setTimeout(() => flushMarks(), 5000);
  }
}

function startSync() {
  stopSync();
  syncTimer = setInterval(() => flushMarks(), SYNC_INTERVAL_MS);
}

function stopSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

/* ---------------- UI helpers ---------------- */
function setStatus(text, cls) {
  const el = $('app-status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function clearLog(cat) {
  if (cat === 'all') {
    if ($('scan-log')) $('scan-log').innerHTML = '';
    if ($('staff-log')) $('staff-log').innerHTML = '';
    return;
  }
  const el = cat === 'student' ? $('scan-log') : $('staff-log');
  if (el) el.innerHTML = '';
}

function appendLog(text, cat) {
  const div = document.createElement('div');
  div.textContent = text;
  const el = (cat === 'student') ? $('scan-log') : $('staff-log');
  if (el) el.prepend(div);
}

function buttonFor(kind, cat) {
  return $(kind === 'enroll'
    ? (cat === 'student' ? 'enroll-student' : 'enroll-staff')
    : (cat === 'student' ? 'scan-student' : 'scan-staff'));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadReport() {
  const list = $('report-list');
  list.innerHTML = 'Loading\u2026';
  try {
    const res = await api('attendance', { college: myCollege() });
    const matrix = res.matrix || { headers: [], rows: [] };
    const hdrs = matrix.headers;
    const rows = matrix.rows || [];
    if (!rows.length) { list.innerHTML = 'No registered students/staff yet.'; return; }
    const nameI = hdrs.indexOf('Name');
    const regI = hdrs.indexOf('Registration');
    const catI = hdrs.indexOf('Category');
    const clsI = hdrs.indexOf('Class');
    const dateCols = hdrs
      .map((h, i) => ({ h: String(h || ''), i }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.h));
    const today = new Date().toISOString().slice(0, 10);
    list.innerHTML = '<div class="key">Green = present today \u00b7 P = marked</div>' +
      rows.map((r) => {
        const name = nameI >= 0 ? r[nameI] : '', reg = regI >= 0 ? r[regI] : '',
          cat = catI >= 0 ? r[catI] : '', cls = clsI >= 0 ? r[clsI] : '';
        const chips = dateCols.map((d) => {
          const v = r[d.i];
          const isP = v === 'P';
          const isToday = d.h === today;
          return '<span class="chip' + (isP ? ' on' : '') + (isToday ? ' today' : '') + '" title="' + d.h + '">' +
            (isP ? 'P' : isToday ? '-' : '') + '</span>';
        }).join('');
        return '<div class="row"><div><b>' + name + '</b> <em class="tag">' + roleLabel(cat) + '</em>' +
          (cls ? ' <em class="tag">' + cls + '</em>' : '') +
          '<div class="sub">' + (reg || '') + '</div></div><div class="chips">' + chips + '</div></div>';
      }).join('');
  } catch (e) {
    list.innerHTML = 'Error: ' + e.message;
  }
}

function switchTab(name) {
  tab = name;
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  $('panel-' + name).classList.add('active');
  $('tab-' + name).classList.add('active');
  if (name === 'students' || name === 'staff') category = CATEGORIES[name];
  if (name === 'report') loadReport();
}

const SETTINGS_ADMIN_PWD = 'Vik@8604';

function promptSettingsAuth() {
  $('admin-pwd-input').value = '';
  $('admin-pwd-msg').style.display = 'none';
  $('admin-modal').classList.remove('hidden');
  setTimeout(() => $('admin-pwd-input').focus(), 100);
}

function verifySettingsPassword() {
  const pwd = $('admin-pwd-input').value;
  if (pwd === SETTINGS_ADMIN_PWD) {
    $('admin-modal').classList.add('hidden');
    $('cfg-url').value = settings.url;
    $('cfg-token').value = settings.token;
    $('settings-modal').classList.remove('hidden');
  } else {
    $('admin-pwd-msg').textContent = 'Incorrect password! Access denied.';
    $('admin-pwd-msg').style.display = 'block';
  }
}

function openSettings() {
  promptSettingsAuth();
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

/* ---------------- wire up ---------------- */
$('admin-pwd-submit').onclick = verifySettingsPassword;
$('admin-pwd-cancel').onclick = () => $('admin-modal').classList.add('hidden');
$('admin-pwd-input').onkeydown = (e) => {
  if (e.key === 'Enter') verifySettingsPassword();
};
$('tab-students').onclick = () => switchTab('students');
$('tab-staff').onclick = () => switchTab('staff');
$('tab-report').onclick = () => switchTab('report');
$('refresh-btn').onclick = loadReport;
$('settings-btn').onclick = openSettings;
$('auth-settings').onclick = openSettings;
$('cfg-cancel').onclick = closeSettings;
$('cfg-save').onclick = () => {
  settings.url = $('cfg-url').value.trim();
  settings.token = $('cfg-token').value.trim();
  saveSettings();
  closeSettings();
};
$('auth-submit').onclick = authSubmit;
$('auth-forgot').onclick = () => showForgotPanel(true);
$('rst-send').onclick = sendResetCode;
$('rst-submit').onclick = submitReset;
$('rst-toggle').onclick = () => setRstMode(rstMode === 'pin' ? 'code' : 'pin');
$('rst-cancel').onclick = () => showForgotPanel(false);
$('auth-toggle').onclick = () => {
  authMode = authMode === 'login' ? 'signup' : 'login';
  applyAuthMode();
};
$('logout-btn').onclick = logout;
$('enroll-student').onclick = () => runEnroll('student');
$('enroll-staff').onclick = () => runEnroll(staffRole);
$('scan-student').onclick = () => runScan();
$('scan-staff').onclick = () => runScan();
$('stf-role').onchange = () => { staffRole = $('stf-role').value; };

(async function init() {
  loadSettings();
  loadSession();
  cam.video = $('cam');
  cam.overlay = $('overlay');
  cam.ctx = $('overlay').getContext('2d');
  resetScanButtons();

  if (session && session.email) enterApp();
  else { authMode = 'login'; applyAuthMode(); }

  try {
    if (USE_SSD) await faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS_URL);
    else await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL);
    modelsReady = true;
  } catch (e) {
    setStatus('AI models failed to load (need internet first): ' + e.message, 'err');
    return;
  }

  try {
    await startCamera();
    setStatus('Ready.');
  } catch (e) {
    const msg = 'Camera unavailable (' + e.message + '). ';
    if (!settings.url) {
      setStatus(msg + 'Add the Apps Script URL in Settings.', 'err');
      openSettings();
    } else {
      setStatus(msg, 'err');
    }
    return;
  }

  if (session && session.email) {
    try { await loadEnrolled(); } catch (e) { setStatus('People list load failed: ' + e.message, 'err'); }
    beginAutoScan();
  }
})();