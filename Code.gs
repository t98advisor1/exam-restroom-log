/**
 * =============================================================================
 *  시험 중 화장실·보건실 출입 기록 — 구글 시트 실시간 동기화 API (Google Apps Script)
 * =============================================================================
 *  시트: [시험 감독] 화장실·보건실 실시간 출입 관리 (1·2학년)
 *    - '명렬표'   : 학번 | 이름 | 학년 | 반 | 번호        (1학년 300 + 2학년 292 = 592명)
 *    - '출입기록' : id | 학번 | 이름 | 학년 | 반 | 위치 | 입장시각 | 퇴장시각 |
 *                   상태 | 감독확인 | 확인시각 | 동시체류
 *
 *  웹앱 배포: [배포] → [새 배포] → 유형 '웹 앱'
 *             실행 계정: 나   /   액세스 권한: 모든 사용자
 *
 *  통신 규약
 *    GET  <exec>?action=data&rv=<명렬표버전>
 *         → {ok, serverTime, records[], rosterVersion, roster[]?}
 *    GET  <exec>?action=ping
 *         → {ok, ping:true, serverTime}
 *    POST <exec>   Content-Type: text/plain   body = JSON
 *         {action:'enter',      id, name, sid, grade, cls, num, zone, inAt}
 *         {action:'exit',       id, outAt}
 *         {action:'confirm',    id, checkedAt}
 *         {action:'confirmAll', ids:[...]}
 *         {action:'delete',     id}
 *         {action:'clearAll'}
 *         → {ok, action, serverTime, records[], rosterVersion, roster[]?}
 *
 *  · 모든 쓰기는 LockService 스크립트 잠금 안에서 처리해 태블릿 9대가 동시에
 *    눌러도 행이 겹치거나 유실되지 않습니다.
 *  · 클라이언트가 만든 id 로 기록하므로 응답이 유실돼 재전송해도 중복이 생기지 않습니다.
 *  · 시각은 Asia/Seoul 기준 'YYYY-MM-DD HH:MM:SS' 문자열로 저장합니다(셀 서식은 텍스트).
 * =============================================================================
 */

var SHEET_ID = '1HozH-UW3_3Ahd2lx3S-HL4GA_CkVXQqiJ7bEgJayJY0';
var ROSTER_TAB = '명렬표';
var LOG_TAB = '출입기록';
var TZ = 'Asia/Seoul';

/* 위치 코드 ↔ 시트 표기 */
var ZONES = {
  '1M': '1층 남', '1F': '1층 여',
  '2M': '2층 남', '2F': '2층 여',
  '3M': '3층 남', '3F': '3층 여',
  '4M': '4층 남', '4F': '4층 여',
  'NURSE': '보건실'
};
var ZONE_BY_NAME = {};
Object.keys(ZONES).forEach(function (code) { ZONE_BY_NAME[ZONES[code]] = code; });

/* ==========================================================================
   진입점
   ========================================================================== */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = String(p.action || 'data');

    if (action === 'ping') {
      return out_({ ok: true, ping: true, serverTime: nowStr_(), records: 0 });
    }
    if (action !== 'data') throw new Error('알 수 없는 action 입니다: ' + action);

    ensureSheet_();

    var roster = readRoster_();
    var rosterVersion = rosterVersion_(roster);
    var res = {
      ok: true,
      serverTime: nowStr_(),
      records: readRecords_(),
      rosterVersion: rosterVersion
    };
    if (String(p.rv || '') !== rosterVersion) res.roster = roster;
    return out_(res);
  } catch (err) {
    return out_({ ok: false, error: errText_(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(25000)) {
      return out_({ ok: false, busy: true, error: '다른 기기가 기록을 저장하는 중입니다. 잠시 후 다시 시도해 주세요.' });
    }

    var body = parseBody_(e);
    var action = String(body.action || '');
    ensureSheet_();

    var count = 0;
    if (action === 'enter') count = enter_(body);
    else if (action === 'exit') count = exit_(body);
    else if (action === 'confirm') count = confirm_(body);
    else if (action === 'confirmAll') count = confirmAll_(body);
    else if (action === 'delete') count = delete_(body);
    else if (action === 'clearAll') count = clearAll_(body);
    else throw new Error('알 수 없는 action 입니다: ' + action);

    var roster = readRoster_();
    var rosterVersion = rosterVersion_(roster);
    var res = {
      ok: true,
      action: action,
      changed: count,
      serverTime: nowStr_(),
      records: readRecords_(),
      rosterVersion: rosterVersion
    };
    if (String(body.rv || '') !== rosterVersion) res.roster = roster;
    return out_(res);
  } catch (err) {
    return out_({ ok: false, error: errText_(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) { }
  }
}

/* 시트 편집기에서 바로 확인할 수 있는 연결 점검용 함수 */
function testApi() {
  var r = readRoster_(), g = readRecords_();
  Logger.log('명렬표 %s명 / 출입기록 %s건 / 버전 %s', r.length, g.length, rosterVersion_(r));
}

/* ==========================================================================
   쓰기 액션
   ========================================================================== */

function enter_(b) {
  var id = String(b.id || '').trim();
  if (!id) throw new Error('기록 id 가 없습니다.');
  var name = String(b.name || '').trim();
  if (!name) throw new Error('학생 이름이 없습니다.');
  var code = zoneCode_(b.zone);
  if (!code) throw new Error('알 수 없는 위치입니다: ' + b.zone);

  var sh = logSheet_();
  if (findRow_(sh, id) > 0) return 0; // 이미 저장된 기록 — 중복 방지(재전송 안전)

  var inAt = numOr_(b.inAt, Date.now());
  sh.appendRow([
    id,                      // A id
    String(b.sid || '').trim(), // B 학번
    name,                    // C 이름
    numOr_(b.grade, 0),      // D 학년
    numOr_(b.cls, 0),        // E 반
    ZONES[code],             // F 위치
    strTime_(inAt),          // G 입장시각
    '',                      // H 퇴장시각
    '이용 중',               // I 상태
    '',                      // J 감독확인
    '',                      // K 확인시각
    ''                       // L 동시체류
  ]);
  return 1;
}

function exit_(b) {
  var id = String(b.id || '').trim();
  if (!id) throw new Error('기록 id 가 없습니다.');
  var row = findRow_(logSheet_(), id);
  if (row < 2) throw new Error('기록을 찾지 못했습니다: ' + id);

  var sh = logSheet_();
  var outAt = numOr_(b.outAt, Date.now());
  var vals = sh.getRange(row, 1, 1, 12).getValues()[0];
  if (String(vals[7] || '').trim()) return 0; // 이미 퇴장 처리됨 — 재전송 안전

  var code = zoneCode_(vals[5]);
  var partners = partnersAt_(code, id, numTs_(vals[6]), outAt);

  sh.getRange(row, 8, 1, 5).setValues([[
    strTime_(outAt),
    '퇴장',
    vals[9] || '',
    vals[10] || '',
    partners.join(', ')
  ]]);
  return 1;
}

function confirm_(b) {
  var id = String(b.id || '').trim();
  if (!id) throw new Error('기록 id 가 없습니다.');
  var row = findRow_(logSheet_(), id);
  if (row < 2) throw new Error('기록을 찾지 못했습니다: ' + id);

  var sh = logSheet_();
  var checkedAt = numOr_(b.checkedAt, Date.now());
  sh.getRange(row, 10, 1, 2).setValues([['확인', strTime_(checkedAt)]]);
  return 1;
}

function confirmAll_(b) {
  var ids = b.ids;
  var sh = logSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;

  var range = sh.getRange(2, 1, last - 1, 12);
  var vals = range.getValues();
  var want = null;
  if (ids && ids.length) {
    want = {};
    ids.forEach(function (v) { want[String(v)] = 1; });
  }
  var now = numOr_(b.checkedAt, Date.now());
  var nowText = strTime_(now);
  var n = 0;

  for (var i = 0; i < vals.length; i++) {
    var id = String(vals[i][0] || '').trim();
    if (!id) continue;
    if (want && !want[id]) continue;
    if (!String(vals[i][7] || '').trim()) continue; // 아직 이용 중인 기록은 제외
    if (String(vals[i][9] || '').trim()) continue;  // 이미 확인된 기록은 제외
    vals[i][9] = '확인';
    vals[i][10] = nowText;
    n++;
  }
  if (n > 0) range.setValues(vals);
  return n;
}

function delete_(b) {
  var id = String(b.id || '').trim();
  if (!id) throw new Error('기록 id 가 없습니다.');
  var sh = logSheet_();
  var row = findRow_(sh, id);
  if (row < 2) return 0;
  sh.deleteRow(row);
  return 1;
}

function clearAll_(b) {
  var sh = logSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var n = last - 1;
  sh.deleteRows(2, n);
  return n;
}

/* ==========================================================================
   읽기
   ========================================================================== */

function readRoster_() {
  var sh = book_().getSheetByName(ROSTER_TAB);
  if (!sh) throw new Error("'" + ROSTER_TAB + "' 탭을 찾지 못했습니다.");
  var last = sh.getLastRow();
  if (last < 2) return [];

  var vals = sh.getRange(2, 1, last - 1, 5).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var sid = String(vals[i][0] || '').replace(/\s/g, '');
    var name = String(vals[i][1] || '').replace(/\s/g, '');
    if (!name) continue;
    var grade = numOr_(vals[i][2], 0);
    var cls = numOr_(vals[i][3], 0);
    var num = numOr_(vals[i][4], 0);
    if (!sid) sid = String(grade) + pad_(cls) + pad_(num);
    out.push({ key: 's' + sid, sid: sid, name: name, grade: grade, cls: cls, num: num });
  }
  return out;
}

function readRecords_() {
  var sh = logSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];

  var vals = sh.getRange(2, 1, last - 1, 12).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var id = String(vals[i][0] || '').trim();
    if (!id) continue;
    var inAt = numTs_(vals[i][6]);
    if (!inAt) continue;
    out.push({
      id: id,
      sid: String(vals[i][1] || '').trim(),
      name: String(vals[i][2] || '').trim(),
      grade: numOr_(vals[i][3], 0),
      cls: numOr_(vals[i][4], 0),
      num: numOfSid_(vals[i][1]),
      zone: zoneCode_(vals[i][5]) || '',
      inAt: inAt,
      outAt: numTs_(vals[i][7]) || null,
      checkedAt: numTs_(vals[i][10]) || null
    });
  }
  return out;
}

/* 같은 위치에서 시간이 겹친 학생 이름(화장실만) — 퇴장 시 시트에 남깁니다 */
function partnersAt_(code, selfId, inAt, outAt) {
  if (!code || code === 'NURSE' || !inAt) return [];
  var recs = readRecords_();
  var names = [];
  for (var i = 0; i < recs.length; i++) {
    var o = recs[i];
    if (o.id === selfId || o.zone !== code) continue;
    var oEnd = o.outAt || outAt;
    if (inAt < oEnd && o.inAt < outAt) {
      if (names.indexOf(o.name) < 0) names.push(o.name);
    }
  }
  return names;
}

/* ==========================================================================
   유틸
   ========================================================================== */

function book_() { return SpreadsheetApp.openById(SHEET_ID); }
function logSheet_() {
  var sh = book_().getSheetByName(LOG_TAB);
  if (!sh) throw new Error("'" + LOG_TAB + "' 탭을 찾지 못했습니다.");
  return sh;
}

/* id → 행 번호 (없으면 0) */
function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === id) return i + 2;
  }
  return 0;
}

/* 최초 1회: 시각 열을 텍스트 서식으로, 시트 표준 시간대를 서울로 맞춥니다 */
function ensureSheet_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ready') === '1') return;
  try {
    var b = book_();
    try { b.setSpreadsheetTimeZone(TZ); } catch (ignore) { }
    var sh = logSheet_();
    sh.getRange('G2:G').setNumberFormat('@');
    sh.getRange('H2:H').setNumberFormat('@');
    sh.getRange('K2:K').setNumberFormat('@');
    props.setProperty('ready', '1');
  } catch (err) {
    // 서식 지정은 실패해도 동작에는 지장이 없습니다.
    Logger.log('ensureSheet_: ' + errText_(err));
  }
}

function rosterVersion_(roster) {
  var s = roster.map(function (r) { return r.sid + r.name + r.grade + r.cls + r.num; }).join('|');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var v = (digest[i] < 0 ? digest[i] + 256 : digest[i]).toString(16);
    hex += v.length === 1 ? '0' + v : v;
  }
  return roster.length + '-' + hex.slice(0, 12);
}

function zoneCode_(v) {
  if (v == null) return '';
  var s = String(v).trim();
  if (!s) return '';
  var up = s.toUpperCase();
  if (ZONES[up]) return up;
  if (ZONE_BY_NAME[s]) return ZONE_BY_NAME[s];
  var m = s.match(/([1-4])\s*층\s*(남|여)/);
  if (m) return m[1] + (m[2] === '남' ? 'M' : 'F');
  if (/보건/.test(s)) return 'NURSE';
  return '';
}

function numOr_(v, dflt) {
  if (v === '' || v == null) return dflt;
  var n = Number(v);
  return isFinite(n) ? n : dflt;
}

/* 시트 셀 → epoch(ms). 문자열·Date·숫자 모두 처리 */
function numTs_(v) {
  if (v === '' || v == null) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v > 1e11 ? v : Math.round((v - 25569) * 86400000) - 9 * 3600000;
  var m = String(v).match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  }
  var t = Date.parse(String(v));
  return isNaN(t) ? 0 : t;
}

/* 5자리 학번(예: 20115) → 출석번호 15 */
function numOfSid_(sid) {
  var d = String(sid || '').replace(/[^0-9]/g, '');
  return d.length >= 5 ? Number(d.slice(-2)) : 0;
}

function strTime_(ms) {
  return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd HH:mm:ss');
}
function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function pad_(n) { return (n < 10 ? '0' : '') + n; }

function parseBody_(e) {
  var raw = (e && e.postData && e.postData.contents) || '';
  if (!raw) throw new Error('요청 본문(body)이 비어 있습니다.');
  try {
    var o = JSON.parse(raw);
    if (!o || typeof o !== 'object') throw new Error('형식 오류');
    return o;
  } catch (err) {
    throw new Error('JSON 을 읽지 못했습니다: ' + errText_(err));
  }
}

function errText_(err) {
  if (!err) return '알 수 없는 오류';
  return String(err.message || err);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
