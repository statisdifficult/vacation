/**
 * 매일 아침 자동 공지 (GAS 전용).
 *
 * 사용법:
 *  1. 설정 시트의 '웹훅URL'에 공지를 보낼 스페이스의 Webhook URL을 넣는다.
 *     (스페이스 → 앱 및 통합 → 웹훅 관리 → 웹훅 추가)
 *  2. Apps Script 편집기에서 installDailyTrigger()를 한 번 실행한다.
 *     (설정 시트의 '공지시간' 시각에 매일 postDailyNotice가 실행된다)
 */
function postDailyNotice() {
  var settings = SheetRepo.getSettings();
  if (!settings.webhookUrl) {
    console.warn('설정 시트에 웹훅URL이 없어 공지를 건너뜁니다.');
    return;
  }

  var ctx = SheetRepo.buildCtx(null, null);
  var today = ctx.today;
  var ymd = DateUtil.ymd(today);
  if (DateUtil.isWeekend(today) && !hasWeekendSchedule_(ctx)) return;
  if (ctx.holidays[ymd]) return;

  var parts = [VacationService.workChartDay(ctx, today).message];
  var statusMsg = VacationService.status(ctx, today).message;
  parts.push(statusMsg);

  UrlFetchApp.fetch(settings.webhookUrl, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: parts.join('\n\n') })
  });
}

function hasWeekendSchedule_(ctx) {
  var day = ctx.today.getDay();
  return Object.keys(ctx.schedule).some(function (n) { return !!ctx.schedule[n][day]; });
}

/** 매일 아침 공지 트리거 설치 (편집기에서 한 번 실행) */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'postDailyNotice') ScriptApp.deleteTrigger(t);
  });
  var hour = SheetRepo.getSettings().noticeHour;
  ScriptApp.newTrigger('postDailyNotice').timeBased().atHour(hour).everyDays(1).create();
  console.log('매일 ' + hour + '시 공지 트리거를 설치했습니다.');
}
