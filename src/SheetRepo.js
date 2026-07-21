/**
 * 구글 시트 읽기/쓰기. (GAS 전용 — Node 테스트 대상 아님)
 *
 * 시트 구성은 Setup.js의 setupSheets()가 자동 생성한다.
 *  - 설정:     항목 | 값 | 설명
 *  - 휴가종류: 종류 | 연간부여(시간) | 공개여부
 *  - 명단:     이름 | 이메일 | (휴가종류명과 같은 헤더의 열은 개인별 부여시간 재정의)
 *  - 시간표:   이름 | 월 | 화 | 수 | 목 | 금 | (토 | 일)   — 셀 예: 10:00-19:00, 빈칸=휴무
 *  - 휴가기록: 등록일시 | 이름 | 이메일 | 종류 | 날짜 | 시작 | 종료 | 사용(분) | 상태 | 비고
 *  - 공휴일:   날짜 | 명칭
 */
var SheetRepo = (function () {
  // 스프레드시트에 바인딩된 스크립트가 아니라면 여기에 시트 ID를 넣는다.
  var SPREADSHEET_ID = '';

  var SHEET = {
    settings: '설정', types: '휴가종류', members: '명단',
    timetable: '시간표', records: '휴가기록', holidays: '공휴일'
  };

  function ss() {
    return SPREADSHEET_ID
      ? SpreadsheetApp.openById(SPREADSHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();
  }

  function sheet(name) {
    var sh = ss().getSheetByName(name);
    if (!sh) throw new Error("'" + name + "' 시트가 없습니다. Apps Script에서 setupSheets()를 먼저 실행해 주세요.");
    return sh;
  }

  function values(name) {
    var sh = sheet(name);
    var last = sh.getLastRow();
    if (last < 2) return [];
    return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  }

  /** 시트 셀 값(문자열/Date/시트 시간 실수)을 자정 기준 분으로 */
  function cellToMin(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.getHours() * 60 + v.getMinutes();
    if (typeof v === 'number') return Math.round(v * 24 * 60) % (24 * 60); // 시트 시간 serial
    return TimeUtil.parseHM(String(v));
  }

  /** 시트 셀 값(문자열/Date)을 "yyyy-MM-dd"로 */
  function cellToYmd(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return DateUtil.ymd(v);
    var d = DateUtil.fromYmd(String(v).trim());
    return d ? DateUtil.ymd(d) : null;
  }

  function getSettings() {
    var map = {};
    values(SHEET.settings).forEach(function (r) {
      if (r[0]) map[String(r[0]).trim()] = r[1];
    });
    return {
      workStart: cellToMin(map['근무시작']) != null ? cellToMin(map['근무시작']) : 600,   // 10:00
      workEnd: cellToMin(map['근무종료']) != null ? cellToMin(map['근무종료']) : 1140,   // 19:00
      lunchStart: cellToMin(map['점심시작']) != null ? cellToMin(map['점심시작']) : 780, // 13:00
      lunchEnd: cellToMin(map['점심종료']) != null ? cellToMin(map['점심종료']) : 840,   // 14:00
      lunchExcluded: String(map['점심제외'] == null ? 'TRUE' : map['점심제외']).toUpperCase() !== 'FALSE',
      defaultDailyMin: (Number(map['기본근무시간']) || 8) * 60,
      honorific: String(map['호칭'] || '선생님').trim(),
      noticeHour: Number(map['공지시간']) || 8,
      webhookUrl: String(map['웹훅URL'] || '').trim(),
      adminEmails: String(map['관리자'] || '').toLowerCase().split(/[,;\s]+/).filter(Boolean),
      baseYear: Number(map['기준연도']) || null
    };
  }

  var CYCLE_MAP = { '연간': 'year', '반기': 'half', '월간': 'month', '매월': 'month', '생일월': 'birthmonth', '생일': 'birthmonth' };

  function getTypes() {
    return values(SHEET.types)
      .filter(function (r) { return r[0]; })
      .map(function (r) {
        return {
          name: String(r[0]).trim(),
          allocMin: Math.round((Number(r[1]) || 0) * 60),
          isPublic: String(r[2] == null ? '공개' : r[2]).trim() !== '비공개',
          cycle: CYCLE_MAP[String(r[3] == null ? '' : r[3]).trim()] || 'year',
          carryover: /^(TRUE|O|Y|이월|예)$/i.test(String(r[4] == null ? '' : r[4]).trim())
        };
      });
  }

  /** 생일 셀(Date/"7/28"/"1998-07-28"/"7월28일"/숫자 7) → 월(1~12) */
  function parseBirthMonth(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.getMonth() + 1;
    if (typeof v === 'number') return (v >= 1 && v <= 12) ? Math.round(v) : null;
    var s = String(v).trim();
    var m = s.match(/^(\d{4})[-./](\d{1,2})/);
    if (m) return +m[2];
    m = s.match(/^(\d{1,2})\s*[-./월]/) || s.match(/^(\d{1,2})$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) return +m[1];
    return null;
  }

  function getMembers(types) {
    var sh = sheet(SHEET.members);
    var last = sh.getLastRow();
    if (last < 2) return [];
    var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var typeNames = types.map(function (t) { return t.name; });

    var birthIdx = -1;
    header.forEach(function (h, i) {
      if (h.replace(/\(.*\)$/, '').trim() === '생일') birthIdx = i;
    });

    return rows.filter(function (r) { return r[0]; }).map(function (r) {
      var alloc = {};
      types.forEach(function (t) { alloc[t.name] = t.allocMin; });
      header.forEach(function (h, i) {
        var name = h.replace(/\(.*\)$/, '').trim(); // "일반휴가(시간)" → "일반휴가"
        if (typeNames.indexOf(name) !== -1 && r[i] !== '' && r[i] != null && !isNaN(Number(r[i]))) {
          alloc[name] = Math.round(Number(r[i]) * 60);
        }
      });
      return {
        name: String(r[0]).trim(),
        email: String(r[1] || '').trim().toLowerCase(),
        birthMonth: birthIdx === -1 ? null : parseBirthMonth(r[birthIdx]),
        alloc: alloc
      };
    });
  }

  function getSchedule() {
    var sh = sheet(SHEET.timetable);
    var last = sh.getLastRow();
    if (last < 2) return {};
    var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    var rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    var map = {};
    rows.forEach(function (r) {
      if (!r[0]) return;
      var tt = {};
      header.forEach(function (h, i) {
        var day = DateUtil.WEEKDAYS.indexOf(h.trim().replace(/요일$/, ''));
        if (day === -1) return;
        var cell = String(r[i] == null ? '' : r[i]).trim();
        if (!cell || cell === '휴무') return;
        var parts = cell.replace(/\s/g, '').split(/[-~]/);
        var s = TimeUtil.parseHM(parts[0]), e = TimeUtil.parseHM(parts[1]);
        if (s != null && e != null && e > s) tt[day] = { start: s, end: e };
      });
      map[String(r[0]).trim()] = tt;
    });
    return map;
  }

  function getHolidays() {
    var map = {};
    values(SHEET.holidays).forEach(function (r) {
      var ymd = cellToYmd(r[0]);
      if (ymd) map[ymd] = String(r[1] || '공휴일');
    });
    return map;
  }

  function getRecords() {
    return values(SHEET.records).map(function (r, i) {
      return {
        row: i + 2, // 시트 행 번호
        name: String(r[1] || '').trim(),
        email: String(r[2] || '').trim().toLowerCase(),
        type: String(r[3] || '').trim(),
        ymd: cellToYmd(r[4]),
        startMin: cellToMin(r[5]) || 0,
        endMin: cellToMin(r[6]) || 0,
        minutes: Number(r[7]) || 0,
        status: String(r[8] || '').trim()
      };
    }).filter(function (r) { return r.ymd; });
  }

  return {
    SHEET: SHEET,
    ss: ss,
    sheet: sheet,
    getSettings: getSettings,

    /** 명령 처리에 필요한 모든 데이터를 한 번에 읽는다 */
    buildCtx: function (email, displayName) {
      var settings = getSettings();
      var types = getTypes();
      var members = getMembers(types);
      var member = null;
      var lowered = String(email || '').trim().toLowerCase();
      members.forEach(function (m) {
        if (member) return;
        if (lowered && m.email === lowered) member = m;
      });
      if (!member && displayName) {
        members.forEach(function (m) {
          if (member) return;
          if (m.name && displayName.indexOf(m.name) !== -1) member = m;
        });
      }
      return {
        member: member, members: members, types: types, settings: settings,
        schedule: getSchedule(), holidays: getHolidays(), records: getRecords(),
        today: DateUtil.dayStart(new Date())
      };
    },

    /** rows: [이름, 이메일, 종류, 날짜, 시작, 종료, 분, 상태, 비고] — 등록일시는 여기서 붙인다 */
    appendRecords: function (rows) {
      var sh = sheet(SHEET.records);
      var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      var out = rows.map(function (r) { return [now].concat(r); });
      sh.getRange(sh.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
    },

    cancelRecords: function (rowIndexes) {
      var sh = sheet(SHEET.records);
      rowIndexes.forEach(function (row) {
        sh.getRange(row, 9).setValue('취소'); // 9열 = 상태
      });
    }
  };
})();
