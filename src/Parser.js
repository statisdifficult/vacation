/**
 * 한국어 휴가 명령 파서.
 * GAS 서비스 의존성이 없어 Node.js에서도 테스트할 수 있다. (test/run.js)
 *
 * Parser.parse('7/28 10:30-15:30 일반휴가', { today, typeNames, aliases })
 *  → { startDate, endDate, startMin, endMin, halfDay, allDay, type, memo }
 *  → { error: '…' }  (입력을 해석하지 못한 경우)
 *
 * 지원 형식
 *  - 날짜: 7/28, 07.28, 7월28일, 2026-07-28, 오늘, 내일, 모레, 이번주 수, 다음주 월요일
 *  - 기간: 8/3~8/5, 8/3 ~ 8/5, 7/28 7/30 (두 날짜 나열)
 *  - 시간: 10:30-15:30, 10:30~15:30, 10시-15시30분
 *  - 반차: 오전반차, 오후반차 (또는 "오전 반차")
 *  - 종일: 종일/하루/전일, 시간·반차 미입력 시 종일 처리
 *  - 종류: 휴가종류 시트에 있는 이름 ("보건" → "보건휴가"처럼 접미사 생략 허용)
 *  - 그 외 토큰은 비고(memo)로 저장
 */
var Parser = (function () {

  function inferYear(mo, day, today) {
    // 연도 미입력 시: 60일 이상 지난 날짜면 내년으로 해석
    var dt = new Date(today.getFullYear(), mo - 1, day);
    if ((today - dt) / 86400000 > 60) dt = new Date(today.getFullYear() + 1, mo - 1, day);
    if (dt.getMonth() !== mo - 1) return null; // 2/30 같은 존재하지 않는 날짜
    return dt;
  }

  function parseDateToken(tok, today) {
    var m;
    if (tok === '오늘') return today;
    if (tok === '내일') return DateUtil.addDays(today, 1);
    if (tok === '모레') return DateUtil.addDays(today, 2);

    m = tok.match(/^(이번주|다음주|다다음주)(일|월|화|수|목|금|토)(?:요일)?$/);
    if (m) {
      var offs = { '이번주': 0, '다음주': 7, '다다음주': 14 }[m[1]];
      var target = DateUtil.WEEKDAYS.indexOf(m[2]);
      return DateUtil.addDays(DateUtil.monday(today), offs + (target === 0 ? 6 : target - 1));
    }

    m = tok.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})일?$/);
    if (m) {
      var dt = new Date(+m[1], +m[2] - 1, +m[3]);
      return dt.getMonth() === +m[2] - 1 ? dt : null;
    }

    m = tok.match(/^(\d{1,2})[/.](\d{1,2})$/) || tok.match(/^(\d{1,2})월(\d{1,2})일?$/);
    if (m) {
      var mo = +m[1], d = +m[2];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      return inferYear(mo, d, today);
    }
    return null;
  }

  /** "A~B" / "A-B" 토큰을 날짜 범위 또는 시간 범위로 해석 */
  function trySplit(tok, today) {
    var seps = ['~', '-'];
    for (var si = 0; si < seps.length; si++) {
      var i = tok.indexOf(seps[si]);
      while (i !== -1) {
        var L = tok.slice(0, i), R = tok.slice(i + 1);
        var dl = parseDateToken(L, today), dr = parseDateToken(R, today);
        if (dl && dr) return { kind: 'daterange', a: dl, b: dr };
        var tl = TimeUtil.parseHM(L), tr = TimeUtil.parseHM(R);
        if (tl != null && tr != null) return { kind: 'timerange', a: tl, b: tr };
        i = tok.indexOf(seps[si], i + 1);
      }
    }
    return null;
  }

  function matchType(tok, typeNames, aliases) {
    // 별칭은 대상 종류가 실제로 있을 때만 적용 (예: 종류를 '연차'로 개명한 시트도 동작)
    var t = (aliases && aliases[tok] && typeNames.indexOf(aliases[tok]) !== -1) ? aliases[tok] : tok;
    for (var i = 0; i < typeNames.length; i++) {
      if (typeNames[i] === t) return typeNames[i];
    }
    for (var j = 0; j < typeNames.length; j++) {
      if (typeNames[j].replace(/휴가$/, '') === t) return typeNames[j];
    }
    return null;
  }

  /** "오전 반차", "다음주 월" 같은 두 토큰 표현을 하나로 합친다 */
  function joinTokens(tokens) {
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var cur = tokens[i], next = tokens[i + 1];
      if ((cur === '오전' || cur === '오후') && next === '반차') {
        out.push(cur + '반차'); i++;
      } else if (/^(이번주|다음주|다다음주)$/.test(cur) && next && /^(일|월|화|수|목|금|토)(요일)?$/.test(next)) {
        out.push(cur + next); i++;
      } else {
        out.push(cur);
      }
    }
    return out;
  }

  return {
    parse: function (raw, opts) {
      var typeNames = (opts && opts.typeNames) || [];
      var aliases = (opts && opts.aliases) || { '연가': '일반휴가', '연차': '일반휴가' };
      var today = DateUtil.dayStart((opts && opts.today) || new Date());

      var text = String(raw || '').replace(/\s*[~〜]\s*/g, '~').trim();
      if (!text) return { error: '내용을 입력해 주세요.' };

      var tokens = joinTokens(text.split(/\s+/));
      var res = {
        startDate: null, endDate: null, startMin: null, endMin: null,
        halfDay: null, allDay: false, type: null, chargeMonth: null, memo: ''
      };
      var memo = [], halfAmbiguous = false;

      for (var i = 0; i < tokens.length; i++) {
        var tok = tokens[i];

        if (tok === '오전반차') { res.halfDay = 'AM'; continue; }
        if (tok === '오후반차') { res.halfDay = 'PM'; continue; }
        if (tok === '반차') { halfAmbiguous = true; continue; }
        if (tok === '종일' || tok === '하루' || tok === '하루종일' || tok === '전일') { res.allDay = true; continue; }

        // 월 단위 지급 휴가의 당겨쓰기: "8월분" = 8월 몫에서 차감
        var cm = tok.match(/^(\d{1,2})월분$/);
        if (cm && +cm[1] >= 1 && +cm[1] <= 12) { res.chargeMonth = +cm[1]; continue; }
        if (tok === '다음달분' || tok === '다음달몫') { res.chargeMonth = 'NEXT'; continue; }

        var d = parseDateToken(tok, today);
        if (d) {
          if (!res.startDate) res.startDate = d;
          else if (!res.endDate) res.endDate = d;
          else memo.push(tok);
          continue;
        }

        var sp = trySplit(tok, today);
        if (sp && sp.kind === 'daterange') { res.startDate = sp.a; res.endDate = sp.b; continue; }
        if (sp && sp.kind === 'timerange') {
          if (res.startMin == null) { res.startMin = sp.a; res.endMin = sp.b; }
          else memo.push(tok);
          continue;
        }

        var ty = matchType(tok, typeNames, aliases);
        if (ty) { res.type = ty; continue; }

        memo.push(tok);
      }

      if (halfAmbiguous && !res.halfDay) {
        return { error: "'반차'는 '오전반차' 또는 '오후반차'로 입력해 주세요." };
      }
      if (!res.startDate) {
        return { error: '날짜를 찾지 못했습니다. 예) 7/28, 7월28일, 내일, 다음주 월' };
      }
      if (!res.endDate) res.endDate = res.startDate;
      if (res.endDate < res.startDate) {
        var tmp = res.startDate; res.startDate = res.endDate; res.endDate = tmp;
      }
      if ((res.endDate - res.startDate) / 86400000 > 60) {
        return { error: '한 번에 등록할 수 있는 기간은 최대 60일입니다.' };
      }
      if (res.startMin != null && res.endMin <= res.startMin) {
        return { error: '종료 시간이 시작 시간보다 빠릅니다.' };
      }
      if (res.halfDay && res.startMin != null) {
        return { error: '반차와 시간 지정은 함께 쓸 수 없습니다. 하나만 입력해 주세요.' };
      }
      if (res.startMin == null && !res.halfDay) res.allDay = true;
      res.memo = memo.join(' ');
      return res;
    }
  };
})();
