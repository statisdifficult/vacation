/**
 * 텍스트 막대그래프 (구글챗 코드블록에 표시).
 * GAS 서비스 의존성이 없어 Node.js에서도 테스트할 수 있다. (test/run.js)
 */
var ChartText = (function () {
  var BAR_WIDTH = 12; // 최대 막대 길이(칸)

  /** 한글은 2칸, 영문·숫자는 1칸으로 계산한 표시 폭 */
  function displayWidth(str) {
    var w = 0;
    for (var i = 0; i < str.length; i++) {
      w += str.charCodeAt(i) > 0x2000 ? 2 : 1;
    }
    return w;
  }

  function pad(str, width) {
    var out = str;
    while (displayWidth(out) < width) out += ' ';
    return out;
  }

  /** 막대 + 뒤쪽 공백 패딩 (▇는 코드블록에서 1칸이므로 글자 수로 패딩) */
  function bar(min, maxMin) {
    var units = (maxMin <= 0 || min <= 0)
      ? 0
      : Math.max(1, Math.round((min / maxMin) * BAR_WIDTH));
    return '▇'.repeat(units) + ' '.repeat(BAR_WIDTH - units + 1);
  }

  return {
    displayWidth: displayWidth,

    /** 등폭 텍스트 표. headers: [...], rows: [[...], ...] */
    buildTable: function (headers, rows) {
      var all = [headers].concat(rows);
      var widths = headers.map(function (_, c) {
        return Math.max.apply(null, all.map(function (r) { return displayWidth(String(r[c])); }));
      });
      var lines = all.map(function (r) {
        return r.map(function (cell, c) { return pad(String(cell), widths[c]); }).join('  ').replace(/\s+$/, '');
      });
      lines.splice(1, 0, widths.map(function (w) { return '─'.repeat(w); }).join('  '));
      return '```\n' + lines.join('\n') + '\n```';
    },

    /**
     * 하루 근무 현황 (개인별).
     * rows: [{ name, workMin, schedText, note }]
     *   - schedText: "10:00-19:00" 또는 null(휴무)
     *   - note: '🌴반차 2시간' 등 부가 표시
     */
    buildDayChart: function (title, rows) {
      var maxMin = 0, nameW = 0;
      rows.forEach(function (r) {
        if (r.workMin > maxMin) maxMin = r.workMin;
        var w = displayWidth(r.name);
        if (w > nameW) nameW = w;
      });
      if (maxMin <= 0) maxMin = 480;

      var lines = rows.map(function (r) {
        var head = pad(r.name, nameW + 1);
        if (!r.schedText) return head + '휴무';
        if (r.workMin <= 0) return head + '휴가(종일)';
        var line = head + bar(r.workMin, maxMin) + TimeUtil.toHoursStr(r.workMin) + 'h  ' + r.schedText;
        if (r.note) line += ' ' + r.note;
        return line;
      });
      return title + '\n```\n' + lines.join('\n') + '\n```';
    },

    /**
     * 주간 근무 시간 (요일별 합계).
     * days: [{ label: '월 7/20', totalMin, offCount, holiday }]
     */
    buildWeekChart: function (title, days) {
      var maxMin = 0, labelW = 0;
      days.forEach(function (d) {
        if (d.totalMin > maxMin) maxMin = d.totalMin;
        var w = displayWidth(d.label);
        if (w > labelW) labelW = w;
      });
      if (maxMin <= 0) maxMin = 480;

      var lines = days.map(function (d) {
        var head = pad(d.label, labelW + 1);
        if (d.holiday) return head + '공휴일';
        var line = head + bar(d.totalMin, maxMin) + TimeUtil.toHoursStr(d.totalMin) + 'h';
        if (d.offCount > 0) line += ' (휴가 ' + d.offCount + '명)';
        return line;
      });
      return title + '\n```\n' + lines.join('\n') + '\n```';
    }
  };
})();
