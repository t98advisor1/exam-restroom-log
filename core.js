/* =========================================================================
   시험 중 화장실 출입 기록 — 공용 데이터 계층 (core.js)
   index.html(현장용) 과 dashboard.html(고사본부) 이 함께 사용합니다.
   같은 도메인의 localStorage 키를 공유하므로 두 페이지의 기록이 함께 갱신됩니다.
   ========================================================================= */
(function (global) {
  "use strict";

  /* ---------- 저장 키 ---------- */
  var K = {
    REC: "examRestroom.records.v1",
    ROSTER: "examRestroom.roster.v1",
    SET: "examRestroom.settings.v1"
  };

  /* ---------- 장소 ---------- */
  var ZONES = [
    { code: "1M", floor: 1, sex: "남", name: "1층 남", kind: "toilet" },
    { code: "1F", floor: 1, sex: "여", name: "1층 여", kind: "toilet" },
    { code: "2M", floor: 2, sex: "남", name: "2층 남", kind: "toilet" },
    { code: "2F", floor: 2, sex: "여", name: "2층 여", kind: "toilet" },
    { code: "3M", floor: 3, sex: "남", name: "3층 남", kind: "toilet" },
    { code: "3F", floor: 3, sex: "여", name: "3층 여", kind: "toilet" },
    { code: "4M", floor: 4, sex: "남", name: "4층 남", kind: "toilet" },
    { code: "4F", floor: 4, sex: "여", name: "4층 여", kind: "toilet" },
    { code: "NURSE", floor: 0, sex: "", name: "보건실", kind: "nurse" }
  ];
  var ZMAP = {};
  ZONES.forEach(function (z) { ZMAP[z.code] = z; });
  var TOILETS = ZONES.filter(function (z) { return z.kind === "toilet"; });

  function zoneName(code) { var z = ZMAP[code]; return z ? z.name : String(code || ""); }
  function zone(code) { return ZMAP[code] || null; }
  function isToilet(code) { var z = ZMAP[code]; return !!z && z.kind === "toilet"; }
  function isNurse(code) { var z = ZMAP[code]; return !!z && z.kind === "nurse"; }

  function parseZoneParam(v) {
    if (!v) return null;
    var s = String(decodeURIComponent(v)).replace(/\s/g, "").toUpperCase();
    if (ZMAP[s]) return s;
    if (/^(NURSE|보건실|보건)$/.test(s)) return "NURSE";
    var m = s.match(/^([1-4])([MF])$/);
    if (m) return m[1] + m[2];
    m = s.match(/^([1-4])층?(남|여)/);
    if (m) return m[1] + (m[2] === "남" ? "M" : "F");
    return null;
  }

  /* ---------- 문자열/시간 ---------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtTime(ts) { var d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); }
  function fmtHM(ts) { var d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }

  function durShort(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h > 0) return h + "시간 " + m + "분";
    if (m > 0) return m + "분 " + pad(ss) + "초";
    return ss + "초";
  }
  function durLong(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h > 0 ? h + "시간 " : "") + m + "분 " + pad(ss) + "초";
  }
  function todayKey() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function dateLabel() {
    var d = new Date(), days = ["일", "월", "화", "수", "목", "금", "토"];
    return d.getFullYear() + "." + pad(d.getMonth() + 1) + "." + pad(d.getDate()) + " (" + days[d.getDay()] + ")";
  }

  /* ---------- 초성 ---------- */
  var CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
  var JAMO = /[\u3131-\u318E]/;

  function chosungOf(str) {
    var out = "";
    for (var i = 0; i < String(str).length; i++) {
      var ch = String(str)[i], code = ch.charCodeAt(0);
      if (code >= 0xAC00 && code <= 0xD7A3) out += CHO[Math.floor((code - 0xAC00) / 588)];
      else out += ch;
    }
    return out;
  }

  /* 이름 매칭: 완전 글자 / 부분 일치 / 초성(ㅎㄱ) 모두 지원 */
  function nameMatches(name, q) {
    if (!q) return true;
    var full = Array.from(name), cho = Array.from(chosungOf(name)), qa = Array.from(q);
    if (qa.length > full.length) return false;
    for (var i = 0; i + qa.length <= full.length; i++) {
      var ok = true;
      for (var j = 0; j < qa.length; j++) {
        var qc = qa[j];
        if (JAMO.test(qc)) { if (qc !== cho[i + j]) { ok = false; break; } }
        else if (qc !== full[i + j]) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  /* ---------- 학번 ---------- */
  function idText(s) {
    if (!s) return "";
    if (s.sid) return String(s.sid);
    if (s.cls && s.num) return (s.grade ? s.grade + "-" : "") + s.cls + "-" + s.num;
    if (s.num) return String(s.num) + "번";
    return "학번 없음";
  }
  function idDigits(s) {
    if (!s) return "";
    var d = "";
    if (s.grade) d += String(s.grade);
    if (s.cls) d += pad(s.cls);
    if (s.num) d += pad(s.num);
    if (d) return d;
    return String(s.sid || "").replace(/[^0-9]/g, "");
  }
  /* 학번 검색용 후보들 — 20115 / 2115 / 115 / 1-15 모두 걸리도록 */
  function idVariants(s) {
    var out = [], raw = "", padded = "";
    if (s.grade) { raw += String(s.grade); padded += String(s.grade); }
    if (s.cls) { raw += String(s.cls); padded += pad(s.cls); }
    if (s.num) { raw += String(s.num); padded += pad(s.num); }
    if (padded) out.push(padded);
    if (raw && raw !== padded) out.push(raw);
    if (s.sid) out.push(String(s.sid));
    if (s.cls && s.num) out.push(pad(s.cls) + pad(s.num), s.cls + "-" + s.num);
    return out;
  }
  function sameStudent(a, b) { return !!a && !!b && a.name === b.name && idText(a) === idText(b); }

  /* ---------- 검색 ---------- */
  function searchRoster(roster, qRaw, limit) {
    var q = String(qRaw || "").replace(/\s+/g, "");
    if (!q) return [];
    var digits = q.replace(/[^0-9]/g, "");
    var digitQuery = /^[0-9-]+$/.test(q) && digits.length > 0;
    var list = (roster || []).filter(function (s) {
      if (digitQuery) {
        var vars = idVariants(s).concat([idText(s).replace(/[^0-9]/g, "")]);
        return vars.some(function (v) { return v && v.indexOf(digits) !== -1; });
      }
      return nameMatches(s.name, q);
    });
    var qCho = Array.from(q).every(function (c) { return JAMO.test(c); }) ? q : null;
    list.sort(function (a, b) {
      var ac = qCho && chosungOf(a.name) === qCho ? 0 : 1;
      var bc = qCho && chosungOf(b.name) === qCho ? 0 : 1;
      if (ac !== bc) return ac - bc;
      var ap = !digitQuery && a.name.indexOf(q) === 0 ? 0 : 1;
      var bp = !digitQuery && b.name.indexOf(q) === 0 ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if ((a.grade || 0) !== (b.grade || 0)) return (a.grade || 0) - (b.grade || 0);
      if ((a.cls || 0) !== (b.cls || 0)) return (a.cls || 0) - (b.cls || 0);
      if ((a.num || 0) !== (b.num || 0)) return (a.num || 0) - (b.num || 0);
      return String(a.name).localeCompare(String(b.name), "ko");
    });
    return limit ? list.slice(0, limit) : list;
  }

  /* ---------- 기록 계산 ---------- */
  function activeRecords(records, zoneCode) {
    return (records || []).filter(function (r) { return !r.outAt && (!zoneCode || r.zone === zoneCode); });
  }
  function overlaps(a, b) {
    if (a === b || !a || !b || a.zone !== b.zone) return false;
    var aEnd = a.outAt || Infinity, bEnd = b.outAt || Infinity;
    return a.inAt < bEnd && b.inAt < aEnd;
  }
  /* 화장실 동시 체류 상대 — 보건실은 부정행위 신호가 아니므로 제외 */
  function simPartners(records, rec) {
    if (!rec || !isToilet(rec.zone)) return [];
    return (records || []).filter(function (o) { return o.id !== rec.id && overlaps(rec, o); });
  }
  function simPairs(records) {
    var list = (records || []).filter(function (r) { return isToilet(r.zone); });
    var n = 0;
    for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) if (overlaps(list[i], list[j])) n++;
    return n;
  }
  function avgDuration(records) {
    var done = (records || []).filter(function (r) { return r.outAt; });
    if (!done.length) return 0;
    return done.reduce(function (n, r) { return n + (r.outAt - r.inAt); }, 0) / done.length;
  }

  /* ---------- 기본 명렬표 (테스트용 가상 45명) ---------- */
  var DEFAULT_ROSTER = [
    ["김민수", 1, 1, 1], ["김민서", 1, 1, 2], ["이서준", 1, 1, 3], ["박지우", 1, 1, 4], ["최하윤", 1, 1, 5], ["정도현", 1, 1, 6],
    ["홍길동", 1, 2, 1], ["강예린", 1, 2, 7], ["윤서아", 1, 2, 12], ["송지호", 1, 2, 15], ["한유진", 1, 2, 21],
    ["황건호", 1, 3, 2], ["김도윤", 1, 3, 9], ["이지안", 1, 3, 11], ["오세훈", 1, 3, 18], ["남주원", 1, 3, 24],
    ["김민수", 2, 1, 3], ["박서연", 2, 1, 5], ["정하늘", 2, 1, 8], ["배준서", 2, 1, 14], ["임채원", 2, 1, 20],
    ["이서준", 2, 2, 1], ["김민서", 2, 2, 6], ["서지훈", 2, 2, 10], ["문가영", 2, 2, 13], ["조은우", 2, 2, 17],
    ["박지우", 2, 3, 2], ["신유나", 2, 3, 4], ["권태현", 2, 3, 7], ["노아름", 2, 3, 16], ["유건우", 2, 3, 22],
    ["최예진", 3, 1, 1], ["장민호", 3, 1, 5], ["김나연", 3, 1, 9], ["심재원", 3, 1, 12], ["하도경", 3, 1, 19],
    ["홍길동", 3, 2, 4], ["이하람", 3, 2, 8], ["서준혁", 3, 2, 11], ["안소미", 3, 2, 15], ["표지훈", 3, 2, 23],
    ["강지원", 3, 3, 2], ["백서진", 3, 3, 6], ["임하은", 3, 3, 10], ["진우성", 3, 3, 14], ["남기훈", 3, 3, 25]
  ];
  function buildDefaultRoster() {
    return DEFAULT_ROSTER.map(function (r, i) { return { key: "d" + i, name: r[0], grade: r[1], cls: r[2], num: r[3] }; });
  }

  /* ---------- 저장소 ---------- */
  var storageOK = true;
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { storageOK = false; return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { storageOK = false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }

  var store = {
    ok: function () { return storageOK; },
    raw: function () { return { rec: lsGet(K.REC) || "", roster: lsGet(K.ROSTER) || "", set: lsGet(K.SET) || "" }; },
    readRecords: function () {
      var s = lsGet(K.REC);
      if (!s) return [];
      try {
        var arr = JSON.parse(s);
        return Array.isArray(arr) ? arr.filter(function (x) { return x && x.id && x.inAt && x.zone; }) : [];
      } catch (e) { return []; }
    },
    writeRecords: function (arr) { lsSet(K.REC, JSON.stringify(arr || [])); },
    readRoster: function () {
      var s = lsGet(K.ROSTER);
      if (s) {
        try {
          var arr = JSON.parse(s);
          if (Array.isArray(arr) && arr.length) return arr;
        } catch (e) { }
      }
      return buildDefaultRoster();
    },
    writeRoster: function (arr) { lsSet(K.ROSTER, JSON.stringify(arr || [])); },
    readSettings: function () {
      var s = lsGet(K.SET), o = {};
      if (s) { try { o = JSON.parse(s) || {}; } catch (e) { o = {}; } }
      return o;
    },
    writeSettings: function (o) { lsSet(K.SET, JSON.stringify(o || {})); },
    clearRecords: function () { lsDel(K.REC); },
    resetRoster: function () { var d = buildDefaultRoster(); store.writeRoster(d); return d; }
  };

  /* ---------- 명렬표 CSV 파싱 ---------- */
  function splitCSVLine(line, delim) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === delim) { out.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function parseRosterText(text) {
    var lines = String(text || "").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var result = [], seen = {};
    lines.forEach(function (line) {
      var delim = line.indexOf("\t") >= 0 ? "\t" : (line.indexOf(",") >= 0 ? "," : null);
      var cells = delim ? splitCSVLine(line, delim) : line.split(/\s+/);
      cells = cells.map(function (c) { return c.trim().replace(/^"|"$/g, ""); }).filter(function (c) { return c.length; });
      if (!cells.length) return;
      var joined = cells.join(" ");
      var hasHeaderWord = /(학년|학번|성명|이름|번호|순번|출석)/.test(joined);
      var hasNumber = cells.some(function (c) { return /^\d+$/.test(c) || /^\d{1,2}(-\d{1,2}){1,2}$/.test(c); });
      if (hasHeaderWord && !hasNumber) return;

      var nameCell = cells.filter(function (c) {
        return /[가-힣]/.test(c) && !/^(학년|학번|성명|이름|번호|순번|출석|반|남|여)$/.test(c);
      })[0];
      if (!nameCell) return;
      var name = nameCell.replace(/\s+/g, "");
      if (name.length < 2 || name.length > 6) return;

      var nums = [];
      cells.forEach(function (c) {
        if (/^\d{1,2}(-\d{1,2}){1,2}$/.test(c)) nums = nums.concat(c.split("-").map(Number));
        else if (/^\d+$/.test(c)) nums.push(c);
      });
      var grade = 0, cls = 0, num = 0;
      if (nums.length >= 3) { grade = Number(nums[0]) || 0; cls = Number(nums[1]) || 0; num = Number(nums[2]) || 0; }
      else if (nums.length === 2) { cls = Number(nums[0]) || 0; num = Number(nums[1]) || 0; }
      else if (nums.length === 1) {
        var str = String(nums[0]);
        if (str.length === 5) { grade = Number(str[0]); cls = Number(str.slice(1, 3)); num = Number(str.slice(3, 5)); }
        else if (str.length === 4) { cls = Number(str.slice(0, 2)); num = Number(str.slice(2, 4)); }
        else num = Number(str);
      }
      var key = name + "|" + grade + "|" + cls + "|" + num;
      if (seen[key]) return;
      seen[key] = 1;
      result.push({ key: "u" + result.length, name: name, grade: grade, cls: cls, num: num });
    });
    result.sort(function (a, b) {
      return (a.grade - b.grade) || (a.cls - b.cls) || (a.num - b.num) || String(a.name).localeCompare(String(b.name), "ko");
    });
    return result;
  }

  /* ---------- CSV 내보내기 ---------- */
  function csvCell(v) {
    var s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function buildCSV(records) {
    var rows = (records || []).slice().sort(function (a, b) { return a.inAt - b.inAt; });
    var head = ["번호", "이름", "학번", "학년", "반", "출석번호", "위치", "입실시각", "퇴실시각", "체류(초)", "체류(표시)", "동시체류", "감독교사확인시각", "상태"];
    var lines = [head.map(csvCell).join(",")];
    rows.forEach(function (r, i) {
      var sim = simPartners(rows, r).length > 0;
      var d = r.outAt ? Math.floor((r.outAt - r.inAt) / 1000) : "";
      lines.push([
        i + 1, r.name, r.sid, r.grade || "", r.cls || "", r.num || "", zoneName(r.zone),
        fmtTime(r.inAt), r.outAt ? fmtTime(r.outAt) : "", d,
        r.outAt ? durShort(r.outAt - r.inAt) : "이용 중",
        sim ? "Y" : "N",
        r.checkedAt ? fmtTime(r.checkedAt) : "",
        r.outAt ? (r.checkedAt ? "확인 완료" : "확인 필요") : "이용 중"
      ].map(csvCell).join(","));
    });
    return "\ufeff" + lines.join("\r\n");
  }
  function downloadCSV(records, tag) {
    if (!records || !records.length) return false;
    var blob = new Blob([buildCSV(records)], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    var name = "출입기록_" + (tag || "") + todayKey() + "_" + pad(new Date().getHours()) + pad(new Date().getMinutes()) + ".csv";
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return name;
  }

  /* =========================================================================
     실시간 동기화 — Google Apps Script 웹앱(Code.gs)과 통신합니다.
     · GET  ?action=data&rv=<명렬표버전>  → 기록/명렬표
     · POST body=JSON (text/plain)       → enter/exit/confirm/confirmAll/delete/clearAll
     · 서버가 진실이고, 화면은 먼저 반영(optimistic)한 뒤 서버 응답으로 맞춥니다.
     · 실패한 쓰기는 순서대로 최대 5회 재전송합니다(요청에 id 가 있어 중복이 생기지 않음).
     ========================================================================= */
  var API_KEY = "examRestroom.apiUrl.v1";
  var POLL_MS = 2500;
  var DEFAULT_API = "";  // 배포 후 /exec 주소를 넣으면 태블릿이 설정 없이 바로 동기화됩니다.

  function apiUrlFromEnv() {
    var u = "";
    try { u = new URLSearchParams(location.search).get("api") || ""; } catch (e) { }
    if (!u) u = lsGet(API_KEY) || "";
    if (!u) u = DEFAULT_API || "";
    return String(u).trim();
  }
  function apiSetUrl(u) { lsSet(API_KEY, String(u || "").trim()); }

  function apiReq(method, params, body) {
    var base = remote.url;
    if (!/^https?:\/\//.test(base)) return Promise.reject(new Error("API 주소가 없습니다"));
    var opt = { method: method, cache: "no-store", redirect: "follow" };
    var url = base;
    if (method === "GET") {
      var qs = Object.keys(params || {}).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      }).join("&");
      if (qs) url += (base.indexOf("?") >= 0 ? "&" : "?") + qs;
    } else {
      opt.headers = { "Content-Type": "text/plain;charset=utf-8" };
      opt.body = JSON.stringify(body || {});
    }
    return fetch(url, opt).then(function (res) {
      return res.text().then(function (text) {
        var j;
        try { j = JSON.parse(text); }
        catch (e) { throw new Error("서버 응답을 읽지 못했습니다 (HTTP " + res.status + ")"); }
        if (!j || j.ok !== true) throw new Error((j && j.error) || "서버 오류");
        return j;
      });
    });
  }

  function errMsg(e) {
    var m = String((e && e.message) || e || "알 수 없는 오류");
    if (/Failed to fetch|Load failed|NetworkError/i.test(m)) return "네트워크 오류";
    return m;
  }

  var remote = {
    url: "", on: false, error: "", syncedAt: 0, inflight: false, busy: false,
    rosterVersion: "", queue: [], timer: null, onState: null, listener: null, lastStatus: "",

    enabled: function () { return this.on; },

    init: function (onState, listener) {
      var u = apiUrlFromEnv();
      if (u) apiSetUrl(u);
      this.url = u;
      this.on = /^https?:\/\//.test(u);
      this.onState = onState || function () { };
      this.listener = listener || function () { };
      if (this.on) {
        this.pull();
        if (!this.timer) {
          this.timer = setInterval(function () { remote.flush(); remote.pull(); }, POLL_MS);
        }
      }
      this.emit();
      return this.on;
    },

    status: function () {
      if (!this.on) return "off";
      return this.error ? "err" : (this.syncedAt ? "ok" : "wait");
    },

    label: function () {
      var st = this.status();
      if (st === "off") return "⚠️ 동기화 미연결 — 설정에서 API URL 입력";
      if (st === "err") return "🔴 동기화 오류 — 재시도 중";
      if (st === "wait") return "🟡 동기화 연결 중…";
      return "🟢 실시간 동기화" + (this.queue.length ? " · " + this.queue.length + "건 대기" : "");
    },

    emit: function () {
      var st = this.status();
      try { this.listener({ status: st, label: this.label(), error: this.error, syncedAt: this.syncedAt, pending: this.queue.length }); } catch (e) { }
      if (st === "err" && this.lastStatus !== "err") toast("⚠️ 동기화 오류 · " + this.error, "warn");
      if (st === "ok" && this.lastStatus === "err") toast("🟢 동기화가 복구되었습니다", "ok");
      this.lastStatus = st;
    },

    pull: function () {
      if (!this.on || this.inflight || this.busy || this.queue.length) return;
      var self = this;
      self.inflight = true;
      apiReq("GET", { action: "data", rv: self.rosterVersion || "" })
        .then(function (j) {
          self.inflight = false;
          self.error = "";
          self.syncedAt = Date.now();
          if (j.roster) self.rosterVersion = j.rosterVersion || "";
          if (self.queue.length || self.busy) return;
          self.onState({ roster: j.roster || null, records: j.records || [], serverTime: j.serverTime });
          self.emit();
        })
        .catch(function (e) {
          self.inflight = false;
          self.error = errMsg(e);
          self.emit();
        });
    },

    push: function (action, payload) {
      if (!this.on) return false;
      this.queue.push({ action: action, payload: payload || {}, tries: 0 });
      this.emit();
      this.flush();
      return true;
    },

    flush: function () {
      if (!this.on || this.busy || !this.queue.length) return;
      var self = this, job = this.queue[0];
      this.busy = true;
      this.emit();
      apiReq("POST", null, Object.assign({ action: job.action }, job.payload))
        .then(function (j) {
          self.queue.shift();
          self.busy = false;
          self.error = "";
          self.syncedAt = Date.now();
          if (j.roster) self.rosterVersion = j.rosterVersion || "";
          if (!self.queue.length) {
            self.onState({ roster: j.roster || null, records: j.records || [], serverTime: j.serverTime });
          }
          self.emit();
          self.flush();
        })
        .catch(function (e) {
          self.busy = false;
          job.tries++;
          self.error = errMsg(e);
          if (job.tries >= 5) {
            self.queue.shift();
            toast("❌ 저장 실패 · " + (job.action === "enter" ? "입장" : job.action) + " 기록을 서버에 보내지 못했습니다. 다시 시도해 주세요", "err");
          }
          self.emit();
          if (job.tries < 5) setTimeout(function () { self.flush(); }, Math.min(1500 * job.tries, 6000));
        });
    }
  };

  /* ---------- 공용 DOM helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function toast(msg, kind) {
    var wrap = $("#toasts");
    if (!wrap) return;
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0"; el.style.transition = "opacity .25s";
      setTimeout(function () { el.remove(); }, 260);
    }, 2600);
  }
  function newRecordId() { return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  global.RR = {
    K: K, ZONES: ZONES, TOILETS: TOILETS, zone: zone, zoneName: zoneName,
    isToilet: isToilet, isNurse: isNurse, parseZoneParam: parseZoneParam,
    pad: pad, esc: esc, fmtTime: fmtTime, fmtHM: fmtHM, durShort: durShort, durLong: durLong,
    todayKey: todayKey, dateLabel: dateLabel,
    chosungOf: chosungOf, nameMatches: nameMatches,
    idText: idText, idDigits: idDigits, sameStudent: sameStudent, searchRoster: searchRoster,
    activeRecords: activeRecords, overlaps: overlaps, simPartners: simPartners, simPairs: simPairs, avgDuration: avgDuration,
    buildDefaultRoster: buildDefaultRoster, parseRosterText: parseRosterText,
    buildCSV: buildCSV, downloadCSV: downloadCSV,
    store: store, $: $, $$: $$, toast: toast, newRecordId: newRecordId,
    remote: remote, apiSetUrl: apiSetUrl, apiUrlFromEnv: apiUrlFromEnv, idVariants: idVariants
  };
})(window);
