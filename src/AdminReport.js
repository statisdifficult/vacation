/**
 * 관리자용 잔여현황 시트. (GAS 전용)
 *
 * refreshAdminSheet()가 '잔여현황' 시트에 전체 구성원의 종류별 부여·사용·잔여를 표로 쓴다.
 *  - 스프레드시트를 열면 상단 메뉴 [휴가봇 🌴] → [잔여현황 갱신]으로 언제든 갱신
 *  - 매일 아침 공지 트리거(postDailyNotice)에서도 자동 갱신
 * 관리자는 시트만 열면 되고, 시트 공유 권한으로 접근을 통제한다.
 */
var ADMIN_SHEET_NAME = '잔여현황';

function refreshAdminSheet() {
  var ctx = SheetRepo.buildCtx(null, null);
  var summary = VacationService.adminSummary(ctx);

  var header = ['이름'];
  summary.typeNames.forEach(function (tn) {
    header.push(tn + ' 부여(시간)', tn + ' 사용(시간)', tn + ' 잔여(시간)', tn + ' 잔여(일)');
  });

  var dailyMin = ctx.settings.defaultDailyMin;
  var rows = summary.table.map(function (r) {
    var row = [r.name];
    r.cells.forEach(function (c) {
      if (!c) { row.push('-', '-', '-', '-'); return; }
      row.push(
        Number(TimeUtil.toHoursStr(c.alloc)),
        Number(TimeUtil.toHoursStr(c.used)),
        Number(TimeUtil.toHoursStr(c.remain)),
        dailyMin > 0 ? Math.round((c.remain / dailyMin) * 10) / 10 : '-'
      );
    });
    return row;
  });

  var ss = SheetRepo.ss();
  var sh = ss.getSheetByName(ADMIN_SHEET_NAME) || ss.insertSheet(ADMIN_SHEET_NAME);
  sh.clearContents();
  var all = [header].concat(rows);
  sh.getRange(1, 1, all.length, header.length).setValues(all);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(all.length + 2, 1).setValue(
    '마지막 갱신: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') +
    ' (' + ctx.today.getFullYear() + '년 기준, 상태=등록 기록만 집계)'
  );
  sh.autoResizeColumns(1, header.length);
}

/** 스프레드시트를 열 때 메뉴 추가 (바인딩된 스크립트에서 자동 실행) */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('휴가봇 🌴')
    .addItem('잔여현황 갱신', 'refreshAdminSheet')
    .addToUi();
}
