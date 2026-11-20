/**
 * ระบบลงเวลาทำงานของคุณครู — Google Apps Script (Code.gs)
 * --------------------------------------------------------
 * - ข้อมูลการลงเวลา  : Google Sheets (ชีต "Logs")
 * - ลายมือชื่อ        : Google Drive (โฟลเดอร์ TeacherAttendance_Signatures)
 * - ตั้งค่าเขตพื้นที่  : Script Properties
 *
 * หน้าเว็บ (index.html) เก็บไว้บน GitHub แล้วให้ Apps Script ดึงมาแสดงผ่าน doGet()
 *   - แก้หน้าเว็บ: แก้ไฟล์ index.html บน GitHub แล้ว commit (ไม่ต้อง Deploy Apps Script ใหม่)
 *   - แก้ระบบหลังบ้าน: แก้ Code.gs ในนี้ตามเดิม
 *
 * วิธีใช้: ตั้งค่า GITHUB ด้านล่าง → รัน setup() หนึ่งครั้งเพื่ออนุญาตสิทธิ์ → Deploy เป็น Web app
 * (ถ้าอยากมีตัวสำรอง ให้สร้างไฟล์ HTML ชื่อ "Index" ในโปรเจกต์ไว้ ระบบจะใช้เมื่อดึงจาก GitHub ไม่ได้)
 */

const APP = {
  TITLE: 'ระบบลงเวลาทำงานของคุณครู',
  TZ: 'Asia/Bangkok',
  SHEET_LOGS: 'Logs',
  SIG_FOLDER_NAME: 'TeacherAttendance_Signatures',
  MAX_LOGS: 1000,            // จำนวนรายการล่าสุดที่ส่งให้หน้าเว็บ
  ADMIN_PIN: '',             // ตั้งรหัสแอดมิน เช่น '1234' (เว้นว่าง = ไม่ใช้รหัส)
  MAX_SIGNATURE_CHARS: 700000
};

// ที่เก็บไฟล์ index.html บน GitHub
const GITHUB = {
  OWNER: 'YOUR_GITHUB_USERNAME',   // ชื่อบัญชี/องค์กรบน GitHub
  REPO: 'YOUR_REPO_NAME',          // ชื่อ repository
  BRANCH: 'main',                  // branch ที่ใช้
  PATH: 'index.html',              // ที่อยู่ไฟล์ใน repo
  CACHE_SECONDS: 300               // แคชหน้าเว็บไว้ 5 นาที (ให้เปิดเร็วและไม่เกินโควตา)
};

// รายชื่อครูจากสเปรดชีตภายนอก
const TEACHER_SOURCE = {
  SPREADSHEET_ID: '1Tj9JQifnNfgHxo9Rn-sxWSwppQwUeUGvMInIAzxu994',
  SHEET_NAME: 'teacher',
  COLUMN: 2,            // คอลัมน์ B = ชื่อ - สกุล
  CACHE_SECONDS: 300    // แคชรายชื่อ 5 นาที
};

const DEFAULT_CONFIG = {
  placeName: 'โรงเรียนอนุบาลชุมชนหนองบัวแดง',
  lat: 16.0772,
  lng: 101.8022,
  radius: 200
};

const LOG_HEADERS = [
  'ID', 'Timestamp', 'วันที่', 'เวลา', 'ชื่อ-นามสกุล',
  'ประเภท', 'Latitude', 'Longitude', 'ระยะห่าง (ม.)', 'Signature ID'
];

/* ======================== Web App ======================== */

function doGet(e) {
  ensureSetup_();
  const bypass = !!(e && e.parameter && e.parameter.nocache);   // เปิดด้วย ?nocache=1 เพื่อข้ามแคช

  let out;
  try {
    out = HtmlService.createHtmlOutput(loadIndexHtml_(bypass));
  } catch (err) {
    // ดึงจาก GitHub ไม่ได้ → ใช้ไฟล์ "Index" ในโปรเจกต์เป็นตัวสำรอง (ถ้ามี)
    try {
      out = HtmlService.createHtmlOutputFromFile('Index');
    } catch (e2) {
      out = HtmlService.createHtmlOutput(errorPage_(err));
    }
  }
  out
    .setTitle(APP.TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  // ไอคอนแท็บ/ทางลัด: ใช้ icons/favicon.png จาก GitHub (เฉพาะ repo แบบ Public)
  try {
    const icon = iconUrl_('icons/favicon.png');
    if (icon) out.setFaviconUrl(icon);
  } catch (e) {}
  return out;
}

/** URL ไฟล์ไอคอนใน repo (คืนค่าว่างถ้ายังไม่ได้ตั้งค่า หรือเป็น repo Private) */
function iconUrl_(path) {
  if (!GITHUB.OWNER || /^YOUR_/.test(GITHUB.OWNER) || /^YOUR_/.test(GITHUB.REPO)) return '';
  if (PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN')) return '';
  return 'https://raw.githubusercontent.com/' + GITHUB.OWNER + '/' + GITHUB.REPO + '/' +
         GITHUB.BRANCH + '/' + path;
}

/* ======================== ดึงหน้าเว็บจาก GitHub ======================== */

function loadIndexHtml_(bypassCache) {
  const cache = CacheService.getScriptCache();
  const key = 'index_html_v1';
  if (!bypassCache) {
    const hit = getChunked_(cache, key);
    if (hit) return hit;
  }
  const html = fetchGithubHtml_();
  try { putChunked_(cache, key, html, GITHUB.CACHE_SECONDS); } catch (e) {}
  return html;
}

function fetchGithubHtml_() {
  if (!GITHUB.OWNER || /^YOUR_/.test(GITHUB.OWNER) || /^YOUR_/.test(GITHUB.REPO)) {
    throw new Error('ยังไม่ได้ตั้งค่า GITHUB (OWNER / REPO) ใน Code.gs');
  }
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  let url, headers = {};
  if (token) {
    // repo แบบ Private: ใช้ GitHub API พร้อม token (เก็บใน Script Properties ชื่อ GITHUB_TOKEN)
    url = 'https://api.github.com/repos/' + GITHUB.OWNER + '/' + GITHUB.REPO +
          '/contents/' + GITHUB.PATH + '?ref=' + encodeURIComponent(GITHUB.BRANCH);
    headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw' };
  } else {
    // repo แบบ Public
    url = 'https://raw.githubusercontent.com/' + GITHUB.OWNER + '/' + GITHUB.REPO + '/' +
          GITHUB.BRANCH + '/' + GITHUB.PATH;
  }
  const res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true, followRedirects: true });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('ดึงไฟล์จาก GitHub ไม่สำเร็จ (HTTP ' + code + ') : ' + url);
  const text = res.getContentText('UTF-8');
  if (!/<html[\s>]/i.test(text)) throw new Error('ไฟล์จาก GitHub ไม่ใช่หน้า HTML');
  return text;
}

// CacheService เก็บได้ไม่เกิน ~100KB ต่อคีย์ จึงแบ่งเป็นชิ้น (ภาษาไทย 1 ตัว = 3 ไบต์)
function putChunked_(cache, key, text, seconds) {
  const SIZE = 30000;
  const parts = {};
  let n = 0;
  for (let i = 0; i < text.length; i += SIZE) parts[key + ':' + (n++)] = text.substring(i, i + SIZE);
  parts[key + ':n'] = String(n);
  cache.putAll(parts, seconds);
}

function getChunked_(cache, key) {
  const n = Number(cache.get(key + ':n'));
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  const got = cache.getAll(keys);
  let out = '';
  for (let i = 0; i < n; i++) {
    const part = got[key + ':' + i];
    if (part === undefined || part === null) return null;
    out += part;
  }
  return out;
}

/** ล้างแคชหน้าเว็บทันที (รันจากตัวแก้ไขสคริปต์ เมื่ออยากให้หน้าใหม่ขึ้นเลย) */
function clearHtmlCache() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('index_html_v1:n')) || 0;
  const keys = ['index_html_v1:n'];
  for (let i = 0; i < n; i++) keys.push('index_html_v1:' + i);
  cache.removeAll(keys);
  Logger.log('ล้างแคชแล้ว');
}

function errorPage_(err) {
  const msg = String(err && err.message ? err.message : err)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:sans-serif;background:#F4F2FF;color:#2B2170;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}' +
    '.c{background:#fff;border-radius:24px;padding:28px;max-width:440px;box-shadow:0 20px 50px -20px rgba(45,32,140,.4)}' +
    'h1{font-size:20px;margin:0 0 8px}p{margin:6px 0;color:#475569;font-size:14px;line-height:1.6}code{font-size:12px;word-break:break-all;color:#B91C1C}</style></head>' +
    '<body><div class="c"><h1>เปิดหน้าระบบไม่ได้ชั่วคราว</h1>' +
    '<p>ระบบดึงหน้าเว็บจาก GitHub ไม่สำเร็จ กรุณาลองรีเฟรชอีกครั้ง หรือแจ้งผู้ดูแลระบบ</p>' +
    '<p><code>' + msg + '</code></p></div></body></html>';
}

/** รันครั้งเดียวจากตัวแก้ไขสคริปต์ เพื่อสร้างชีต/โฟลเดอร์และขอสิทธิ์ */
function setup() {
  ensureSetup_();
  Logger.log('Spreadsheet: ' + getSpreadsheet_().getUrl());
  Logger.log('จำนวนครูในชีตรายชื่อ: ' + readTeachers_().length);
  Logger.log('Signature folder: ' + getSigFolder_().getUrl());
  try {
    Logger.log('GitHub index.html: ดึงได้ ' + fetchGithubHtml_().length + ' ตัวอักษร');
  } catch (e) {
    Logger.log('GitHub: ' + e.message);
  }
}

/* ======================== API สำหรับหน้าเว็บ ======================== */

function getInitData() {
  ensureSetup_();
  return {
    sheetUrl: getSpreadsheet_().getUrl(),
    config: getConfig_(),
    logs: readLogs_(),
    pinRequired: !!APP.ADMIN_PIN
  };
}

/** รายชื่อครู (ชื่อ - สกุล) จากชีต teacher คอลัมน์ B */
function getTeachers() {
  return readTeachers_();
}

/** เวลาปัจจุบันของเซิร์ฟเวอร์ (มิลลิวินาที) ใช้ซิงค์นาฬิกาหน้าเว็บ */
function getServerTime() {
  return new Date().getTime();
}

function getLogs() {
  return readLogs_();
}

function addLog(p) {
  if (!p) throw new Error('ไม่พบข้อมูล');

  let fullname = String(p.fullname || '').trim().slice(0, 120);
  const type = String(p.type || '');
  const lat = Number(p.lat);
  const lng = Number(p.lng);

  if (!fullname) throw new Error('กรุณากรอกชื่อ-นามสกุล');

  // ต้องเป็นชื่อที่มีอยู่ในชีตครู (ถ้าอ่านรายชื่อไม่ได้ จะข้ามการตรวจ)
  let teachers = null;
  try { teachers = readTeachers_(); } catch (e) {}
  if (teachers && teachers.length) {
    const key = normName_(fullname);
    const found = teachers.filter(function (n) { return normName_(n) === key; })[0];
    if (!found) throw new Error('ไม่พบชื่อนี้ในรายชื่อครู กรุณาเลือกชื่อจากรายการ');
    fullname = found;
  }
  if (type !== 'เข้างาน' && type !== 'ออกงาน') throw new Error('ประเภทการลงเวลาไม่ถูกต้อง');
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('พิกัดไม่ถูกต้อง');
  }

  // ลายมือชื่อเป็นตัวเลือก: บันทึกเวลาลงชีตก่อน แล้วค่อยแนบลายมือชื่อภายหลังด้วย addSignature()
  const sig = String(p.signature || '');
  if (sig) {
    if (!/^data:image\/png;base64,/.test(sig)) throw new Error('รูปแบบลายมือชื่อไม่ถูกต้อง');
    if (sig.length > APP.MAX_SIGNATURE_CHARS) throw new Error('ไฟล์ลายมือชื่อมีขนาดใหญ่เกินไป');
  }

  const cfg = getConfig_();
  const distance = haversine_(cfg.lat, cfg.lng, lat, lng);
  if (distance > cfg.radius) {
    throw new Error('อยู่นอกเขตพื้นที่ (ห่าง ' + distance + ' ม. เกินรัศมี ' + cfg.radius + ' ม.)');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const now = new Date();
    const id = 'rec-' + now.getTime() + '-' + Math.floor(Math.random() * 1000);
    const rec = {
      id: id,
      timestamp: Math.floor(now.getTime() / 1000),
      date: thaiDate_(now),
      time: Utilities.formatDate(now, APP.TZ, 'HH:mm:ss'),
      fullname: fullname,
      type: type,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      distance: distance,
      sigId: ''
    };

    // ถ้าส่งลายมือชื่อมาด้วย ให้บันทึกลง Google Drive (ถ้าไม่ส่ง จะแนบภายหลัง)
    if (sig) rec.sigId = saveSignatureFile_(id, sig);

    appendLogRow_([
      rec.id, rec.timestamp, rec.date, rec.time, rec.fullname,
      rec.type, rec.lat, rec.lng, rec.distance, rec.sigId
    ]);

    rec.signature = null;
    return rec;
  } finally {
    lock.releaseLock();
  }
}

/**
 * แนบลายมือชื่อให้รายการที่บันทึกเวลาไปแล้ว (เวลาในชีตไม่เปลี่ยน)
 * p = { id, signature }  — แนบได้เฉพาะรายการที่ยังไม่มีลายมือชื่อ
 */
function addSignature(p) {
  if (!p) throw new Error('ไม่พบข้อมูล');
  const id = String(p.id || '').trim();
  const sig = String(p.signature || '');
  if (!id) throw new Error('ไม่พบรหัสรายการ');
  if (!/^data:image\/png;base64,/.test(sig)) throw new Error('กรุณาลงลายมือชื่อ');
  if (sig.length > APP.MAX_SIGNATURE_CHARS) throw new Error('ไฟล์ลายมือชื่อมีขนาดใหญ่เกินไป');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getLogsSheet_();
    const last = sh.getLastRow();
    if (last < 2) throw new Error('ไม่พบรายการลงเวลานี้');
    const ids = sh.getRange(2, 1, last - 1, 1).getValues();
    let row = -1;
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === id) { row = i + 2; break; }
    }
    if (row < 0) throw new Error('ไม่พบรายการลงเวลานี้');

    const sigCol = LOG_HEADERS.indexOf('Signature ID') + 1;
    if (String(sh.getRange(row, sigCol).getValue() || '').trim()) {
      throw new Error('รายการนี้ลงลายมือชื่อไปแล้ว');
    }
    const sigId = saveSignatureFile_(id, sig);
    sh.getRange(row, sigCol).setValue(sigId);
    return { id: id, sigId: sigId };
  } finally {
    lock.releaseLock();
  }
}

function saveSignatureFile_(id, dataUrl) {
  const bytes = Utilities.base64Decode(dataUrl.split(',')[1]);
  const blob = Utilities.newBlob(bytes, 'image/png', id + '.png');
  return getSigFolder_().createFile(blob).getId();
}

/** รับรายการ ID ไฟล์ลายมือชื่อ คืนค่าเป็น { id: dataURL } */
function getSignatures(ids) {
  const out = {};
  (ids || []).slice(0, 30).forEach(function (id) {
    try {
      const blob = DriveApp.getFileById(String(id)).getBlob();
      out[id] = 'data:image/png;base64,' + Utilities.base64Encode(blob.getBytes());
    } catch (e) { /* ข้ามไฟล์ที่เปิดไม่ได้ */ }
  });
  return out;
}

function saveConfig(cfg, pin) {
  checkPin_(pin);
  const placeName = String((cfg && cfg.placeName) || '').trim().slice(0, 150);
  const lat = Number(cfg && cfg.lat);
  const lng = Number(cfg && cfg.lng);
  const radius = Number(cfg && cfg.radius);

  if (!placeName || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('ข้อมูลชื่อสถานที่หรือพิกัดไม่ถูกต้อง');
  }
  if (!isFinite(radius) || radius < 10 || radius > 5000) {
    throw new Error('รัศมีต้องอยู่ระหว่าง 10 – 5,000 เมตร');
  }

  const saved = { placeName: placeName, lat: lat, lng: lng, radius: radius };
  writeConfigSheet_(saved);
  return saved;
}

function clearLogs(pin) {
  checkPin_(pin);
  const sh = getLogsSheet_();
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  return true;
}

/* ======================== ฟังก์ชันภายใน ======================== */

function normName_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function readTeachers_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('teachers_v1');
  if (hit) {
    try { return JSON.parse(hit); } catch (e) {}
  }

  let sh;
  try {
    sh = SpreadsheetApp.openById(TEACHER_SOURCE.SPREADSHEET_ID).getSheetByName(TEACHER_SOURCE.SHEET_NAME);
  } catch (e) {
    throw new Error('เปิดชีตรายชื่อครูไม่ได้ (ตรวจสิทธิ์การเข้าถึงไฟล์) : ' + e.message);
  }
  if (!sh) throw new Error('ไม่พบชีตชื่อ "' + TEACHER_SOURCE.SHEET_NAME + '" ในไฟล์รายชื่อครู');

  const last = sh.getLastRow();
  if (last < 1) return [];
  const vals = sh.getRange(1, TEACHER_SOURCE.COLUMN, last, 1).getValues();

  const seen = {};
  const names = [];
  vals.forEach(function (r, i) {
    const n = normName_(r[0]);
    if (!n) return;
    // ข้ามแถวหัวตาราง
    if (i === 0 && /ชื่อ\s*-?\s*สกุล|ชื่อ-นามสกุล/.test(n)) return;
    if (seen[n]) return;
    seen[n] = true;
    names.push(n);
  });

  try { cache.put('teachers_v1', JSON.stringify(names), TEACHER_SOURCE.CACHE_SECONDS); } catch (e) {}
  return names;
}

function checkPin_(pin) {
  if (APP.ADMIN_PIN && String(pin || '') !== String(APP.ADMIN_PIN)) {
    throw new Error('รหัสผ่านแอดมินไม่ถูกต้อง');
  }
}

function getConfig_() {
  try {
    const sh = getConfigSheet_();
    const map = {};
    sh.getRange(2, 1, 4, 2).getValues().forEach(function (r) { map[String(r[0])] = r[1]; });
    const lat = Number(map.lat), lng = Number(map.lng), radius = Number(map.radius);
    if (isFinite(lat) && isFinite(lng) && isFinite(radius) && String(map.lat) !== '') {
      return {
        placeName: String(map.placeName || DEFAULT_CONFIG.placeName),
        lat: lat, lng: lng, radius: radius
      };
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function writeConfigSheet_(cfg) {
  const sh = getConfigSheet_();
  sh.getRange(2, 1, 4, 2).setValues([
    ['placeName', cfg.placeName],
    ['lat', cfg.lat],
    ['lng', cfg.lng],
    ['radius', cfg.radius]
  ]);
}

/** สร้างสเปรดชีต ชีตทั้งหมด และโฟลเดอร์ลายเซ็นอัตโนมัติ (ทำซ้ำได้ ไม่สร้างทับของเดิม) */
function ensureSetup_() {
  getLogsSheet_();
  getConfigSheet_();
  getSummarySheet_();
  removeDefaultSheet_();
  getSigFolder_();
}

function getConfigSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName('Config');
  if (!sh) {
    sh = ss.insertSheet('Config');
    sh.getRange(1, 1, 1, 3).setValues([['คีย์', 'ค่า', 'คำอธิบาย']])
      .setFontWeight('bold').setBackground('#6C5CE7').setFontColor('#ffffff');
    sh.getRange(2, 1, 4, 3).setValues([
      ['placeName', DEFAULT_CONFIG.placeName, 'ชื่อสถานที่ / โรงเรียน'],
      ['lat', DEFAULT_CONFIG.lat, 'Latitude จุดศูนย์กลาง'],
      ['lng', DEFAULT_CONFIG.lng, 'Longitude จุดศูนย์กลาง'],
      ['radius', DEFAULT_CONFIG.radius, 'รัศมีที่อนุญาต (เมตร)']
    ]);
    sh.setColumnWidth(1, 120); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 240);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getSummarySheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName('สรุปรายวัน');
  if (!sh) {
    sh = ss.insertSheet('สรุปรายวัน');
    sh.getRange('A1').setFormula(
      '=IFERROR(QUERY(Logs!C2:F, "select C, count(E) where C is not null group by C label C \'วันที่\', count(E) \'จำนวนรายการ\'", 0), "ยังไม่มีข้อมูล")'
    );
    sh.getRange('A1:B1').setFontWeight('bold');
    sh.setColumnWidth(1, 140); sh.setColumnWidth(2, 120);
  }
  return sh;
}

function getSpreadsheet_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (ss) return ss;

  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) {}
  }
  ss = SpreadsheetApp.create('ข้อมูลระบบลงเวลาคุณครู');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  props.setProperty('DEFAULT_SHEET_PENDING_DELETE', '1');
  return ss;
}

function getLogsSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(APP.SHEET_LOGS);
  if (!sh) {
    sh = ss.insertSheet(APP.SHEET_LOGS);
    sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS])
      .setFontWeight('bold').setBackground('#6C5CE7').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    // ตั้งเป็นข้อความ ป้องกัน Sheets แปลงวันที่/เวลาอัตโนมัติ
    [1, 3, 4, 5, 6, 10].forEach(function (col) {
      sh.getRange(1, col, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  }
  return sh;
}

/** เพิ่มแถวใหม่ โดยตั้งคอลัมน์ข้อความเป็น Plain text ก่อนเขียน กัน Sheets แปลงวันที่/เวลาเอง */
function appendLogRow_(values) {
  const sh = getLogsSheet_();
  const row = sh.getLastRow() + 1;
  [1, 3, 4, 5, 6, 10].forEach(function (col) {
    sh.getRange(row, col).setNumberFormat('@');
  });
  sh.getRange(row, 1, 1, values.length).setValues([values]);
}

/**
 * รันครั้งเดียวจากตัวแก้ไขสคริปต์ เพื่อซ่อมข้อมูลเก่าในชีต Logs
 * (แปลงคอลัมน์วันที่/เวลาที่ถูกแปลงเป็นชนิดวันที่ กลับเป็นข้อความจาก Timestamp)
 */
function repairLogs() {
  const sh = getLogsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const n = last - 1;
  [1, 3, 4, 5, 6, 10].forEach(function (col) {
    sh.getRange(2, col, n, 1).setNumberFormat('@');
  });
  const ts = sh.getRange(2, 2, n, 1).getValues();
  const dt = ts.map(function (r) {
    const t = Number(r[0]);
    if (!isFinite(t) || t <= 0) return ['', ''];
    const d = new Date(t * 1000);
    return [thaiDate_(d), Utilities.formatDate(d, APP.TZ, 'HH:mm:ss')];
  });
  const cur = sh.getRange(2, 3, n, 2).getValues();
  const out = dt.map(function (r, i) { return (r[0] || r[1]) ? r : [cur[i][0], cur[i][1]]; });
  sh.getRange(2, 3, n, 2).setValues(out);
  Logger.log('ซ่อมข้อมูลแล้ว ' + n + ' แถว');
}

function removeDefaultSheet_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('DEFAULT_SHEET_PENDING_DELETE')) return;
  const ss = getSpreadsheet_();
  ['Sheet1', 'ชีต1'].forEach(function (n) {
    const d = ss.getSheetByName(n);
    if (d && ss.getSheets().length > 1) ss.deleteSheet(d);
  });
  props.deleteProperty('DEFAULT_SHEET_PENDING_DELETE');
}

function getSigFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SIG_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) {}
  }
  const folder = DriveApp.createFolder(APP.SIG_FOLDER_NAME);
  props.setProperty('SIG_FOLDER_ID', folder.getId());
  return folder;
}

function readLogs_() {
  const sh = getLogsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];

  const start = Math.max(2, last - APP.MAX_LOGS + 1);
  const values = sh.getRange(start, 1, last - start + 1, LOG_HEADERS.length).getValues();

  return values.reverse().filter(function (r) { return r[0]; }).map(function (r) {
    const ts = Number(r[1]);
    const d = isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null;
    return {
      id: String(r[0]),
      timestamp: ts,
      // สร้างวัน/เวลาจาก Timestamp เพื่อไม่ให้แสดงผลเพี้ยนเมื่อ Google Sheets แปลงข้อความเป็นชนิดวันที่/เวลาเอง
      date: d ? thaiDate_(d) : cellText_(r[2], 'date'),
      time: d ? Utilities.formatDate(d, APP.TZ, 'HH:mm:ss') : cellText_(r[3], 'time'),
      fullname: String(r[4]),
      type: String(r[5]),
      lat: Number(r[6]),
      lng: Number(r[7]),
      distance: Number(r[8]),
      sigId: String(r[9] || ''),
      signature: null
    };
  });
}

function cellText_(v, kind) {
  if (v instanceof Date) {
    return kind === 'date' ? thaiDate_(v) : Utilities.formatDate(v, APP.TZ, 'HH:mm:ss');
  }
  return String(v);
}

function thaiDate_(d) {
  const y = Number(Utilities.formatDate(d, APP.TZ, 'yyyy')) + 543;
  return Utilities.formatDate(d, APP.TZ, 'dd/MM/') + y;
}

function haversine_(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = function (x) { return x * Math.PI / 180; };
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}