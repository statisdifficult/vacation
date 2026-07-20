/**
 * 휴가봇 대화 시뮬레이터 — 구글 계정/앱 등록 없이 터미널에서 봇과 대화해 본다.
 * 실행: node test/simulate.js
 *
 * 봇 명령 외에 시뮬레이터 전용 명령:
 *   사용자 <이름>   다른 사람으로 전환 (예: 사용자 김민수)
 *   기록            휴가기록 시트 내용 보기
 *   종료            끝내기
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

for (const f of ['Util.js', 'Messages.js', 'Parser.js', 'Chart.js', 'VacationService.js']) {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'));
}

// ── 가상의 시트 데이터 (setupSheets()가 만드는 구조와 동일) ──────────────
const types = [
  { name: '일반휴가', allocMin: 108 * 60, isPublic: true },
  { name: '보건휴가', allocMin: 96 * 60, isPublic: false },
  { name: '병가', allocMin: 0, isPublic: true },
  { name: '특별휴가', allocMin: 0, isPublic: true }
];
const alloc = {};
types.forEach(t => { alloc[t.name] = t.allocMin; });

const members = [
  { name: '윤지훈', email: 'yoon2839@chilab.kr', alloc },
  { name: '김민수', email: 'kim@chilab.kr', alloc },
  { name: '이서연', email: 'lee@chilab.kr', alloc }
];

// 요일: 0=일 … 6=토. 이서연은 월·수·금만 근무하는 예시
const schedule = {
  윤지훈: { 1: hm('10:00', '19:00'), 2: hm('10:00', '19:00'), 3: hm('10:00', '19:00'), 4: hm('10:00', '19:00'), 5: hm('10:00', '19:00') },
  김민수: { 1: hm('13:00', '21:00'), 2: hm('13:00', '21:00'), 3: hm('13:00', '21:00'), 4: hm('13:00', '21:00'), 5: hm('13:00', '18:00') },
  이서연: { 1: hm('10:00', '15:00'), 3: hm('10:00', '15:00'), 5: hm('10:00', '15:00') }
};
function hm(a, b) { return { start: TimeUtil.parseHM(a), end: TimeUtil.parseHM(b) }; }

const settings = {
  workStart: 600, workEnd: 1140, lunchStart: 780, lunchEnd: 840,
  lunchExcluded: true, defaultDailyMin: 480, honorific: '선생님'
};
const holidays = { '2026-08-17': '대체공휴일(광복절)', '2026-09-25': '추석' };

const records = []; // 가상의 휴가기록 시트
let nextRow = 2;
let me = members[0];

function ctx() {
  return {
    member: me, members, types, settings, schedule, holidays,
    records, today: DateUtil.dayStart(new Date())
  };
}

const COMMANDS = {
  '휴가사용': 'use', '휴가등록': 'use', '휴가신청': 'use',
  '휴가취소': 'cancel', '휴가조회': 'query', '휴가현황': 'status',
  '근무현황': 'work', '근무표': 'work', '휴가도움말': 'help', '도움말': 'help'
};

function handle(input) {
  const m = input.trim().match(/^\/?(\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  const word = m[1], args = m[2].trim();

  if (word === '종료') process.exit(0);
  if (word === '사용자') {
    const found = members.find(x => x.name === args);
    if (!found) return { text: '⚠️ 명단에 없는 이름입니다: ' + members.map(x => x.name).join(', ') };
    me = found;
    return { text: '이제 ' + me.name + ' ' + settings.honorific + '으로 입력합니다.' };
  }
  if (word === '기록') {
    if (!records.length) return { text: '(휴가기록 시트가 비어 있습니다)' };
    return { text: records.map(r =>
      `${r.row}행 | ${r.name} | ${r.type} | ${r.ymd} ${TimeUtil.fmtHM(r.startMin)}-${TimeUtil.fmtHM(r.endMin)} | ${r.minutes}분 | ${r.status}`
    ).join('\n') };
  }

  const cmd = COMMANDS[word];
  if (!cmd) return { text: Messages.help() };
  const c = ctx();
  const opts = { today: c.today, typeNames: types.map(t => t.name) };

  switch (cmd) {
    case 'help': return { text: Messages.help(), priv: true };
    case 'use': {
      if (!args) return { text: '⚠️ 등록할 휴가를 입력해 주세요.\n' + Messages.usageShort(), priv: true };
      const r = VacationService.register(c, Parser.parse(args, opts));
      if (r.ok) {
        r.rows.forEach(row => records.push({
          row: nextRow++, name: row[0], email: row[1], type: row[2], ymd: row[3],
          startMin: TimeUtil.parseHM(row[4]), endMin: TimeUtil.parseHM(row[5]),
          minutes: row[6], status: row[7]
        }));
      }
      return { text: r.message, priv: !r.ok || r.isPrivate };
    }
    case 'cancel': {
      if (!args) return { text: '⚠️ 취소할 날짜를 입력해 주세요. 예) 휴가취소 7/28', priv: true };
      const r = VacationService.cancel(c, Parser.parse(args, opts));
      if (r.ok) records.forEach(rec => { if (r.rowIndexes.includes(rec.row)) rec.status = '취소'; });
      return { text: r.message, priv: !r.ok || r.isPrivate };
    }
    case 'query': return { text: VacationService.query(c).message, priv: true };
    case 'status': {
      let date = c.today;
      if (args) {
        const p = Parser.parse(args, opts);
        if (p.error) return { text: '⚠️ ' + p.error, priv: true };
        date = p.startDate;
      }
      return { text: VacationService.status(c, date).message };
    }
    case 'work': {
      if (/이번\s*주|주간/.test(args)) return { text: VacationService.workChartWeek(c, c.today).message };
      let date = c.today;
      if (args) {
        const p = Parser.parse(args, opts);
        if (p.error) return { text: '⚠️ ' + p.error, priv: true };
        date = p.startDate;
      }
      return { text: VacationService.workChartDay(c, date).message };
    }
  }
}

console.log('🌴 휴가봇 시뮬레이터 (가상 명단: 윤지훈·김민수·이서연 / 종료하려면 "종료")');
console.log('예) 휴가사용 다음주 화 10:30-15:30 / 휴가조회 / 근무현황 / 근무현황 이번주\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function prompt() {
  rl.question(me.name + ' > ', line => {
    if (line.trim()) {
      const res = handle(line);
      if (res) {
        const tag = res.priv ? ' 🔒(본인에게만 보임)' : ' (톡방 전체 공개)';
        console.log('\n휴가봇' + tag + '\n' + res.text + '\n');
      }
    }
    prompt();
  });
}
prompt();
