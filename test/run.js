/**
 * 순수 로직(Util/Parser/Chart/Messages/VacationService) 테스트.
 * 실행: node test/run.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// GAS 전역 스타일 소스를 전역 스코프로 로드
for (const f of ['Util.js', 'Messages.js', 'Parser.js', 'Chart.js', 'VacationService.js']) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'));
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error(e);
    process.exitCode = 1;
  }
}

const TODAY = new Date(2026, 6, 20); // 2026-07-20 (월)
const TYPES = ['일반휴가', '보건휴가', '논문휴가', '생일휴가', '반기휴가', '병가', '특별휴가'];
const OPTS = { today: TODAY, typeNames: TYPES };

console.log('TimeUtil');
test('parseHM', () => {
  assert.strictEqual(TimeUtil.parseHM('10:30'), 630);
  assert.strictEqual(TimeUtil.parseHM('9시'), 540);
  assert.strictEqual(TimeUtil.parseHM('9시30분'), 570);
  assert.strictEqual(TimeUtil.parseHM('25:00'), null);
});
test('netMinutes: 점심시간 제외', () => {
  const lunch = { start: 780, end: 840, excluded: true }; // 13:00-14:00
  assert.strictEqual(TimeUtil.netMinutes(630, 930, lunch), 240); // 10:30-15:30 → 5h-1h
  assert.strictEqual(TimeUtil.netMinutes(630, 750, lunch), 120); // 점심과 안 겹침
  assert.strictEqual(TimeUtil.netMinutes(630, 930, { ...lunch, excluded: false }), 300);
});
test('fmtDuration / toHoursStr', () => {
  assert.strictEqual(TimeUtil.fmtDuration(90), '1시간 30분');
  assert.strictEqual(TimeUtil.fmtDuration(120), '2시간');
  assert.strictEqual(TimeUtil.toHoursStr(270), '4.5');
});

console.log('Parser');
test('날짜+시간+종류', () => {
  const p = Parser.parse('7/28 10:30-15:30 일반휴가', OPTS);
  assert.strictEqual(DateUtil.ymd(p.startDate), '2026-07-28');
  assert.strictEqual(p.startMin, 630);
  assert.strictEqual(p.endMin, 930);
  assert.strictEqual(p.type, '일반휴가');
  assert.strictEqual(p.allDay, false);
});
test('한국식 날짜 표기', () => {
  const p = Parser.parse('07월28일 10:30~15:30', OPTS);
  assert.strictEqual(DateUtil.ymd(p.startDate), '2026-07-28');
  assert.strictEqual(p.startMin, 630);
});
test('오전반차', () => {
  const p = Parser.parse('7월28일 오전반차', OPTS);
  assert.strictEqual(p.halfDay, 'AM');
  assert.strictEqual(p.startMin, null);
});
test('"오전 반차" 두 토큰', () => {
  assert.strictEqual(Parser.parse('내일 오전 반차', OPTS).halfDay, 'AM');
});
test('반차만 입력하면 오전/오후 확인 요청', () => {
  assert.ok(Parser.parse('내일 반차', OPTS).error);
});
test('기간 등록', () => {
  const p = Parser.parse('8/3~8/5 일반휴가', OPTS);
  assert.strictEqual(DateUtil.ymd(p.startDate), '2026-08-03');
  assert.strictEqual(DateUtil.ymd(p.endDate), '2026-08-05');
  assert.strictEqual(p.allDay, true);
});
test('기간: 물결 앞뒤 공백 허용', () => {
  const p = Parser.parse('8/3 ~ 8/5', OPTS);
  assert.strictEqual(DateUtil.ymd(p.endDate), '2026-08-05');
});
test('상대 날짜', () => {
  assert.strictEqual(DateUtil.ymd(Parser.parse('내일 종일', OPTS).startDate), '2026-07-21');
  assert.strictEqual(DateUtil.ymd(Parser.parse('다음주 월', OPTS).startDate), '2026-07-27');
  assert.strictEqual(DateUtil.ymd(Parser.parse('이번주 금요일', OPTS).startDate), '2026-07-24');
});
test('요일 기간: 다음주 월~금', () => {
  const p = Parser.parse('다음주 월~금', OPTS);
  assert.strictEqual(DateUtil.ymd(p.startDate), '2026-07-27');
  assert.strictEqual(DateUtil.ymd(p.endDate), '2026-07-31');
  const p2 = Parser.parse('다음주 월~다음주 수 일반휴가', OPTS);
  assert.strictEqual(DateUtil.ymd(p2.endDate), '2026-07-29');
  assert.strictEqual(p2.type, '일반휴가');
});
test('지난 날짜는 내년으로 해석', () => {
  assert.strictEqual(DateUtil.ymd(Parser.parse('1/5', OPTS).startDate), '2027-01-05');
});
test('종류 접미사 생략', () => {
  assert.strictEqual(Parser.parse('내일 보건', OPTS).type, '보건휴가');
  assert.strictEqual(Parser.parse('내일 병가', OPTS).type, '병가');
  assert.strictEqual(Parser.parse('내일 논문', OPTS).type, '논문휴가');
  assert.strictEqual(Parser.parse('내일 생일휴가', OPTS).type, '생일휴가');
  assert.strictEqual(Parser.parse('내일 반기', OPTS).type, '반기휴가');
});
test('알 수 없는 토큰은 비고로', () => {
  assert.strictEqual(Parser.parse('내일 병원진료 일반휴가', OPTS).memo, '병원진료');
});
test('날짜 없으면 오류', () => {
  assert.ok(Parser.parse('일반휴가', OPTS).error);
});
test('시간 역순이면 오류', () => {
  assert.ok(Parser.parse('내일 15:00-10:00', OPTS).error);
});

console.log('VacationService');
function makeCtx(overrides) {
  const alloc = {
    일반휴가: 108 * 60, 보건휴가: 8 * 60, 논문휴가: 40 * 60,
    생일휴가: 8 * 60, 반기휴가: 24 * 60, 병가: 0, 특별휴가: 0
  };
  const base = {
    member: { name: '윤지훈', email: 'yoon2839@chilab.kr', birthMonth: 7, alloc },
    members: [
      { name: '윤지훈', email: 'yoon2839@chilab.kr', birthMonth: 7, alloc },
      { name: '김민수', email: 'kim@chilab.kr', birthMonth: 11, alloc }
    ],
    types: [
      { name: '일반휴가', allocMin: 108 * 60, isPublic: true, cycle: 'year', carryover: true },
      { name: '보건휴가', allocMin: 8 * 60, isPublic: false, cycle: 'month' },
      { name: '논문휴가', allocMin: 40 * 60, isPublic: true, cycle: 'year' },
      { name: '생일휴가', allocMin: 8 * 60, isPublic: true, cycle: 'birthmonth' },
      { name: '반기휴가', allocMin: 24 * 60, isPublic: true, cycle: 'half' },
      { name: '병가', allocMin: 0, isPublic: true, cycle: 'year' },
      { name: '특별휴가', allocMin: 0, isPublic: true, cycle: 'year' }
    ],
    settings: {
      workStart: 600, workEnd: 1140, lunchStart: 780, lunchEnd: 840,
      lunchExcluded: true, defaultDailyMin: 480, honorific: '선생님', baseYear: null,
      gridSlotMin: 30
    },
    schedule: {},
    holidays: { '2026-08-17': '대체공휴일' },
    records: [],
    today: TODAY
  };
  return Object.assign(base, overrides);
}

test('시간 지정 등록: 점심 제외 계산', () => {
  const r = VacationService.register(makeCtx(), Parser.parse('7/28 10:30-15:30', OPTS));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0][6], 240); // 5h - 점심 1h
  assert.ok(r.message.includes('윤지훈 선생님'));
  assert.ok(r.message.includes('일반휴가'));
  assert.strictEqual(r.isPrivate, false);
});
test('종일 등록: 기본 근무시간 기준', () => {
  const r = VacationService.register(makeCtx(), Parser.parse('7/28 종일', OPTS));
  assert.strictEqual(r.rows[0][6], 480); // 10:00-19:00 - 점심 1h
});
test('시간표 기반 종일 등록', () => {
  const ctx = makeCtx({ schedule: { 윤지훈: { 2: { start: 600, end: 900 } } } }); // 화요일만 10:00-15:00
  const r = VacationService.register(ctx, Parser.parse('7/28 종일', OPTS)); // 7/28은 화요일
  assert.strictEqual(r.rows[0][6], 240); // 5h - 점심 1h
});
test('시간표 기반: 근무 요일이 아니면 거절', () => {
  const ctx = makeCtx({ schedule: { 윤지훈: { 1: { start: 600, end: 900 }, 3: { start: 600, end: 900 }, 5: { start: 600, end: 900 } } } });
  const r = VacationService.register(ctx, Parser.parse('7/28 종일', OPTS)); // 화요일 = 휴무
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes('휴무일'));
});
test('시간표 기반: 기간 등록 시 휴무 요일 자동 제외', () => {
  // 월·수·금만 근무 → 월~금 등록해도 3일만 등록
  const ctx = makeCtx({ schedule: { 윤지훈: { 1: { start: 600, end: 900 }, 3: { start: 600, end: 900 }, 5: { start: 600, end: 900 } } } });
  const r = VacationService.register(ctx, Parser.parse('다음주 월~금', OPTS));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(r.rows.map(x => x[3]), ['2026-07-27', '2026-07-29', '2026-07-31']);
  assert.strictEqual(r.rows[0][6], 240); // 종일 = 그 사람 시간표(10:00-15:00) 기준 4h
});
test('시간표 기반: 반차는 그날 시간표의 절반', () => {
  const ctx = makeCtx({ schedule: { 윤지훈: { 2: { start: 600, end: 900 } } } }); // 화 10:00-15:00
  const am = VacationService.register(ctx, Parser.parse('7/28 오전반차', OPTS));
  assert.strictEqual(am.rows[0][4], '10:00');
  assert.strictEqual(am.rows[0][5], '12:30');
  assert.strictEqual(am.rows[0][6], 150); // 2.5h (점심 안 겹침)
});
test('기간 등록: 주말·공휴일 자동 제외', () => {
  const r = VacationService.register(makeCtx(), Parser.parse('8/14~8/17', OPTS));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rows.length, 1); // 8/15(토), 8/16(일), 8/17(공휴일) 제외
  assert.strictEqual(r.rows[0][3], '2026-08-14');
  assert.ok(r.message.includes('제외'));
});
test('중복 등록 방지', () => {
  const ctx = makeCtx({
    records: [{ row: 2, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '일반휴가',
                ymd: '2026-07-28', startMin: 600, endMin: 1140, minutes: 480, status: '등록' }]
  });
  const r = VacationService.register(ctx, Parser.parse('7/28 10:30-15:30', OPTS));
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes('겹칩니다'));
});
test('취소된 기록과는 겹쳐도 등록 가능', () => {
  const ctx = makeCtx({
    records: [{ row: 2, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '일반휴가',
                ymd: '2026-07-28', startMin: 600, endMin: 1140, minutes: 480, status: '취소' }]
  });
  assert.strictEqual(VacationService.register(ctx, Parser.parse('7/28 종일', OPTS)).ok, true);
});
test('보건휴가는 비공개 응답', () => {
  const r = VacationService.register(makeCtx(), Parser.parse('7/28 보건휴가', OPTS));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.isPrivate, true);
});
test('잔여 시간 차감 표시', () => {
  const ctx = makeCtx({
    records: [{ row: 2, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '일반휴가',
                ymd: '2026-07-01', startMin: 600, endMin: 1140, minutes: 480, status: '등록' }]
  });
  const r = VacationService.register(ctx, Parser.parse('7/28 10:30-15:30', OPTS));
  // 108h - 8h(기존) - 4h(신규) = 96h
  assert.ok(r.message.includes('96시간'));
});
test('취소', () => {
  const ctx = makeCtx({
    records: [{ row: 5, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '일반휴가',
                ymd: '2026-07-28', startMin: 630, endMin: 930, minutes: 240, status: '등록' }]
  });
  const r = VacationService.cancel(ctx, Parser.parse('7/28', OPTS));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.rowIndexes, [5]);
  assert.ok(r.message.includes('취소'));
});
test('취소할 휴가가 없을 때', () => {
  const r = VacationService.cancel(makeCtx(), Parser.parse('7/28', OPTS));
  assert.strictEqual(r.ok, false);
});
test('조회는 항상 비공개', () => {
  const q = VacationService.query(makeCtx());
  assert.strictEqual(q.isPrivate, true);
  assert.ok(q.message.includes('일반휴가'));
});
test('현황: 비공개 종류는 종류명을 숨김', () => {
  const ctx = makeCtx({
    records: [
      { row: 2, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '보건휴가',
        ymd: '2026-07-28', startMin: 600, endMin: 1140, minutes: 480, status: '등록' },
      { row: 3, name: '김민수', email: 'kim@chilab.kr', type: '일반휴가',
        ymd: '2026-07-28', startMin: 630, endMin: 930, minutes: 240, status: '등록' }
    ]
  });
  const s = VacationService.status(ctx, new Date(2026, 6, 28));
  assert.ok(!s.message.includes('보건'));
  assert.ok(s.message.includes('윤지훈'));
  assert.ok(s.message.includes('일반휴가'));
});
test('근무 현황 그래프', () => {
  const ctx = makeCtx({
    records: [{ row: 2, name: '김민수', email: 'kim@chilab.kr', type: '일반휴가',
                ymd: '2026-07-20', startMin: 600, endMin: 870, minutes: 240, status: '등록' }]
  });
  const c = VacationService.workChartDay(ctx, TODAY);
  assert.ok(c.message.includes('▇'));
  assert.ok(c.message.includes('윤지훈'));
  assert.ok(c.message.includes('🌴'));
  assert.ok(!c.message.includes('일반휴가')); // 그래프에는 휴가 종류를 노출하지 않음
});
test('공휴일에는 근무 그래프 대신 안내', () => {
  const c = VacationService.workChartDay(makeCtx(), new Date(2026, 7, 17));
  assert.ok(c.message.includes('대체공휴일'));
});
test('관리자 전체 잔여 표', () => {
  const ctx = makeCtx({
    records: [{ row: 2, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '일반휴가',
                ymd: '2026-07-01', startMin: 600, endMin: 840, minutes: 240, status: '등록' }]
  });
  const a = VacationService.adminSummary(ctx);
  assert.strictEqual(a.isPrivate, true);
  // 부여 0인 병가·특별휴가 제외
  assert.deepStrictEqual(a.typeNames, ['일반휴가', '보건휴가', '논문휴가', '생일휴가', '반기휴가']);
  assert.ok(a.message.includes('윤지훈'));
  assert.ok(a.message.includes('김민수'));
  assert.ok(a.message.includes('104/108h')); // 108h - 4h 사용
  assert.ok(a.message.includes('8/8h'));     // 보건휴가(월간) 미사용
});
test('반기휴가: 상·하반기 예산이 분리됨', () => {
  const ctx = makeCtx({
    records: [{ row: 2, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '반기휴가',
                ymd: '2026-03-02', startMin: 600, endMin: 1140, minutes: 480, status: '등록' }]
  });
  // 상반기에 8h를 썼어도 하반기 예산은 24h 그대로
  const r = VacationService.register(ctx, Parser.parse('12/21 종일 반기휴가', OPTS));
  assert.strictEqual(r.ok, true);
  assert.ok(r.message.includes('반기휴가(하반기)'));
  assert.ok(r.message.includes('16시간')); // 24h - 8h
});
test('생일휴가: 생일 달에만 사용 가능', () => {
  const ok = VacationService.register(makeCtx(), Parser.parse('7/28 생일휴가', OPTS)); // 생일 7월
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.message.includes('생일휴가(7월)'));

  const wrong = VacationService.register(makeCtx(), Parser.parse('8/3 생일휴가', OPTS));
  assert.strictEqual(wrong.ok, false);
  assert.ok(wrong.message.includes('7월에만'));

  const noBirth = makeCtx();
  noBirth.member = Object.assign({}, noBirth.member, { birthMonth: null });
  const nb = VacationService.register(noBirth, Parser.parse('7/28 생일휴가', OPTS));
  assert.strictEqual(nb.ok, false);
  assert.ok(nb.message.includes('생일을 등록'));
});
test('보건휴가: 매달 8h, 달이 바뀌면 새 예산', () => {
  const ctx = makeCtx({
    records: [{ row: 2, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '보건휴가',
                ymd: '2026-07-01', startMin: 600, endMin: 1140, minutes: 480, status: '등록' }]
  });
  const july = VacationService.register(ctx, Parser.parse('7/28 종일 보건휴가', OPTS));
  assert.strictEqual(july.ok, true); // 등록은 되지만 초과 경고
  assert.ok(july.message.includes('초과'));

  const aug = VacationService.register(ctx, Parser.parse('8/3 종일 보건휴가', OPTS));
  assert.strictEqual(aug.ok, true);
  assert.ok(aug.message.includes('보건휴가(8월)'));
  assert.ok(!aug.message.includes('초과'));
});
test('일반휴가: 기준연도부터 이월 누적', () => {
  const ctx = makeCtx();
  ctx.settings = Object.assign({}, ctx.settings, { baseYear: 2025 });
  const r = VacationService.register(ctx, Parser.parse('7/28 10:30-15:30', OPTS));
  assert.strictEqual(r.ok, true);
  assert.ok(r.message.includes('이월 포함'));
  assert.ok(r.message.includes('212시간')); // 108h×2년 - 4h
});
test('근무표: 시간대×사람, 휴가·점심·휴무 표시', () => {
  const ctx = makeCtx({
    schedule: {
      윤지훈: { 1: { start: 600, end: 1140 } },  // 월 10:00-19:00
      김민수: { 1: { start: 780, end: 1260 } }   // 월 13:00-21:00
    },
    records: [{ row: 2, name: '윤지훈', email: 'yoon2839@chilab.kr', type: '일반휴가',
                ymd: '2026-07-20', startMin: 600, endMin: 720, minutes: 120, status: '등록' }]
  });
  const g = VacationService.workGridDay(ctx, TODAY); // 2026-07-20(월)
  assert.ok(g.message.includes('근무표'));
  assert.ok(g.message.includes('윤지훈'));
  assert.ok(g.message.includes('10:00'));
  assert.ok(g.message.includes('10:30')); // 30분 단위
  assert.ok(g.message.includes('20:30'));
  assert.ok(g.message.includes('휴'));  // 윤지훈 10-12시 휴가
  assert.ok(g.message.includes('●'));
  assert.ok(g.message.includes('─'));  // 점심(13:00) 표시
  const gh = VacationService.workGridDay(ctx, new Date(2026, 7, 17)); // 공휴일
  assert.ok(gh.message.includes('대체공휴일'));
});
test('주간 그래프', () => {
  const c = VacationService.workChartWeek(makeCtx(), TODAY);
  assert.ok(c.message.includes('월'));
  assert.ok(c.message.includes('금'));
  assert.ok(c.message.includes('▇'));
});

console.log('\n' + passed + '개 테스트 통과' + (process.exitCode ? ' (실패 있음)' : ''));
