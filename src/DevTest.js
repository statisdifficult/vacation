/**
 * Chat 앱 등록 없이 Apps Script 편집기에서 봇을 실험하는 함수. (GAS 전용)
 *
 * 사용법:
 *  1. setupSheets()를 실행해 시트를 만들고, 명단 시트에 본인 이메일이 있는지 확인
 *  2. 아래 TEST_INPUT을 원하는 명령으로 바꾼다
 *  3. 편집기에서 devRun 함수를 실행하고 로그(Ctrl+Enter)에서 봇 응답을 확인
 *     — 실제 시트(휴가기록)에도 그대로 기록되므로 결과를 시트에서도 볼 수 있다
 */
var TEST_INPUT = '휴가사용 다음주 화 10:30-15:30 일반휴가';

function devRun() {
  devSend_(TEST_INPUT);
}

/** 여러 명령을 한 번에 실험해 보고 싶을 때 실행 */
function devRunScenario() {
  devSend_('휴가도움말');
  devSend_('휴가사용 다음주 화 10:30-15:30');
  devSend_('휴가사용 다음주 수 종일 보건휴가');
  devSend_('휴가조회');
  devSend_('휴가현황 다음주 화');
  devSend_('근무현황');
  devSend_('근무현황 이번주');
  devSend_('휴가취소 다음주 화');
}

function devSend_(text) {
  var email = Session.getActiveUser().getEmail();
  var event = {
    message: { text: text },
    user: { email: email, displayName: email, name: 'users/dev-test' }
  };
  var res = onMessage(event);
  console.log('▶ ' + text +
    (res && res.privateMessageViewer ? '   🔒(본인에게만 보임)' : '   (톡방 전체 공개)') +
    '\n' + (res && res.text ? res.text : JSON.stringify(res)) + '\n');
}
