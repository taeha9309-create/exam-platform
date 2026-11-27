import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { t } from './copy/ko';
import { ExamEditPage } from './pages/staff/ExamEditPage';
import { ExamListPage } from './pages/staff/ExamListPage';
import { ExamRunPage } from './pages/staff/ExamRunPage';
import { LoginPage } from './pages/staff/LoginPage';
import { ResultsPage } from './pages/staff/ResultsPage';
import { SurveyPage } from './pages/staff/SurveyPage';
import { StudentFlow } from './pages/student/StudentFlow';

// 임시 화면: 존재하지 않는 주소 안내에만 쓴다.
function Placeholder({ title, body }: { title: string; body?: string }) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>{title}</h1>
      {body ? <p>{body}</p> : null}
    </main>
  );
}

export const routes: RouteObject[] = [
  { path: '/staff/login', element: <LoginPage /> },
  { path: '/staff/exams', element: <ExamListPage /> },
  { path: '/staff/exams/:id/edit', element: <ExamEditPage /> },
  { path: '/staff/exams/:id/run', element: <ExamRunPage /> },
  { path: '/staff/exams/:id/results', element: <ResultsPage /> },
  { path: '/staff/exams/:id/survey', element: <SurveyPage /> },
  { path: '/e/:examCode', element: <StudentFlow /> },
  {
    path: '*',
    element: <Placeholder title={t.pages.notFoundTitle} body={t.pages.notFoundBody} />,
  },
];

// 모듈 로드 때가 아니라 호출 때 만든다(테스트 환경에는 window가 없다).
export const createAppRouter = () => createBrowserRouter(routes);
