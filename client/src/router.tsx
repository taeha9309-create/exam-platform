import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { t } from './copy/ko';

// 임시 화면: 제목만 보인다. 실제 화면은 Task 14·15에서 채운다.
function Placeholder({ title, body }: { title: string; body?: string }) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>{title}</h1>
      {body ? <p>{body}</p> : null}
    </main>
  );
}

export const routes: RouteObject[] = [
  { path: '/staff/login', element: <Placeholder title={t.pages.staffLogin} /> },
  { path: '/staff/exams', element: <Placeholder title={t.pages.staffExams} /> },
  { path: '/staff/exams/:id/edit', element: <Placeholder title={t.pages.staffEdit} /> },
  { path: '/staff/exams/:id/run', element: <Placeholder title={t.pages.staffRun} /> },
  { path: '/staff/exams/:id/results', element: <Placeholder title={t.pages.staffResults} /> },
  { path: '/staff/exams/:id/survey', element: <Placeholder title={t.pages.staffSurvey} /> },
  { path: '/e/:examCode', element: <Placeholder title={t.pages.studentExam} /> },
  {
    path: '*',
    element: <Placeholder title={t.pages.notFoundTitle} body={t.pages.notFoundBody} />,
  },
];

// 모듈 로드 때가 아니라 호출 때 만든다(테스트 환경에는 window가 없다).
export const createAppRouter = () => createBrowserRouter(routes);
