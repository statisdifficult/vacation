/**
 * 시간·날짜 유틸리티.
 * GAS 서비스 의존성이 없어 Node.js에서도 테스트할 수 있다. (test/run.js)
 */
var TimeUtil = {
  /** "10:30" | "10시30분" | "10시" → 자정 기준 분. 실패 시 null */
  parseHM: function (s) {
    if (s == null || s === '') return null;
    var t = String(s).trim();
    var m = t.match(/^([01]?\d|2[0-3]):([0-5]\d)$/) ||
            t.match(/^([01]?\d|2[0-3])시(?:([0-5]?\d)분?)?$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2] || 0);
  },

  /** 630 → "10:30" */
  fmtHM: function (min) {
    var h = Math.floor(min / 60), m = min % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  },

  /** 630 → "10:30", 정각이면 "10" (시간표 셀 압축 표기용) */
  fmtShortHM: function (min) {
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + ':' + (m < 10 ? '0' : '') + m : String(h);
  },

  /** 두 구간 [aS,aE), [bS,bE)이 겹치는 분 */
  overlapMin: function (aS, aE, bS, bE) {
    return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
  },

  /** 점심시간(lunch = {start, end, excluded})을 제외한 실제 사용 분 */
  netMinutes: function (startMin, endMin, lunch) {
    var total = Math.max(0, endMin - startMin);
    if (lunch && lunch.excluded) {
      total -= this.overlapMin(startMin, endMin, lunch.start, lunch.end);
    }
    return Math.max(0, total);
  },

  /** 90 → "1시간 30분", 120 → "2시간", 30 → "30분" */
  fmtDuration: function (min) {
    var h = Math.floor(min / 60), m = min % 60;
    if (h && m) return h + '시간 ' + m + '분';
    if (h) return h + '시간';
    return m + '분';
  },

  /** 분 → 시간 숫자 문자열 (270 → "4.5") */
  toHoursStr: function (min) {
    return String(Math.round((min / 60) * 100) / 100);
  }
};

var DateUtil = {
  WEEKDAYS: ['일', '월', '화', '수', '목', '금', '토'],

  /** Date → "2026-07-28" */
  ymd: function (d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },

  /** "2026-07-28" → Date */
  fromYmd: function (s) {
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  },

  /** Date → "7/28(화)" */
  kdate: function (d) {
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + this.WEEKDAYS[d.getDay()] + ')';
  },

  addDays: function (d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  },

  /** 시각 성분을 제거한 그날 0시 */
  dayStart: function (d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  },

  isWeekend: function (d) {
    return d.getDay() === 0 || d.getDay() === 6;
  },

  /** 그 주의 월요일 */
  monday: function (d) {
    var dow = d.getDay();
    return this.addDays(d, dow === 0 ? -6 : 1 - dow);
  }
};
