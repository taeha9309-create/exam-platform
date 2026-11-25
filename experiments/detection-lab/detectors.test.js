import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSidebarResize, pairLeaves, pointerLeaveSignal, inputWithoutFocus } from './detectors.js';

const win = (innerWidth, outerWidth) => ({ innerWidth, outerWidth, innerHeight: 1000, outerHeight: 1080 });

test('사이드바: outer 같고 inner 80px 이상 감소', () => {
  assert.deepEqual(detectSidebarResize(win(1920, 1920), win(1520, 1920)), { type: 'SIDEBAR_SUSPECT', deltaInner: 400 });
});

test('사이드바: 정확히 80px 감소는 신호, 79px는 아님', () => {
  assert.deepEqual(detectSidebarResize(win(1920, 1920), win(1840, 1920)), { type: 'SIDEBAR_SUSPECT', deltaInner: 80 });
  assert.equal(detectSidebarResize(win(1920, 1920), win(1841, 1920)), null);
});

test('사이드바: 창 자체 크기 변경(outer도 변함)은 신호 아님', () => {
  assert.equal(detectSidebarResize(win(1920, 1920), win(960, 960)), null);
});

test('사이드바: 50px 감소는 신호 아님', () => {
  assert.equal(detectSidebarResize(win(1920, 1920), win(1870, 1920)), null);
});

test('사이드바: inner가 늘어난 경우(사이드바 닫힘)는 신호 아님', () => {
  assert.equal(detectSidebarResize(win(1520, 1920), win(1920, 1920)), null);
});

test('이탈·복귀 쌍과 지속 시간, 복귀 없는 이탈은 end null', () => {
  assert.deepEqual(
    pairLeaves([
      { t: 1000, kind: 'leave', cause: 'blur' },
      { t: 6000, kind: 'return', cause: 'blur' },
      { t: 9000, kind: 'leave', cause: 'hidden' },
    ]),
    [
      { cause: 'blur', start: 1000, end: 6000, durationMs: 5000 },
      { cause: 'hidden', start: 9000, end: null, durationMs: null },
    ],
  );
});

test('이탈·복귀: 원인이 섞여도 같은 원인끼리 짝, 입력 순서가 뒤섞여도 시각순 처리', () => {
  assert.deepEqual(
    pairLeaves([
      { t: 7000, kind: 'return', cause: 'hidden' },
      { t: 1000, kind: 'leave', cause: 'hidden' },
      { t: 2000, kind: 'leave', cause: 'blur' },
      { t: 3000, kind: 'return', cause: 'blur' },
    ]),
    [
      { cause: 'hidden', start: 1000, end: 7000, durationMs: 6000 },
      { cause: 'blur', start: 2000, end: 3000, durationMs: 1000 },
    ],
  );
});

test('이탈·복귀: 이탈 없는 복귀는 무시, 빈 입력은 빈 배열', () => {
  assert.deepEqual(pairLeaves([{ t: 500, kind: 'return', cause: 'blur' }]), []);
  assert.deepEqual(pairLeaves([]), []);
});

test('커서 이탈 단계: 1초 미만 null, 1~3초 INFO, 3~15초 WARN, 15초 초과 ALERT', () => {
  assert.equal(pointerLeaveSignal(999), null);
  assert.deepEqual(pointerLeaveSignal(1000), { type: 'POINTER_LEAVE', severity: 'INFO' });
  assert.equal(pointerLeaveSignal(2999).severity, 'INFO');
  assert.equal(pointerLeaveSignal(3000).severity, 'WARN');
  assert.equal(pointerLeaveSignal(15000).severity, 'WARN');
  assert.equal(pointerLeaveSignal(15001).severity, 'ALERT');
});

test('커서 이탈: 숫자가 아니거나 음수면 null', () => {
  assert.equal(pointerLeaveSignal(-5), null);
  assert.equal(pointerLeaveSignal(NaN), null);
  assert.equal(pointerLeaveSignal(null), null);
});

test('포커스 없는 입력', () => {
  assert.equal(inputWithoutFocus({ hasFocus: false, inputType: 'insertText' }), true);
  assert.equal(inputWithoutFocus({ hasFocus: true, inputType: 'insertText' }), false);
});
