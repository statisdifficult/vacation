/**
 * Google Chat 이벤트 핸들러 (GAS 전용).
 *
 * Google Chat API 구성에서 슬래시 명령을 아래 ID로 등록한다.
 *   1 /휴가사용   2 /휴가취소   3 /휴가조회   4 /휴가현황   5 /근무현황   6 /휴가도움말
 * 슬래시 명령을 등록하지 않아도 "휴가사용 7/28 …"처럼 텍스트로 입력하면 동작한다.
 */
var SLASH_COMMANDS = { 1: 'use', 2: 'cancel', 3: 'query', 4: 'status', 5: 'work', 6: 'help', 7: 'admin' };
var TEXT_COMMANDS = {
  '휴가사용': 'use', '휴가등록': 'use', '휴가신청': 'use',
  '휴가취소': 'cancel', '휴가조회': 'query', '휴가현황': 'status',
  '근무현황': 'work', '근무표': 'work',
  '휴가전체현황': 'admin', '전체현황': 'admin', '잔여현황': 'admin',
  '휴가도움말': 'help', '도움말': 'help', 'help': 'help'
};

function onMessage(event) {
  try {
    return handleMessage_(event);
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    return { text: '⚠️ 처리 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e) };
  }
}

function onAddedToSpace(event) {
  return { text: '안녕하세요, 휴가봇입니다! 🌴\n\n' + Messages.help() };
}

function onRemovedFromSpace(event) {}

function handleMessage_(event) {
  var msg = event.message || {};
  var text = String(msg.text || '').trim();
  var args = msg.argumentText != null ? String(msg.argumentText).trim() : '';

  var cmd = null;
  if (msg.slashCommand && SLASH_COMMANDS[String(msg.slashCommand.commandId)]) {
    cmd = SLASH_COMMANDS[String(msg.slashCommand.commandId)];
  } else {
    // 봇 멘션 등을 제거한 뒤 첫 단어에서 명령을 찾는다
    var body = (args || text).replace(/^@\S+\s*/, '');
    var m = body.match(/^\/?(\S+)\s*([\s\S]*)$/);
    if (m && TEXT_COMMANDS[m[1]]) {
      cmd = TEXT_COMMANDS[m[1]];
      args = m[2].trim();
    }
  }
  if (!cmd) return reply_(event, Messages.help(), true);

  var user = event.user || {};
  var ctx = SheetRepo.buildCtx(user.email, user.displayName);
  var parserOpts = {
    today: ctx.today,
    typeNames: ctx.types.map(function (t) { return t.name; })
  };

  switch (cmd) {
    case 'help':
      return reply_(event, Messages.help(), true);

    case 'use': {
      if (!args) return reply_(event, '⚠️ 등록할 휴가를 입력해 주세요.\n' + Messages.usageShort(), true);
      var result = withLock_(function () {
        // 잠금 안에서 최신 데이터로 다시 판단해 동시 등록 충돌을 막는다
        var fresh = SheetRepo.buildCtx(user.email, user.displayName);
        var r = VacationService.register(fresh, Parser.parse(args, parserOpts));
        if (r.ok) SheetRepo.appendRecords(r.rows);
        return r;
      });
      return reply_(event, result.message, !result.ok || result.isPrivate);
    }

    case 'cancel': {
      if (!args) return reply_(event, '⚠️ 취소할 날짜를 입력해 주세요. 예) /휴가취소 7/28', true);
      var result2 = withLock_(function () {
        var fresh = SheetRepo.buildCtx(user.email, user.displayName);
        var r = VacationService.cancel(fresh, Parser.parse(args, parserOpts));
        if (r.ok) SheetRepo.cancelRecords(r.rowIndexes);
        return r;
      });
      return reply_(event, result2.message, !result2.ok || result2.isPrivate);
    }

    case 'query':
      return reply_(event, VacationService.query(ctx).message, true);

    case 'admin': {
      var lowered = String(user.email || '').toLowerCase();
      if (ctx.settings.adminEmails.indexOf(lowered) === -1) {
        return reply_(event, '⚠️ 관리자만 사용할 수 있는 명령입니다. (설정 시트의 \'관리자\'에 등록된 이메일만 가능)', true);
      }
      return reply_(event, VacationService.adminSummary(ctx).message, true);
    }

    case 'status': {
      var date = ctx.today;
      if (args) {
        var p = Parser.parse(args, parserOpts);
        if (p.error) return reply_(event, '⚠️ ' + p.error, true);
        date = p.startDate;
      }
      return reply_(event, VacationService.status(ctx, date).message, false);
    }

    case 'work': {
      if (/이번\s*주|주간/.test(args)) {
        return reply_(event, VacationService.workChartWeek(ctx, ctx.today).message, false);
      }
      var wdate = ctx.today;
      if (args) {
        var wp = Parser.parse(args, parserOpts);
        if (wp.error) return reply_(event, '⚠️ ' + wp.error, true);
        wdate = wp.startDate;
      }
      return reply_(event, VacationService.workChartDay(ctx, wdate).message, false);
    }
  }
}

/**
 * 응답 메시지. isPrivate=true면 스페이스에서 본인에게만 보인다.
 * (보건휴가 등록/취소, /휴가조회, 오류 안내가 여기에 해당)
 */
function reply_(event, text, isPrivate) {
  var res = { text: text };
  if (isPrivate && event.user && event.user.name) {
    res.privateMessageViewer = { name: event.user.name };
  }
  return res;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
