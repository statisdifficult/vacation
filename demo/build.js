/**
 * 체험용 웹페이지 빌드: src/의 순수 로직을 template.html에 삽입해 index.html을 만든다.
 * 실행: node demo/build.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = ['Util.js', 'Messages.js', 'Parser.js', 'Chart.js', 'VacationService.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))
  .join('\n');

const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const out = tpl.replace('/*__BOT_SOURCES__*/', () => src);
fs.writeFileSync(path.join(__dirname, 'index.html'), out);
console.log('demo/index.html 생성 완료 (' + Math.round(out.length / 1024) + 'KB)');
