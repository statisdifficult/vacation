/**
 * 휴가 등록·취소·조회·현황 핵심 로직.
 * 모든 함수는 순수 함수로, ctx(시트에서 읽은 데이터)만 입력받아 결과를 반환한다.
 * GAS 서비스 의존성이 없어 Node.js에서도 테스트할 수 있다. (test/run.js)
 *
 * ctx = {
 *   member:  { name, email, alloc: {휴가종류: 분} } | null   — 명령을 보낸 사람
 *   members: [{ name, email, alloc }]                        — 전체 명단(명단 시트 순서)
 *   types:   [{ name, allocMin, isPublic }]                  — 휴가종류 시트
 *   settings:{ workStart, workEnd, lunchStart, lunchEnd, lunchExcluded,
 *              defaultDailyMin, honorific }
 *   schedule:{ 이름: { 요일번호(0~6): {start, end} } }        — 시간표 시트
 *   holidays:{ 'yyyy-MM-dd': '명칭' }                        — 공휴일 시트
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

  /** 이름 기준 그날의 근무시간표. 근무일이 아니면 null */
  function scheduleFor(ctx, name, date) {
    var lunch = lunchOf(ctx.settings);
    var tt = ctx.schedule[name];
    if (tt) {
      var cell = tt[date.getDay()];
      if (!cell) return null;
      return { start: cell.start, end: cell.end, net: TimeUtil.netMinutes(cell.start, cell.end, lunch) };
    }
    // 시간표에 없는 사람은 월~금 기본 근무시간 적용
    if (DateUtil.isWeekend(date)) return null;
    return {
      start: ctx.settings.workStart,
      end: ctx.settings.workEnd,
      net: TimeUtil.netMinutes(ctx.settings.workStart, ctx.settings.workEnd, lunch)
    };
  }

  /** 해당 연도에 사용한 분(상태=등록) */
  function usedMinutes(ctx, email, typeName, year) {
    var sum = 0;
    ctx.records.forEach(function (r) {
      if (r.status === '등록' && r.email === email && r.type === typeName &&
          r.ymd.slice(0, 4) === String(year)) {
        sum += r.minutes;
      }
    });
    return sum;
  }

  function activeRecordsOn(ctx, ymd) {
    return ctx.records.filter(function (r) { return r.status === '등록' && r.ymd === ymd; });
  }

  function timeText(r) {
    return TimeUtil.fmtHM(r.startMin) + '-' + TimeUtil.fmtHM(r.endMin);
  }

  return {
    scheduleFor: scheduleFor,
    usedMinutes: usedMinutes,

    /** 휴가 등록. { ok, rows, message, isPrivate } | { ok:false, message } */
    register: function (ctx, parsed) {
      if (parsed.error) return { ok: false, message: '⚠️ ' + parsed.error + '\n' + Messages.usageShort() };
      if (!ctx.member) return { ok: false, message: Messages.noMember(null) };

      var typeName = parsed.type || (ctx.types[0] && ctx.types[0].name) || '일반휴가';
      var typeInfo = typeOf(ctx, typeName) || { name: typeName, allocMin: 0, isPublic: true };
      var lunch = lunchOf(ctx.settings);
      var member = ctx.member;

      var items = [], skipped = [], conflicts = [];
      for (var d = parsed.startDate; d <= parsed.endDate; d = DateUtil.addDays(d, 1)) {
        var ymd = DateUtil.ymd(d), kd = DateUtil.kdate(d);
        var hol = ctx.holidays[ymd];
        if (hol) { skipped.push(kd + ' ' + (typeof hol === 'string' ? hol : '공휴일')); continue; }

        var sched = scheduleFor(ctx, member.name, d);
        if (!sched) { skipped.push(kd + ' 휴무일'); continue; }

        var s, e, min;
        if (parsed.startMin != null) {
          s = parsed.startMin; e = parsed.endMin;
          min = TimeUtil.netMinutes(s, e, lunch);
        } else if (parsed.halfDay) {
          var mid = sched.start + Math.round((sched.end - sched.start) / 2);
          if (parsed.halfDay === 'AM') { s = sched.start; e = mid; }
          else { s = mid; e = sched.end; }
          min = TimeUtil.netMinutes(s, e, lunch);
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
        items.push({ ymd: ymd, kdate: kd, s: s, e: e, min: min,
                     timeText: TimeUtil.fmtHM(s) + '-' + TimeUtil.fmtHM(e) });
      }

      if (conflicts.length) {
        return { ok: false, message: '⚠️ 이미 등록된 휴가와 겹칩니다: ' + conflicts.join(', ') +
                 '\n먼저 /휴가취소 후 다시 등록해 주세요.' };
      }
      if (!items.length) {
        var why = skipped.length ? ' (' + skipped.join(', ') + ')' : '';
        return { ok: false, message: '⚠️ 등록할 수 있는 날이 없습니다.' + why };
      }

      var totalMin = items.reduce(function (a, it) { return a + it.min; }, 0);

      var allocMin = (member.alloc && member.alloc[typeName] != null)
        ? member.alloc[typeName] : typeInfo.allocMin;
      var remainMin = null, overBudget = false;
      if (allocMin > 0) {
        var year = items[0].ymd.slice(0, 4);
        remainMin = allocMin - usedMinutes(ctx, member.email, typeName, year) - totalMin;
        overBudget = remainMin < 0;
      }

      var rows = items.map(function (it) {
        return [member.name, member.email, typeName, it.ymd,
                TimeUtil.fmtHM(it.s), TimeUtil.fmtHM(it.e), it.min, '등록', parsed.memo || ''];
      });

      var message = Messages.registered({
        name: member.name, honorific: ctx.settings.honorific, typeName: typeName,
        items: items, totalMin: totalMin, remainMin: remainMin,
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

      // 종류별 취소 후 잔여 계산
      var canceledByType = {}, isPrivate = false;
      targets.forEach(function (r) {
        canceledByType[r.type] = (canceledByType[r.type] || 0) + r.minutes;
        var ti = typeOf(ctx, r.type);
        if (ti && !ti.isPublic) isPrivate = true;
      });
      var remains = [];
      Object.keys(canceledByType).forEach(function (t) {
        var ti = typeOf(ctx, t);
        var allocMin = (member.alloc && member.alloc[t] != null) ? member.alloc[t] : (ti ? ti.allocMin : 0);
        if (allocMin > 0) {
          var year = targets[0].ymd.slice(0, 4);
          remains.push({ typeName: t,
            remainMin: allocMin - usedMinutes(ctx, member.email, t, year) + canceledByType[t] });
        }
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
      var member = ctx.member, self = this;
      var year = ctx.today.getFullYear();
      var lines = ['📋 *' + member.name + ' ' + ctx.settings.honorific + ' 휴가 현황*', '', '*잔여 휴가*'];

      ctx.types.forEach(function (t) {
        var allocMin = (member.alloc && member.alloc[t.name] != null) ? member.alloc[t.name] : t.allocMin;
        if (allocMin <= 0) return;
        var remain = allocMin - usedMinutes(ctx, member.email, t.name, year);
        lines.push('• ' + t.name + ': ' + Messages.remainText(remain, ctx.settings.defaultDailyMin));
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
     * 전체 구성원의 잔여 휴가 요약 (관리자용, 항상 비공개 응답).
     * 반환: { message, isPrivate, typeNames, table: [{name, cells:[{alloc,used,remain}|null]}] }
     */
    adminSummary: function (ctx) {
      var year = ctx.today.getFullYear();
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
            var alloc = (m.alloc && m.alloc[tn]) || 0;
            if (alloc <= 0) return null;
            var used = usedMinutes(ctx, m.email, tn, year);
            return { alloc: alloc, used: used, remain: alloc - used };
          })
        };
      });

      var rows = table.map(function (r) {
        return [r.name].concat(r.cells.map(function (c) {
          return c ? TimeUtil.toHoursStr(c.remain) + '/' + TimeUtil.toHoursStr(c.alloc) + 'h' : '-';
        }));
      });
      var message = '👥 *전체 잔여 휴가* (' + year + '년, 잔여/부여 시간)\n' +
        ChartText.buildTable(['이름'].concat(typeNames), rows);
      return { message: message, isPrivate: true, typeNames: typeNames, table: table };
    },

    /** 이번 주(월~금, 시간표에 토·일이 있으면 포함) 요일별 근무 시간 합계 그래프 */
    workChartWeek: function (ctx, anyDate) {
      var mon = DateUtil.monday(anyDate);
      var hasSat = false, hasSun = false;
      Object.keys(ctx.schedule).forEach(function (n) {
        if (ctx.schedule[n][6]) hasSat = true;
        if (ctx.schedule[n][0]) hasSun = true;
      });
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
        '~' + (days.length && function (last) { return (last.getMonth() + 1) + '/' + last.getDate(); }(DateUtil.addDays(mon, count - 1))) + ')';
      return { message: ChartText.buildWeekChart(title, days), isPrivate: false };
    }
  };
})();
