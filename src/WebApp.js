/**
 * 실제 시트에 연결된 관리자 웹페이지 (Apps Script 웹앱, GAS 전용).
 *
 * 배포: Apps Script 편집기 → 배포 → 새 배포 → 유형 "웹 앱"
 *   - 실행 계정: "웹 앱에 액세스하는 사용자"
 *   - 액세스 권한: "조직 내 사용자" (도메인 계정이어야 방문자 이메일 확인 가능)
 * 설정 시트의 '관리자'에 등록된 이메일만 사용할 수 있다.
 */

function doGet() {
  return HtmlService.createTemplateFromFile('AdminPage').evaluate()
    .setTitle('휴가봇 관리자')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function requireAdmin_() {
  var email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var settings = SheetRepo.getSettings();
  if (!email) {
    throw new Error('방문자 이메일을 확인할 수 없습니다. 웹앱을 "조직 내 사용자" 액세스로 배포했는지 확인해 주세요.');
  }
  if (settings.adminEmails.indexOf(email) === -1) {
    throw new Error('관리자 권한이 없습니다 (' + email + '). 설정 시트의 \'관리자\'에 이메일을 추가해 주세요.');
  }
  return email;
}

/** 페이지에 필요한 모든 데이터를 한 번에 반환 */
function api_view(weekYmd, gridYmd) {
  requireAdmin_();
  var ctx = SheetRepo.buildCtx(null, null);
  var nextEff = firstMondayOfNextMonth_(ctx.today);
  return {
    week: buildWeek_(ctx, weekYmd),
    grid: buildGrid_(ctx, gridYmd),
    summary: buildSummary_(ctx),
    editor: {
      cur: buildEditor_(ctx, ctx.today),
      next: buildEditor_(ctx, nextEff),
      nextEff: DateUtil.ymd(nextEff),
      nextEffLabel: DateUtil.kdate(nextEff),
      curMonth: ctx.today.getMonth() + 1,
      nextMonth: nextEff.getMonth() + 1
    },
    members: ctx.members.map(function (m) {
      return { name: m.name, email: m.email, birthMonth: m.birthMonth,
               allocH: mapHours_(m.alloc), hasTimetable: !!ctx.schedule[m.name] };
    }),
    types: ctx.types.map(function (t) {
      return { name: t.name, allocH: t.allocMin / 60, cycle: t.cycle || 'year',
               carryover: !!t.carryover };
    }),
    lunchText: TimeUtil.fmtHM(ctx.settings.lunchStart) + '-' + TimeUtil.fmtHM(ctx.settings.lunchEnd)
  };
}

function mapHours_(alloc) {
  var o = {};
  Object.keys(alloc || {}).forEach(function (k) { o[k] = alloc[k] / 60; });
  return o;
}

function firstMondayOfNextMonth_(today) {
  var d = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  while (d.getDay() !== 1) d = DateUtil.addDays(d, 1);
  return d;
}

function buildWeek_(ctx, weekYmd) {
  var mon = DateUtil.monday(weekYmd ? DateUtil.fromYmd(weekYmd) : ctx.today);
  var hasSat = ctx.members.some(function (m) { return !!VacationService.scheduleFor(ctx, m.name, DateUtil.addDays(mon, 5)); });
  var hasSun = ctx.members.some(function (m) { return !!VacationService.scheduleFor(ctx, m.name, DateUtil.addDays(mon, 6)); });
  var count = 5 + (hasSat ? 1 : 0) + (hasSun ? 1 : 0);

  var dates = [], headers = ['이름'];
  for (var i = 0; i < count; i++) {
    var d = DateUtil.addDays(mon, i);
    dates.push(d);
    headers.push(DateUtil.WEEKDAYS[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate());
  }
  var rows = ctx.members.map(function (m) {
    return { name: m.name, cells: dates.map(function (d) {
      if (ctx.holidays[DateUtil.ymd(d)]) return { t: '공휴일', cls: 'hol' };
      var sched = VacationService.scheduleFor(ctx, m.name, d);
      if (!sched) return { t: '휴무', cls: 'off' };
      return {
        t: TimeUtil.fmtShortHM(sched.start) + '-' + TimeUtil.fmtShortHM(sched.end) + (sched.lunchWork ? '*' : ''),
        cls: 'work'
      };
    }) };
  });
  var last = dates[dates.length - 1];
  return {
    mondayYmd: DateUtil.ymd(mon),
    label: (mon.getMonth() + 1) + '/' + mon.getDate() + ' ~ ' + (last.getMonth() + 1) + '/' + last.getDate(),
    headers: headers, rows: rows
  };
}

function buildGrid_(ctx, gridYmd) {
  var date = gridYmd ? DateUtil.fromYmd(gridYmd) : ctx.today;
  var ymd = DateUtil.ymd(date), kd = DateUtil.kdate(date);
  var base = { ymd: ymd, kdate: kd, names: ctx.members.map(function (m) { return m.name; }) };
  var hol = ctx.holidays[ymd];
  if (hol) return Object.assign(base, { note: kd + '은(는) ' + hol + '입니다', rows: [] });

  var lunch = { start: ctx.settings.lunchStart, end: ctx.settings.lunchEnd };
  var cols = ctx.members.map(function (m) {
    return { m: m, sched: VacationService.scheduleFor(ctx, m.name, date) };
  });
  var working = cols.filter(function (c) { return c.sched; });
  if (!working.length) return Object.assign(base, { note: kd + ' 근무자가 없습니다', rows: [] });

  var minS = Math.min.apply(null, working.map(function (c) { return c.sched.start; }));
  var maxE = Math.max.apply(null, working.map(function (c) { return c.sched.end; }));
  var recs = ctx.records.filter(function (r) { return r.status === '등록' && r.ymd === ymd; });
  var slot = ctx.settings.gridSlotMin || 30;

  var rows = [];
  for (var t = Math.floor(minS / slot) * slot; t < maxE; t += slot) {
    var slotS = t, slotE = t + slot;
    rows.push({
      time: TimeUtil.fmtHM(slotS),
      cells: cols.map(function (c) {
        if (!c.sched) return 'off';
        var work = TimeUtil.overlapMin(c.sched.start, c.sched.end, slotS, slotE);
        if (work <= 0) return 'off';
        if (ctx.settings.lunchExcluded && !c.sched.lunchWork &&
            TimeUtil.overlapMin(lunch.start, lunch.end, slotS, slotE) >= work) return 'lunch';
        var vac = 0;
        recs.forEach(function (r) {
          if (r.email === c.m.email) {
            vac += TimeUtil.overlapMin(Math.max(r.startMin, c.sched.start),
                                       Math.min(r.endMin, c.sched.end), slotS, slotE);
          }
        });
        return vac > 0 ? 'vac' : 'work';
      })
    });
  }
  return Object.assign(base, { note: null, rows: rows });
}

function buildSummary_(ctx) {
  var s = VacationService.adminSummary(ctx);
  return {
    typeNames: s.typeNames,
    rows: s.table.map(function (r) {
      return { name: r.name, cells: r.cells.map(function (c) {
        if (!c) return null;
        return {
          remainH: Math.round((c.remain / 60) * 10) / 10,
          allocH: Math.round((c.alloc / 60) * 10) / 10,
          pct: c.alloc > 0 ? Math.max(0, Math.min(100, (c.remain / c.alloc) * 100)) : 0,
          label: c.label
        };
      }) };
    })
  };
}

/** 시간표 편집용: refDate 시점에 적용되는 버전의 원본 값 */
function buildEditor_(ctx, refDate) {
  var ymd = DateUtil.ymd(refDate);
  return ctx.members.map(function (m) {
    var list = ctx.schedule[m.name], version = null;
    if (list) {
      list.forEach(function (v) { if (!v.effective || v.effective <= ymd) version = v; });
    }
    var days = {};
    for (var d = 0; d < 7; d++) {
      if (version && version.days[d]) {
        days[d] = TimeUtil.fmtHM(version.days[d].start) + '-' + TimeUtil.fmtHM(version.days[d].end);
      } else if (!list && d >= 1 && d <= 5) {
        days[d] = TimeUtil.fmtHM(ctx.settings.workStart) + '-' + TimeUtil.fmtHM(ctx.settings.workEnd);
      } else {
        days[d] = '';
      }
    }
    return { name: m.name, days: days, lunchWork: !!(version && version.lunchWork) };
  });
}

/* ── 쓰기 API ── */

function api_addMember(name, email, birthMonth) {
  requireAdmin_();
  name = String(name || '').trim();
  email = String(email || '').trim().toLowerCase();
  if (!name || !email) throw new Error('이름과 이메일을 모두 입력해 주세요.');
  return withLock_(function () {
    var sh = SheetRepo.sheet(SheetRepo.SHEET.members);
    var headers = headerMap_(sh);
    var existing = SheetRepo.buildCtx(null, null).members;
    if (existing.some(function (m) { return m.email === email; })) {
      throw new Error('이미 등록된 이메일입니다: ' + email);
    }
    var row = new Array(sh.getLastColumn()).fill('');
    setByHeader_(row, headers, '이름', name);
    setByHeader_(row, headers, '이메일', email);
    if (birthMonth) setByHeader_(row, headers, '생일', String(birthMonth) + '월');
    sh.appendRow(row);
    return { ok: true };
  });
}

function api_removeMember(email) {
  requireAdmin_();
  email = String(email || '').trim().toLowerCase();
  return withLock_(function () {
    var sh = SheetRepo.sheet(SheetRepo.SHEET.members);
    var headers = headerMap_(sh);
    var col = headers['이메일'];
    if (!col) throw new Error("명단 시트에 '이메일' 열이 없습니다.");
    var values = sh.getRange(2, col, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim().toLowerCase() === email) {
        sh.deleteRow(i + 2);
        return { ok: true };
      }
    }
    throw new Error('명단에서 찾을 수 없습니다: ' + email);
  });
}

/** 사람별 부여 시간 조정: overrides = { 종류명: 시간 숫자 | '' } ('' = 기본값으로) */
function api_setAlloc(email, overrides) {
  requireAdmin_();
  email = String(email || '').trim().toLowerCase();
  return withLock_(function () {
    var sh = SheetRepo.sheet(SheetRepo.SHEET.members);
    var headers = headerMap_(sh);
    var emailCol = headers['이메일'];
    if (!emailCol) throw new Error("명단 시트에 '이메일' 열이 없습니다.");
    var rowIdx = -1;
    var values = sh.getRange(2, emailCol, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim().toLowerCase() === email) { rowIdx = i + 2; break; }
    }
    if (rowIdx === -1) throw new Error('명단에서 찾을 수 없습니다: ' + email);

    Object.keys(overrides || {}).forEach(function (typeName) {
      var col = headers[typeName];
      var v = overrides[typeName];
      if (!col) {
        if (v === '' || v == null) return; // 열도 없고 값도 없으면 무시
        col = sh.getLastColumn() + 1;
        sh.getRange(1, col).setValue(typeName + '(시간)').setFontWeight('bold');
        headers[typeName] = col;
      }
      sh.getRange(rowIdx, col).setValue(v === '' || v == null ? '' : Number(v));
    });
    return { ok: true };
  });
}

/**
 * 시간표 저장.
 * payload = { scope: 'cur'|'next', nextEff: 'yyyy-MM-dd',
 *             rows: [{ name, days: {0..6: '10:00-19:00'|''}, lunchWork }] }
 *  - cur: 현재 적용 중인 행을 그대로 수정 (없으면 적용일 없는 행 추가)
 *  - next: 적용일 = nextEff 행을 수정 또는 추가
 */
function api_saveTimetable(payload) {
  requireAdmin_();
  var scope = payload.scope === 'next' ? 'next' : 'cur';
  return withLock_(function () {
    var sh = SheetRepo.sheet(SheetRepo.SHEET.timetable);
    var headers = headerMap_(sh);
    ['이름', '적용일', '점심'].concat(DateUtil.WEEKDAYS.slice(1)).concat(['일']).forEach(function (h) {
      // 필요한 열이 없으면 만든다 (토·일 포함 — 값이 없으면 비워둘 뿐)
      if (!headers[h]) {
        var col = sh.getLastColumn() + 1;
        sh.getRange(1, col).setValue(h).setFontWeight('bold');
        headers[h] = col;
      }
    });

    var today = DateUtil.dayStart(new Date());
    var todayYmd = DateUtil.ymd(today);
    var nRows = Math.max(sh.getLastRow() - 1, 0);
    var data = nRows ? sh.getRange(2, 1, nRows, sh.getLastColumn()).getValues() : [];

    (payload.rows || []).forEach(function (r) {
      var name = String(r.name || '').trim();
      if (!name) return;
      // 이 사람의 행들 중 대상 행 찾기
      var targetIdx = -1, bestEff = null;
      for (var i = 0; i < data.length; i++) {
        if (String(data[i][headers['이름'] - 1]).trim() !== name) continue;
        var effCell = data[i][headers['적용일'] - 1];
        var eff = effCell instanceof Date ? DateUtil.ymd(effCell) : String(effCell || '').trim().slice(0, 10);
        if (scope === 'next') {
          if (eff === payload.nextEff) { targetIdx = i; break; }
        } else {
          if (!eff || eff <= todayYmd) {
            if (bestEff === null || eff >= bestEff) { bestEff = eff; targetIdx = i; }
          }
        }
      }

      var rowNum;
      if (targetIdx === -1) {
        rowNum = sh.getLastRow() + 1;
        sh.getRange(rowNum, headers['이름']).setValue(name);
        sh.getRange(rowNum, headers['적용일']).setValue(scope === 'next' ? payload.nextEff : '');
      } else {
        rowNum = targetIdx + 2;
      }

      for (var d = 0; d < 7; d++) {
        var h = DateUtil.WEEKDAYS[d];
        var val = String((r.days && r.days[d]) || '').trim();
        if (val && val !== '휴무') {
          var parts = val.replace(/\s/g, '').split(/[-~]/);
          var s = TimeUtil.parseHM(parts[0]), e = TimeUtil.parseHM(parts[1]);
          if (s == null || e == null || e <= s) {
            throw new Error(name + ' ' + h + "요일 시간이 잘못되었습니다: '" + val + "' (예: 10:00-19:00)");
          }
          sh.getRange(rowNum, headers[h]).setValue(TimeUtil.fmtHM(s) + '-' + TimeUtil.fmtHM(e));
        } else {
          sh.getRange(rowNum, headers[h]).setValue('');
        }
      }
      sh.getRange(rowNum, headers['점심']).setValue(r.lunchWork ? '근무' : '');
    });
    return { ok: true };
  });
}

/* ── 내부 유틸 ── */

function headerMap_(sh) {
  var map = {};
  sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].forEach(function (h, i) {
    var name = String(h).replace(/\(.*\)$/, '').trim();
    if (name && !map[name]) map[name] = i + 1;
  });
  return map;
}

function setByHeader_(rowArr, headers, name, value) {
  if (headers[name]) rowArr[headers[name] - 1] = value;
}
