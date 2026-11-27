// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { drafts, session } from './session';

beforeEach(() => localStorage.clear());

describe('session', () => {
  it('토큰을 exam:{code}:token 키로 저장·조회·삭제한다', () => {
    expect(session.get('ABCD2345')).toBeNull();
    session.set('ABCD2345', 'tok');
    expect(localStorage.getItem('exam:ABCD2345:token')).toBe('tok');
    expect(session.get('ABCD2345')).toBe('tok');
    session.clear('ABCD2345');
    expect(session.get('ABCD2345')).toBeNull();
  });

  it('clearAll은 그 시험의 토큰과 초안만 지운다', () => {
    session.set('A', 't');
    session.set('B', 'u');
    drafts.save('A', 'q1', { rev: 2, text: '안녕' });
    drafts.save('B', 'q1', { rev: 1, text: 'x' });
    session.clearAll('A');
    expect(session.get('A')).toBeNull();
    expect(drafts.load('A', 'q1')).toBeNull();
    expect(session.get('B')).toBe('u');
    expect(drafts.load('B', 'q1')).toEqual({ rev: 1, text: 'x' });
  });

  it('초안 키는 exam:{code}:draft:{questionId}', () => {
    drafts.save('A', 'q9', { rev: 3, choiceId: 'c1' });
    expect(localStorage.getItem('exam:A:draft:q9')).toBe(JSON.stringify({ rev: 3, choiceId: 'c1' }));
  });

  it('망가진 초안은 무시한다', () => {
    localStorage.setItem('exam:A:draft:q1', '{not json');
    expect(drafts.load('A', 'q1')).toBeNull();
    localStorage.setItem('exam:A:draft:q1', JSON.stringify({ rev: 'x', text: 1 }));
    expect(drafts.load('A', 'q1')).toBeNull();
  });
});
