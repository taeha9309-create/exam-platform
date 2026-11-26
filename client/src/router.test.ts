import { describe, expect, it } from 'vitest';
import { routes } from './router';

describe('라우트', () => {
  it('지시서의 7개 경로와 안내 화면을 정의한다', () => {
    const paths = routes.map((r) => r.path);
    for (const p of [
      '/staff/login',
      '/staff/exams',
      '/staff/exams/:id/edit',
      '/staff/exams/:id/run',
      '/staff/exams/:id/results',
      '/staff/exams/:id/survey',
      '/e/:examCode',
      '*',
    ])
      expect(paths).toContain(p);
  });
});
