/**
 * 버튼·양식으로 휴가 등록 (Google Chat 대화상자, GAS 전용).
 *
 * Chat API 구성에서 /휴가사용(명령 ID 1)에 "대화상자 열기(Opens a dialog)"를 체크하면
 * /휴가사용 입력 시 날짜·종류를 클릭으로 고르는 양식이 열린다.
 * 체크하지 않아도 /휴가사용을 인자 없이 보내면 양식을 열도록 처리한다.
 * 텍스트 등록("휴가사용 7/28 10:30-15:30")은 그대로 함께 동작한다.
 */

/** 휴가 등록 양식 응답 */
function vacationDialogResponse_(ctx) {
  var typeItems = ctx.types.map(function (t, i) {
    return { text: t.name, value: t.name, selected: i === 0 };
  });
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        dialog: {
          body: {
            sections: [{
              header: '🌴 휴가 등록',
              widgets: [
                { dateTimePicker: { name: 'start', label: '시작일', type: 'DATE_ONLY',
                                    valueMsEpoch: String(Date.now()) } },
                { dateTimePicker: { name: 'end', label: '종료일 (하루만 쓰면 비워두세요)', type: 'DATE_ONLY' } },
                { selectionInput: { name: 'type', label: '휴가 종류', type: 'DROPDOWN', items: typeItems } },
                { selectionInput: { name: 'span', label: '시간', type: 'DROPDOWN', items: [
                  { text: '종일', value: '종일', selected: true },
                  { text: '오전반차', value: '오전반차' },
                  { text: '오후반차', value: '오후반차' },
                  { text: '시간 직접 입력 (아래 칸에 작성)', value: '직접' }
                ] } },
                { textInput: { name: 'time', label: '직접 입력 시간 (예: 10:30-15:30)' } },
                { textInput: { name: 'memo', label: '비고 (선택)' } },
                { buttonList: { buttons: [
                  { text: '등록', onClick: { action: { function: 'submitVacation' } } }
                ] } }
              ]
            }]
          }
        }
      }
    }
  };
}

/** 대화상자 버튼 클릭 처리 (Chat 앱 트리거) */
function onCardClick(event) {
  try {
    var fn = event.common && event.common.invokedFunction;
    if (fn === 'submitVacation') return submitVacation_(event);
    return dialogClose_();
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    return dialogError_('처리 중 오류가 발생했습니다: ' + (e && e.message ? e.message : e));
  }
}

function submitVacation_(event) {
  var user = event.user || {};

  var startMs = formVal_(event, 'start');
  if (!startMs) return dialogError_('시작일을 선택해 주세요.');
  var start = msToDate_(startMs);
  var endMs = formVal_(event, 'end');
  var end = endMs ? msToDate_(endMs) : start;
  if (end < start) { var t = start; start = end; end = t; }

  var parsed = {
    startDate: start, endDate: end, startMin: null, endMin: null,
    halfDay: null, allDay: false,
    type: String(formVal_(event, 'type') || '').trim() || null,
    memo: String(formVal_(event, 'memo') || '').trim()
  };
  var span = String(formVal_(event, 'span') || '종일');
  if (span === '오전반차') parsed.halfDay = 'AM';
  else if (span === '오후반차') parsed.halfDay = 'PM';
  else if (span === '직접') {
    var parts = String(formVal_(event, 'time') || '').replace(/\s/g, '').split(/[-~]/);
    var s = TimeUtil.parseHM(parts[0]), e = TimeUtil.parseHM(parts[1]);
    if (s == null || e == null || e <= s) {
      return dialogError_("시간을 '10:30-15:30' 형식으로 입력해 주세요.");
    }
    parsed.startMin = s; parsed.endMin = e;
  } else {
    parsed.allDay = true;
  }

  var result = withLock_(function () {
    var ctx = SheetRepo.buildCtx(user.email, user.displayName);
    var r = VacationService.register(ctx, parsed);
    if (r.ok) SheetRepo.appendRecords(r.rows);
    return r;
  });
  if (!result.ok) return dialogError_(result.message.replace(/^⚠️\s*/, ''));

  // 대화상자를 닫고 결과를 톡방에 게시 (비공개 종류는 본인에게만)
  var res = { actionResponse: { type: 'NEW_MESSAGE' }, text: result.message };
  if (result.isPrivate && user.name) res.privateMessageViewer = { name: user.name };
  return res;
}

function dialogError_(msg) {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: '⚠️ ' + msg } }
    }
  };
}

function dialogClose_() {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: { actionStatus: { statusCode: 'OK' } }
    }
  };
}

function formVal_(event, name) {
  var fi = event.common && event.common.formInputs && event.common.formInputs[name];
  if (!fi) return null;
  var v = fi[''] || fi;
  if (v.stringInputs && v.stringInputs.value && v.stringInputs.value.length) return v.stringInputs.value[0];
  if (v.dateInput && v.dateInput.msSinceEpoch != null) return Number(v.dateInput.msSinceEpoch);
  if (v.dateTimeInput && v.dateTimeInput.msSinceEpoch != null) return Number(v.dateTimeInput.msSinceEpoch);
  return null;
}

/** DATE_ONLY 선택값(UTC 자정 ms) → 로컬 Date */
function msToDate_(ms) {
  var d = new Date(Number(ms));
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
