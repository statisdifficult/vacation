/**
 * 휴가 등록·취소·조회·현황 핵심 로직.
 * 모든 함수는 순수 함수로, ctx(시트에서 읽은 데이터)만 입력받아 결과를 반환한다.
 * GAS 서비스 의존성이 없어 Node.js에서도 테스트할 수 있다. (test/run.js)
 *
 * ctx = {
 *   member:  { name, email, birthMonth, alloc: {휴가종류: 분} } | null — 명령을 보낸 사람
 *   members: [{ name, email, birthMonth, alloc }]                     — 전체 명단(명단 시트 순서)
 *   types:   [{ name, allocMin, isPublic, cycle, carryover }]         — 휴가종류 시트
 *            cycle: 'year' | 'half' | 'month' | 'birthmonth' (지급주기)
 *            carryover: true면 남은 시간이 다음 해로 이월 (cycle 'year'만 해당)
 *   settings:{ workStart, workEnd, lunchStart, lunchEnd, lunchExcluded,
 *              defaultDailyMin, honorific, baseYear }
 *   schedule:{ 이름: { 요일번호(0~6): {start, end} } }                 — 시간표 시트
 *   holidays:{ 'yyyy-MM-dd': '명칭' }                                 — 공휴일 시트
 *   records: [{ row, name, email, type, ymd, startMin, endMin, minutes, status }]
 *   today:   Date
 * }
 */
var VacationService = (function () {

  function lunchOf(settings) {
    return { start: settings.lunchStart, end: settings.lunchEnd, excluded: settings.lunchExcluded };
  }

  function typeOf(ctx, name) {
    for (var i = 0; i < ctx.types.length; i++) {
      if (ctx.types[i].name === name) return ctx.types[i];
    }
    return null;
  }

  /**
   * 이름 기준 그날의 근무시간표. 근무일이 아니면 null.
   * ctx.schedule[name]은 두 형태를 지원한다:
   *  - { 요일번호: {start,end} }                      — 단일 시간표
   *  - [{ effective, days, lunchWork }, ...]          — 적용일별 버전 (적용일 오름차순)
   *    effective: 'yyyy-MM-dd' 부터 적용 (null이면 처음부터),
   *    lunchWork: true면 점심시간에도 근무(점심 차감 없음)
   */
  function scheduleFor(ctx, name, date) {
    var lunch = lunchOf(ctx.settings);
    var entry = ctx.schedule[name];
    if (entry) {
      var days = entry, lunchWork = false;
      if (Array.isArray(entry)) {
        var ymd = DateUtil.ymd(date), version = null;
        for (var i = 0; i < entry.length; i++) {
          if (!entry[i].effective || entry[i].effective <= ymd) version = entry[i];
        }
        if (!version) return null;
        days = version.days;
        lunchWork = !!version.lunchWork;
      }
      var cell = days[date.getDay()];
      if (!cell) return null;
      var l = lunchWork ? { excluded: false } : lunch;
      return { start: cell.start, end: cell.end, net: TimeUtil.netMinutes(cell.start, cell.end, l),
               lunchWork: lunchWork };
    }
    // 시간표에 없는 사람은 월~금 기본 근무시간 적용
    if (DateUtil.isWeekend(date)) return null;
    return {
      start: ctx.settings.workStart,
      end: ctx.settings.workEnd,
      net: TimeUtil.netMinutes(ctx.settings.workStart, ctx.settings.workEnd, lunch),
      lunchWork: false
    };
  }

  function unitAllocOf(member, typeInfo) {
    return (member.alloc && member.alloc[typeInfo.name] != null)
      ? member.alloc[typeInfo.name] : typeInfo.allocMin;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * 휴가일(date)이 속한 예산 구간(지급주기 단위).
   *  - 잔여 관리를 안 하는 종류(부여 0)는 null
   *  - 사용할 수 없는 날짜(예: 생일 아닌 달의 생일휴가)는 { invalid: '사유' }
   *  - 그 외 { key, label, allocMin, from, to }
   */
  function budgetFor(ctx, member, typeInfo, date) {
    var unit = unitAllocOf(member, typeInfo);
    if (unit <= 0) return null;
    var y = date.getFullYear(), m = date.getMonth();
    var cycle = typeInfo.cycle || 'year';

    if (cycle === 'half') {
      var firstHalf = m < 6;
      return {
        key: y + (firstHalf ? '-H1' : '-H2'),
        label: typeInfo.name + '(' + (firstHalf ? '상반기' : '하반기') + ')',
        allocMin: unit,
        from: y + (firstHalf ? '-01-01' : '-07-01'),
        to: y + (firstHalf ? '-06-30' : '-12-31')
      };
    }
    if (cycle === 'month') {
      var last = new Date(y, m + 1, 0).getDate();
      return {
        key: y + '-' + pad2(m + 1),
        label: typeInfo.name + '(' + (m + 1) + '월)',
        allocMin: unit,
        from: y + '-' + pad2(m + 1) + '-01',
        to: y + '-' + pad2(m + 1) + '-' + pad2(last)
      };
    }
    if (cycle === 'birthmonth') {
      if (!member.birthMonth) {
        return { invalid: typeInfo.name + '를 쓰려면 명단 시트에 생일을 등록해야 합니다.' };
      }
      if (m + 1 !== member.birthMonth) {
        return { invalid: typeInfo.name + '는 생일이 있는 ' + member.birthMonth + '월에만 사용할 수 있습니다.' };
      }
      var bl = new Date(y, member.birthMonth, 0).getDate();
      return {
        key: y + '-생일',
        label: typeInfo.name + '(' + member.birthMonth + '월)',
        allocMin: unit,
        from: y + '-' + pad2(member.birthMonth) + '-01',
        to: y + '-' + pad2(member.birthMonth) + '-' + pad2(bl)
      };
    }
    if (typeInfo.carryover) {
      var base = ctx.settings.baseYear || y;
      if (base > y) base = y;
      return {
        key: '이월',
        label: typeInfo.name + (base < y ? '(이월 포함)' : ''),
        allocMin: unit * (y - base + 1),
        from: base + '-01-01',
        to: '9999-12-31'
      };
    }
    return { key: String(y), label: typeInfo.name, allocMin: unit, from: y + '-01-01', to: y + '-12-31' };
  }

  /** 구간 내 사용 분(상태=등록) */
  function usedBetween(ctx, email, typeName, fromYmd, toYmd) {
    var sum = 0;
    ctx.records.forEach(function (r) {
      if (r.status === '등록' && r.email === email && r.type === typeName &&
          r.ymd >= fromYmd && r.ymd <= toYmd) {
        sum += r.minutes;
      }
    });
    return sum;
  }

  /** 잔여 조회용 기준 날짜: 생일월 종류는 올해 생일 달, 그 외에는 오늘 */
  function refDateOf(ctx, member, typeInfo) {
    if ((typeInfo.cycle || 'year') === 'birthmonth') {
      if (!member.birthMonth) return null;
      return new Date(ctx.today.getFullYear(), member.birthMonth - 1, 1);
    }
    return ctx.today;
  }

  function activeRecordsOn(ctx, ymd) {
    return ctx.records.filter(function (r) { return r.status === '등록' && r.ymd === ymd; });
  }

  function timeText(r) {
    return TimeUtil.fmtHM(r.startMin) + '-' + TimeUtil.fmtHM(r.endMin);
  }

  return {
    scheduleFor: scheduleFor,
    budgetFor: budgetFor,
    usedBetween: usedBetween,

    /** 휴가 등록. { ok, rows, message, isPrivate } | { ok:false, message } */
    register: function (ctx, parsed) {
      if (parsed.error) return { ok: false, message: '⚠️ ' + parsed.error + '\n' + Messages.usageShort() };
      if (!ctx.member) return { ok: false, message: Messages.noMember(null) };

      var typeName = parsed.type || (ctx.types[0] && ctx.types[0].name) || '일반휴가';
      var typeInfo = typeOf(ctx, typeName) || { name: typeName, allocMin: 0, isPublic: true };
      var lunch = lunchOf(ctx.settings);
      var member = ctx.member;

      var items = [], skipped = [], conflicts = [], invalidReasons = [];
      for (var d = parsed.startDate; d <= parsed.endDate; d = DateUtil.addDays(d, 1)) {
        var ymd = DateUtil.ymd(d), kd = DateUtil.kdate(d);
        var hol = ctx.holidays[ymd];
        if (hol) { skipped.push(kd + ' ' + (typeof hol === 'string' ? hol : '공휴일')); continue; }

        var sched = scheduleFor(ctx, member.name, d);
        if (!sched) { skipped.push(kd + ' 휴무일'); continue; }

        var budget = budgetFor(ctx, member, typeInfo, d);
        if (budget && budget.invalid) {
          if (invalidReasons.indexOf(budget.invalid) === -1) invalidReasons.push(budget.invalid);
          skipped.push(kd + ' 사용 불가');
          continue;
        }

        // 점심에도 근무하는 사람은 점심시간을 차감하지 않는다
        var effLunch = sched.lunchWork ? { excluded: false } : lunch;
        var s, e, min;
        if (parsed.startMin != null) {
          s = parsed.startMin; e = parsed.endMin;
          min = TimeUtil.netMinutes(s, e, effLunch);
        } else if (parsed.halfDay) {
          var mid = sched.start + Math.round((sched.end - sched.start) / 2);
          if (parsed.halfDay === 'AM') { s = sched.start; e = mid; }
          else { s = mid; e = sched.end; }
          min = TimeUtil.netMinutes(s, e, effLunch);
        } else {
          s = sched.start; e = sched.end; min = sched.net;
        }
        if (min <= 0) { skipped.push(kd + ' 사용 시간 0'); continue; }

        var overlapped = activeRecordsOn(ctx, ymd).filter(function (r) {
          return r.email === member.email && TimeUtil.overlapMin(r.startMin, r.endMin, s, e) > 0;
        });
        if (overlapped.length) {
          conflicts.push(kd + ' ' + timeText(overlapped[0]) + ' ' + overlapped[0].type);
          continue;
        }
        items.push({ ymd: ymd, kdate: kd, s: s, e: e, min: min, budget: budget,
                     timeText: TimeUtil.fmtHM(s) + '-' + TimeUtil.fmtHM(e) });
      }

      if (conflicts.length) {
        return { ok: false, message: '⚠️ 이미 등록된 휴가와 겹칩니다: ' + conflicts.join(', ') +
                 '\n먼저 /휴가취소 후 다시 등록해 주세요.' };
      }
      if (!items.length) {
        if (invalidReasons.length) return { ok: false, message: '⚠️ ' + invalidReasons.join(' ') };
        var why = skipped.length ? ' (' + skipped.join(', ') + ')' : '';
        return { ok: false, message: '⚠️ 등록할 수 있는 날이 없습니다.' + why };
      }

      var totalMin = items.reduce(function (a, it) { return a + it.min; }, 0);

      // 지급주기(연/반기/월/생일월) 구간별로 예산 확인
      var groups = {};
      items.forEach(function (it) {
        if (!it.budget) return;
        var g = groups[it.budget.key] || (groups[it.budget.key] = { b: it.budget, sum: 0 });
        if (it.budget.allocMin > g.b.allocMin) g.b = it.budget;
        g.sum += it.min;
      });
      var remains = [], overBudget = false;
      Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        var used = usedBetween(ctx, member.email, typeName, g.b.from, g.b.to);
        var remain = g.b.allocMin - used - g.sum;
        if (remain < 0) overBudget = true;
        remains.push({ label: g.b.label, remainMin: remain });
      });

      var rows = items.map(function (it) {
        return [member.name, member.email, typeName, it.ymd,
                TimeUtil.fmtHM(it.s), TimeUtil.fmtHM(it.e), it.min, '등록', parsed.memo || ''];
      });

      var message = Messages.registered({
        name: member.name, honorific: ctx.settings.honorific, typeName: typeName,
        items: items, totalMin: totalMin, remains: remains,
        dailyMin: ctx.settings.defaultDailyMin, skipped: skipped,
        overBudget: overBudget, memo: parsed.memo
      });
      return { ok: true, rows: rows, message: message, isPrivate: !typeInfo.isPublic };
    },

    /** 휴가 취소. { ok, rowIndexes, message, isPrivate } | { ok:false, message } */
    cancel: function (ctx, parsed) {
      if (parsed.error) {
        return { ok: false, message: '⚠️ ' + parsed.error + '\n예) /휴가취소 7/28' };
      }
      if (!ctx.member) return { ok: false, message: Messages.noMember(null) };
      var member = ctx.member;

      var targets = [];
      for (var d = parsed.startDate; d <= parsed.endDate; d = DateUtil.addDays(d, 1)) {
        var ymd = DateUtil.ymd(d);
        activeRecordsOn(ctx, ymd).forEach(function (r) {
          if (r.email !== member.email) return;
          if (parsed.startMin != null &&
              TimeUtil.overlapMin(r.startMin, r.endMin, parsed.startMin, parsed.endMin) <= 0) return;
          targets.push(r);
        });
      }
      if (!targets.length) {
        return { ok: false, message: Messages.nothingToCancel(DateUtil.kdate(parsed.startDate)) };
      }

      // 종류별 취소 후 잔여 계산 (취소분을 되돌려서 표시)
      var byType = {}, isPrivate = false;
      targets.forEach(function (r) {
        (byType[r.type] = byType[r.type] || []).push(r);
        var ti = typeOf(ctx, r.type);
        if (ti && !ti.isPublic) isPrivate = true;
      });
      var remains = [];
      Object.keys(byType).forEach(function (t) {
        var ti = typeOf(ctx, t);
        if (!ti) return;
        var first = byType[t][0];
        var b = budgetFor(ctx, member, ti, DateUtil.fromYmd(first.ymd));
        if (!b || b.invalid) return;
        var used = usedBetween(ctx, member.email, t, b.from, b.to);
        var canceledIn = byType[t].filter(function (r) {
          return r.ymd >= b.from && r.ymd <= b.to;
        }).reduce(function (a, r) { return a + r.minutes; }, 0);
        remains.push({ label: b.label, remainMin: b.allocMin - used + canceledIn });
      });

      var message = Messages.canceled({
        name: member.name, honorific: ctx.settings.honorific,
        items: targets.map(function (r) {
          var dt = DateUtil.fromYmd(r.ymd);
          return { kdate: DateUtil.kdate(dt), timeText: timeText(r), typeName: r.type, min: r.minutes };
        }),
        remains: remains, dailyMin: ctx.settings.defaultDailyMin
      });
      return { ok: true, rowIndexes: targets.map(function (r) { return r.row; }),
               message: message, isPrivate: isPrivate };
    },

    /** 내 잔여·예정 휴가 (항상 본인에게만) */
    query: function (ctx) {
      if (!ctx.member) return { message: Messages.noMember(null), isPrivate: true };
      var member = ctx.member;
      var lines = ['📋 *' + member.name + ' ' + ctx.settings.honorific + ' 휴가 현황*', '', '*잔여 휴가*'];

      ctx.types.forEach(function (t) {
        if (unitAllocOf(member, t) <= 0) return;
        if ((t.cycle || 'year') === 'birthmonth' && !member.birthMonth) {
          lines.push('• ' + t.name + ': 명단에 생일이 등록되어 있지 않습니다');
          return;
        }
        var b = budgetFor(ctx, member, t, refDateOf(ctx, member, t));
        if (!b || b.invalid) return;
        var remain = b.allocMin - usedBetween(ctx, member.email, t.name, b.from, b.to);
        lines.push('• ' + b.label + ': ' + Messages.remainText(remain, ctx.settings.defaultDailyMin));
      });

      var todayYmd = DateUtil.ymd(ctx.today);
      var upcoming = ctx.records.filter(function (r) {
        return r.status === '등록' && r.email === member.email && r.ymd >= todayYmd;
      }).sort(function (a, b) { return a.ymd < b.ymd ? -1 : 1; });

      if (upcoming.length) {
        lines.push('', '*예정된 휴가*');
        upcoming.forEach(function (r) {
          lines.push('• ' + DateUtil.kdate(DateUtil.fromYmd(r.ymd)) + ' ' + timeText(r) + ' ' + r.type);
        });
      }
      return { message: lines.join('\n'), isPrivate: true };
    },

    /**
     * 전체 구성원의 잔여 휴가 요약 (관리자용, 항상 비공개 응답).
     * 지급주기가 있는 종류는 현재 구간(이번 달·이번 반기·올해 생일 달) 기준.
     * 반환: { message, isPrivate, typeNames, table: [{name, cells:[{alloc,used,remain,label}|null]}] }
     */
    adminSummary: function (ctx) {
      var typeNames = [];
      ctx.types.forEach(function (t) {
        var tracked = t.allocMin > 0 || ctx.members.some(function (m) {
          return m.alloc && m.alloc[t.name] > 0;
        });
        if (tracked) typeNames.push(t.name);
      });

      var table = ctx.members.map(function (m) {
        return {
          name: m.name,
          cells: typeNames.map(function (tn) {
            var t = typeOf(ctx, tn);
            if (!t || unitAllocOf(m, t) <= 0) return null;
            var ref = refDateOf(ctx, m, t);
            if (!ref) return null; // 생일 미등록
            var b = budgetFor(ctx, m, t, ref);
            if (!b || b.invalid) return null;
            var used = usedBetween(ctx, m.email, tn, b.from, b.to);
            return { alloc: b.allocMin, used: used, remain: b.allocMin - used, label: b.label };
          })
        };
      });

      var rows = table.map(function (r) {
        return [r.name].concat(r.cells.map(function (c) {
          return c ? TimeUtil.toHoursStr(c.remain) + '/' + TimeUtil.toHoursStr(c.alloc) + 'h' : '-';
        }));
      });
      var message = '👥 *전체 잔여 휴가* (잔여/부여 시간, 현재 구간 기준)\n' +
        ChartText.buildTable(['이름'].concat(typeNames), rows);
      return { message: message, isPrivate: true, typeNames: typeNames, table: table };
    },

    /** 특정 날짜의 휴가자 목록 (비공개 종류는 '휴가'로 표시) */
    status: function (ctx, date) {
      var ymd = DateUtil.ymd(date), kd = DateUtil.kdate(date);
      var recs = activeRecordsOn(ctx, ymd).sort(function (a, b) { return a.startMin - b.startMin; });
      if (!recs.length) return { message: '🌴 ' + kd + ' 휴가자가 없습니다.', isPrivate: false };
      var lines = ['🌴 *' + kd + ' 휴가자*'];
      recs.forEach(function (r) {
        var ti = typeOf(ctx, r.type);
        var shown = (ti && !ti.isPublic) ? '휴가' : r.type;
        lines.push('• ' + r.name + ' ' + timeText(r) + ' ' + shown);
      });
      return { message: lines.join('\n'), isPrivate: false };
    },

    /** 하루 근무 현황 그래프 (개인별) */
    workChartDay: function (ctx, date) {
      var ymd = DateUtil.ymd(date), kd = DateUtil.kdate(date);
      var hol = ctx.holidays[ymd];
      if (hol) return { message: '📊 ' + kd + '은(는) ' + (typeof hol === 'string' ? hol : '공휴일') + '입니다.', isPrivate: false };

      var recs = activeRecordsOn(ctx, ymd);
      var rows = ctx.members.map(function (m) {
        var sched = scheduleFor(ctx, m.name, date);
        if (!sched) return { name: m.name, workMin: 0, schedText: null };
        var vacMin = 0;
        recs.forEach(function (r) {
          if (r.email === m.email) {
            vacMin += TimeUtil.overlapMin(r.startMin, r.endMin, sched.start, sched.end);
          }
        });
        vacMin = Math.min(vacMin, sched.net);
        var workMin = sched.net - vacMin;
        var note = '';
        if (vacMin > 0 && workMin > 0) note = '🌴휴가 ' + TimeUtil.fmtDuration(vacMin);
        return {
          name: m.name, workMin: workMin,
          schedText: TimeUtil.fmtHM(sched.start) + '-' + TimeUtil.fmtHM(sched.end),
          note: note
        };
      });
      return { message: ChartText.buildDayChart('📊 *' + kd + ' 근무 현황*', rows), isPrivate: false };
    },

    /**
     * 시간대×사람 근무표 (열=이름, 행=1시간 단위).
     * ● 근무 / 휴 휴가 / ─ 점심 / · 근무시간 아님
     */
    workGridDay: function (ctx, date) {
      var ymd = DateUtil.ymd(date), kd = DateUtil.kdate(date);
      var hol = ctx.holidays[ymd];
      if (hol) return { message: '🗓 ' + kd + '은(는) ' + (typeof hol === 'string' ? hol : '공휴일') + '입니다.', isPrivate: false };

      var lunch = lunchOf(ctx.settings);
      var cols = ctx.members.map(function (m) {
        return { m: m, sched: scheduleFor(ctx, m.name, date) };
      });
      var working = cols.filter(function (c) { return c.sched; });
      if (!working.length) return { message: '🗓 ' + kd + ' 근무자가 없습니다.', isPrivate: false };

      var minS = Math.min.apply(null, working.map(function (c) { return c.sched.start; }));
      var maxE = Math.max.apply(null, working.map(function (c) { return c.sched.end; }));
      var recs = activeRecordsOn(ctx, ymd);

      var slot = ctx.settings.gridSlotMin || 30;
      var rows = [];
      for (var t = Math.floor(minS / slot) * slot; t < maxE; t += slot) {
        var slotS = t, slotE = t + slot;
        var cells = cols.map(function (c) {
          if (!c.sched) return '·';
          var work = TimeUtil.overlapMin(c.sched.start, c.sched.end, slotS, slotE);
          if (work <= 0) return '·';
          if (lunch.excluded && !c.sched.lunchWork &&
              TimeUtil.overlapMin(lunch.start, lunch.end, slotS, slotE) >= work) return '─';
          var vac = 0;
          recs.forEach(function (r) {
            if (r.email === c.m.email) {
              vac += TimeUtil.overlapMin(Math.max(r.startMin, c.sched.start), Math.min(r.endMin, c.sched.end), slotS, slotE);
            }
          });
          return vac > 0 ? '휴' : '●';
        });
        rows.push([TimeUtil.fmtHM(slotS)].concat(cells));
      }

      var names = ctx.members.map(function (m) { return m.name; });
      var message = '🗓 *' + kd + ' 근무표*\n' +
        ChartText.buildTable(['시간'].concat(names), rows) +
        '\n● 근무 · 휴 휴가 · ─ 점심 · · 휴무/근무 외';
      return { message: message, isPrivate: false };
    },

    /**
     * 주간 시간표 (행=사람, 열=요일) — 시간표 시트를 엑셀처럼 한눈에.
     * 적용일 버전을 반영하므로 다음 주 날짜를 주면 바뀐 시간표가 보인다.
     */
    timetableWeek: function (ctx, anyDate) {
      var mon = DateUtil.monday(anyDate);
      var hasSat = ctx.members.some(function (m) { return !!scheduleFor(ctx, m.name, DateUtil.addDays(mon, 5)); });
      var hasSun = ctx.members.some(function (m) { return !!scheduleFor(ctx, m.name, DateUtil.addDays(mon, 6)); });
      var count = 5 + (hasSat ? 1 : 0) + (hasSun ? 1 : 0);

      var headers = ['이름'], dates = [];
      for (var i = 0; i < count; i++) {
        var d = DateUtil.addDays(mon, i);
        dates.push(d);
        headers.push(DateUtil.WEEKDAYS[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate());
      }

      var hasLunchWork = false;
      var rows = ctx.members.map(function (m) {
        return [m.name].concat(dates.map(function (d) {
          if (ctx.holidays[DateUtil.ymd(d)]) return '공휴일';
          var sched = scheduleFor(ctx, m.name, d);
          if (!sched) return '휴무';
          var cell = TimeUtil.fmtShortHM(sched.start) + '-' + TimeUtil.fmtShortHM(sched.end);
          if (sched.lunchWork) { cell += '*'; hasLunchWork = true; }
          return cell;
        }));
      });

      var last = dates[dates.length - 1];
      var lines = ['📅 *주간 시간표* (' + (mon.getMonth() + 1) + '/' + mon.getDate() +
        '~' + (last.getMonth() + 1) + '/' + last.getDate() + ')',
        ChartText.buildTable(headers, rows)];
      if (hasLunchWork) {
        lines.push('* 점심시간(' + TimeUtil.fmtHM(ctx.settings.lunchStart) + '-' +
          TimeUtil.fmtHM(ctx.settings.lunchEnd) + ')에도 근무');
      }
      return { message: lines.join('\n'), isPrivate: false };
    },

    /** 이번 주(월~금, 시간표에 토·일이 있으면 포함) 요일별 근무 시간 합계 그래프 */
    workChartWeek: function (ctx, anyDate) {
      var mon = DateUtil.monday(anyDate);
      var hasSat = ctx.members.some(function (m) { return !!scheduleFor(ctx, m.name, DateUtil.addDays(mon, 5)); });
      var hasSun = ctx.members.some(function (m) { return !!scheduleFor(ctx, m.name, DateUtil.addDays(mon, 6)); });
      var count = 5 + (hasSat ? 1 : 0) + (hasSun ? 1 : 0);

      var days = [];
      for (var i = 0; i < count; i++) {
        var d = DateUtil.addDays(mon, i);
        var ymd = DateUtil.ymd(d);
        var label = DateUtil.WEEKDAYS[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
        if (ctx.holidays[ymd]) { days.push({ label: label, totalMin: 0, offCount: 0, holiday: true }); continue; }
        var recs = activeRecordsOn(ctx, ymd);
        var total = 0, offNames = {};
        ctx.members.forEach(function (m) {
          var sched = scheduleFor(ctx, m.name, d);
          if (!sched) return;
          var vacMin = 0;
          recs.forEach(function (r) {
            if (r.email === m.email) {
              vacMin += TimeUtil.overlapMin(r.startMin, r.endMin, sched.start, sched.end);
            }
          });
          vacMin = Math.min(vacMin, sched.net);
          if (vacMin > 0) offNames[m.name] = true;
          total += sched.net - vacMin;
        });
        days.push({ label: label, totalMin: total, offCount: Object.keys(offNames).length, holiday: false });
      }
      var title = '📊 *이번 주 근무 시간* (' + (mon.getMonth() + 1) + '/' + mon.getDate() +
        '~' + (function (last) { return (last.getMonth() + 1) + '/' + last.getDate(); }(DateUtil.addDays(mon, count - 1))) + ')';
      return { message: ChartText.buildWeekChart(title, days), isPrivate: false };
    }
  };
})();
