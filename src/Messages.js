/**
 * 사용자에게 보내는 한국어 메시지 템플릿.
 * GAS 서비스 의존성이 없어 Node.js에서도 테스트할 수 있다. (test/run.js)
 */
var Messages = {
  help: function () {
    return [
      '🌴 *휴가봇 사용법*',
      '',
      '*/휴가사용* — 휴가 등록 (명령만 보내면 클릭 양식이 열립니다)',
      '    예) /휴가사용 7/28 10:30-15:30',
      '        /휴가사용 7월28일 오전반차',
      '        /휴가사용 8/3~8/5 일반휴가',
      '        /휴가사용 내일 종일 보건휴가',
      '*/휴가취소* — 등록한 휴가 취소',
      '    예) /휴가취소 7/28',
      '*/휴가조회* — 내 잔여·예정 휴가 (본인에게만 보임)',
      '*/휴가현황* — 특정 날짜의 휴가자 목록',
      '    예) /휴가현황, /휴가현황 내일',
      '*/근무현황* — 근무 시간 막대그래프',
      '    예) /근무현황 (오늘), /근무현황 이번주',
      '*/근무표* — 시간대×사람 근무표',
      '    예) /근무표, /근무표 내일',
      '*/시간표* — 주간 시간표 표 (엑셀 형태, 적용일 반영)',
      '    예) /시간표, /시간표 다음주 월',
      '*/휴가전체현황* — 전체 잔여 휴가 표 (관리자 전용)',
      '',
      '· 날짜: 7/28, 7월28일, 내일, 다음주 월 등 자유롭게 입력',
      '· 시간을 입력하지 않으면 종일 휴가로 등록됩니다',
      '· 주말·공휴일·휴무일은 자동으로 제외됩니다',
      '· 보건휴가는 본인에게만 보이도록 처리됩니다'
    ].join('\n');
  },

  usageShort: function () {
    return '입력 예) /휴가사용 7/28 10:30-15:30 일반휴가\n자세한 사용법은 /휴가도움말';
  },

  noMember: function (email) {
    return '⚠️ 명단 시트에서 회원 정보를 찾지 못했습니다.\n' +
      '관리자에게 명단 시트에 이메일(' + (email || '알 수 없음') + ') 등록을 요청해 주세요.';
  },

  /** 잔여 표시: "104시간 (하루 8시간 기준 13일)", 음수면 "8시간 초과" */
  remainText: function (remainMin, dailyMin) {
    if (remainMin < 0) return TimeUtil.fmtDuration(-remainMin) + ' 초과 ⚠️';
    var t = TimeUtil.fmtDuration(remainMin);
    if (dailyMin > 0) {
      var days = Math.round((remainMin / dailyMin) * 10) / 10;
      t += ' (하루 ' + TimeUtil.toHoursStr(dailyMin) + '시간 기준 ' + days + '일)';
    }
    return t;
  },

  registered: function (o) {
    // o: { name, honorific, typeName, items, totalMin, remains:[{label,remainMin}],
    //      dailyMin, skipped, overBudget, memo }
    var self = this;
    var lines = [];
    var who = o.name + ' ' + o.honorific;

    if (o.items.length === 1) {
      var it = o.items[0];
      lines.push(who + ', ' + it.kdate + ' ' + it.timeText + ' ' + o.typeName +
        ' 등록되었습니다. (사용 ' + TimeUtil.fmtDuration(it.min) + ')');
    } else {
      lines.push(who + ', ' + o.typeName + ' ' + o.items.length + '일이 등록되었습니다.');
      o.items.forEach(function (it) {
        lines.push('• ' + it.kdate + ' ' + it.timeText + ' (' + TimeUtil.fmtDuration(it.min) + ')');
      });
      lines.push('합계 ' + TimeUtil.fmtDuration(o.totalMin));
    }
    (o.remains || []).forEach(function (r) {
      lines.push('남은 ' + r.label + ': ' + self.remainText(r.remainMin, o.dailyMin));
    });
    if (o.memo) lines.push('비고: ' + o.memo);
    if (o.skipped && o.skipped.length) lines.push('※ 제외: ' + o.skipped.join(', '));
    if (o.overBudget) lines.push('⚠️ 잔여 휴가를 초과했습니다. 관리자에게 확인을 요청해 주세요.');
    return lines.join('\n');
  },

  canceled: function (o) {
    // o: { name, honorific, items:[{kdate,timeText,typeName,min}], remains:[{label,remainMin}], dailyMin }
    var self = this;
    var lines = [o.name + ' ' + o.honorific + ', 아래 휴가가 취소되었습니다.'];
    o.items.forEach(function (it) {
      lines.push('• ' + it.kdate + ' ' + it.timeText + ' ' + it.typeName +
        ' (' + TimeUtil.fmtDuration(it.min) + ')');
    });
    o.remains.forEach(function (r) {
      lines.push('남은 ' + r.label + ': ' + self.remainText(r.remainMin, o.dailyMin));
    });
    return lines.join('\n');
  },

  nothingToCancel: function (kdate) {
    return kdate + '에 취소할 휴가가 없습니다. /휴가조회로 등록된 휴가를 확인해 보세요.';
  }
};
