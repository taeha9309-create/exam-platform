import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * 핵심 시험 흐름 E2E (계획 1 Task 16, F-19 일부).
 * 데모 데이터(`npm run demo:reset`)를 쓴다. 필요한 환경변수: DEMO_STAFF_PASSWORD, DEMO_PASSCODE(기본 246810).
 * 화면 문구는 client/src/copy/ko.ts의 실제 문구를 그대로 쓴다.
 */
const STAFF_EMAIL = 'demo@exam.local';
const STAFF_PASSWORD = process.env.DEMO_STAFF_PASSWORD ?? '';
const PASSCODE = process.env.DEMO_PASSCODE ?? '246810';
const DEMO_TITLE = '[데모] 웹 프로그래밍 기말 시험';

test.beforeAll(() => {
  if (!STAFF_PASSWORD) throw new Error('DEMO_STAFF_PASSWORD 환경변수가 필요합니다.');
});

/** 테스트 브라우저를 Chrome으로 보이게 한다(환경 점검이 navigator.userAgentData.brands를 본다). */
async function newStudentContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', { value: { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }], mobile: false, platform: 'Windows' }, configurable: true });
  });
  return context;
}

async function staffLogin(page: Page): Promise<void> {
  await page.goto('/staff/login');
  await page.getByLabel('이메일').fill(STAFF_EMAIL);
  await page.getByLabel('비밀번호').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/exams$/);
}

/** 입장 → 본인 확인 → 동의 → 환경 점검(전체화면) → 대기실 */
async function enterAndGetReady(page: Page, examCode: string, studentNo: string, name: string, passcode = PASSCODE): Promise<void> {
  await page.goto(`/e/${examCode}`);
  await page.getByLabel('학번').fill(studentNo);
  await page.getByLabel('시험 비밀번호').fill(passcode);
  await page.getByRole('button', { name: '입장', exact: true }).click();
  await expect(page.getByText(`${name}(${studentNo}) 님이 맞습니까?`)).toBeVisible();
  await page.getByRole('button', { name: '맞습니다' }).click();
  await page.getByRole('button', { name: '동의하고 계속' }).click();
  await page.getByRole('button', { name: '전체화면으로 전환' }).click();
  await expect(page.getByText('전체화면입니다.')).toBeVisible();
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await expect(page.getByRole('heading', { name: '대기실' })).toBeVisible();
}

/** 문항 목록에서 지문이 일치하는 문항으로 이동한다(문항·보기 순서가 학생마다 섞이므로 지문으로 찾는다). */
async function openQuestion(page: Page, promptPart: string): Promise<void> {
  const buttons = page.getByRole('navigation', { name: '문항 목록' }).getByRole('listitem').getByRole('button');
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    await buttons.nth(i).click();
    if (await page.getByText(promptPart).first().isVisible()) return;
  }
  throw new Error(`문항을 찾지 못했습니다: ${promptPart}`);
}

/** 타이머 문구(mm:ss 또는 h:mm:ss)를 초로 바꾼다. */
async function readTimerSeconds(page: Page): Promise<number> {
  const text = (await page.getByRole('timer').textContent()) ?? '';
  const parts = text.trim().split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

async function submitExam(page: Page): Promise<void> {
  await page.getByRole('button', { name: '제출', exact: true }).click();
  await page.getByRole('button', { name: '제출하기' }).click();
  await expect(page.getByRole('heading', { name: '제출이 완료되었습니다' })).toBeVisible();
}

test('핵심 흐름: 입장 → 시작 → 응시·저장 → 제출·설문 → 종료 → 채점·설문 집계', async ({ browser, page: staff }) => {
  // 1. 교수자 로그인 → 데모 시험 운영 화면
  await staffLogin(staff);
  const row = staff.getByRole('row').filter({ hasText: DEMO_TITLE });
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: '진행' }).click();
  await expect(staff.getByRole('heading', { name: DEMO_TITLE })).toBeVisible();
  const examUrl = staff.url();
  const examId = /\/staff\/exams\/([^/]+)\/run/.exec(examUrl)?.[1] ?? '';
  const entryUrl = (await staff.locator('code').textContent()) ?? '';
  const examCode = entryUrl.split('/e/')[1];
  expect(examCode).toMatch(/^[A-Z0-9]{8}$/);
  await expect(staff.getByRole('region', { name: '입장 현황' })).toContainText('/20');

  // 2. 학생 2명(별도 브라우저 컨텍스트)이 입장·본인 확인·동의·환경 점검
  const ctx1 = await newStudentContext(browser);
  const ctx2 = await newStudentContext(browser);
  const s1 = await ctx1.newPage();
  const s2 = await ctx2.newPage();
  await enterAndGetReady(s1, examCode, '20269001', '학생01');
  await enterAndGetReady(s2, examCode, '20269002', '학생02');

  // 3. 대기실 인원: 교수자 화면은 준비 완료 인원/명단 인원
  await expect(staff.getByRole('region', { name: '입장 현황' }).getByText('2/20')).toBeVisible();
  await expect(s1.getByText('2/20명 입장')).toBeVisible();

  // 4. [시험 시작] → 두 학생 화면에 응시 화면이 2초 안에 표시
  await staff.getByRole('button', { name: '시험 시작' }).click();
  await expect(s1.getByRole('timer')).toBeVisible({ timeout: 2000 });
  await expect(s2.getByRole('timer')).toBeVisible({ timeout: 2000 });
  await expect(s1.getByRole('navigation', { name: '문항 목록' }).getByRole('listitem').getByRole('button')).toHaveCount(7);

  // 5. 남은 시간 차이 ≤ 1초(F-06 AC)
  await expect(s1.getByRole('timer')).not.toHaveText('--:--');
  await expect(s2.getByRole('timer')).not.toHaveText('--:--');
  const [t1, t2] = await Promise.all([readTimerSeconds(s1), readTimerSeconds(s2)]);
  expect(Math.abs(t1 - t2)).toBeLessThanOrEqual(1);
  expect(t1).toBeGreaterThan(29 * 60);

  // 6. 학생1 답안 입력 → 새로고침해도 유지
  await openQuestion(s1, 'HTTP 상태 코드 404');
  await s1.getByRole('radio', { name: '요청한 자원을 찾을 수 없음' }).check();
  await openQuestion(s1, 'REST API가 무엇인지');
  await s1.getByLabel('답안 입력').fill('REST는 자원을 URL로 표현하고 HTTP 메서드로 조작하는 API 설계 방식이다.');
  await openQuestion(s1, '쿠키와 로컬 스토리지');
  await s1.getByLabel('답안 입력').fill('쿠키는 요청마다 서버로 전송되지만 로컬 스토리지는 브라우저에만 남는다.');
  await expect(s1.getByText(/저장됨 \d\d:\d\d:\d\d/)).toBeVisible();
  await s1.reload();
  await expect(s1.getByRole('timer')).toBeVisible();
  // 새로고침하면 전체화면이 풀려 문항이 가려진다(계획 2 Task 7). 전체화면으로 돌아와야 문항이 보인다.
  await s1.getByRole('button', { name: '전체화면으로 돌아가기' }).click();
  await expect(s1.getByRole('navigation', { name: '문항 목록' })).toBeVisible();
  await openQuestion(s1, '쿠키와 로컬 스토리지');
  await expect(s1.getByLabel('답안 입력')).toHaveValue('쿠키는 요청마다 서버로 전송되지만 로컬 스토리지는 브라우저에만 남는다.');
  await openQuestion(s1, 'HTTP 상태 코드 404');
  await expect(s1.getByRole('radio', { name: '요청한 자원을 찾을 수 없음' })).toBeChecked();

  // 7. 학생1 제출 → 설문 제출
  await submitExam(s1);
  await s1.getByRole('radio', { name: '3' }).check();
  await s1.getByLabel('교수님께 하고 싶은 말').fill('시험이 무난했습니다.');
  await s1.getByRole('button', { name: '설문 제출' }).click();
  await expect(s1.getByText('설문에 응해 주셔서 감사합니다')).toBeVisible();

  // 8. 교수자 [시험 종료] → 학생2는 자동으로 제출 완료 화면
  await staff.getByRole('button', { name: '시험 종료' }).click();
  await staff.getByRole('dialog').getByRole('button', { name: '확인' }).click();
  await expect(staff.getByRole('link', { name: '결과 보기' })).toBeVisible();
  await expect(s2.getByRole('heading', { name: '제출이 완료되었습니다' })).toBeVisible({ timeout: 5000 });

  // 9. 결과 화면: 서술형 채점 → 총점(객관식 10 + 서술형 20 + 15 = 45)
  await staff.goto(`/staff/exams/${examId}/results`);
  const dataRow = staff.getByRole('row').filter({ hasText: '20269001' }).first();
  await expect(dataRow).toContainText('학생01');
  const who = '20269001 학생01';
  await staff.getByLabel(`${who} 6번 문항 서술형 점수`).fill('20');
  await staff.getByLabel(`${who} 6번 문항 서술형 점수`).locator('xpath=following::button[1]').click();
  await expect(staff.getByText('점수를 저장했습니다.')).toBeVisible();
  await staff.getByLabel(`${who} 7번 문항 서술형 점수`).fill('15');
  await staff.getByLabel(`${who} 7번 문항 서술형 점수`).locator('xpath=following::button[1]').click();
  await expect(staff.getByRole('row').filter({ hasText: '20269001' }).first().getByRole('cell').nth(5)).toHaveText('45');

  // 10. 설문 화면: 응답 1개
  await staff.goto(`/staff/exams/${examId}/survey`);
  await expect(staff.getByText('응답 1개')).toBeVisible();

  await ctx1.close();
  await ctx2.close();
});

test('마감 처리: 제한 시간이 지나면 1초 안에 제출 완료 화면 (F-11 AC)', async ({ browser, page: staff }) => {
  test.setTimeout(150_000);
  await staffLogin(staff);

  // 제한 1분짜리 별도 시험을 API로 만든다(교수자 로그인 쿠키 사용, Origin 헤더 없는 요청은 허용됨).
  const api = staff.request;
  const created = await api.post('/api/exams', { data: { title: '[데모] 1분 마감 시험', durationMin: 1 } });
  expect(created.status()).toBe(201);
  const examId = (await created.json()).exam.id as string;
  const qRes = await api.put(`/api/exams/${examId}/questions`, {
    data: {
      questions: [
        { type: 'MCQ', prompt: '마감 확인용 문항', points: 10, choices: [{ id: 'a', text: '가' }, { id: 'b', text: '나' }], correctChoiceId: 'a' },
        { type: 'ESSAY', prompt: '마감 확인용 서술형', points: 10 },
      ],
    },
  });
  expect(qRes.status()).toBe(200);
  expect((await api.put(`/api/exams/${examId}/roster`, { data: { csv: '20269001,학생01\n20269002,학생02' } })).status()).toBe(200);
  const opened = (await (await api.post(`/api/exams/${examId}/open`)).json()).exam as { examCode: string; passcode: string };

  const ctx = await newStudentContext(browser);
  const student = await ctx.newPage();
  await enterAndGetReady(student, opened.examCode, '20269001', '학생01', opened.passcode);
  const started = (await (await api.post(`/api/exams/${examId}/start`)).json()).exam as { endsAt: string };
  const endsAt = new Date(started.endsAt).getTime();
  await expect(student.getByRole('timer')).toBeVisible({ timeout: 2000 });
  await openQuestion(student, '마감 확인용 서술형');
  await student.getByLabel('답안 입력').fill('마감 전에 입력한 답안'); // 작성 중이어도 마감되면 제출 처리된다
  await expect(student.getByText(/저장됨 \d\d:\d\d:\d\d/)).toBeVisible();

  // 마감 시각까지 기다린 뒤, 제출 완료 화면이 마감 후 1초 안에 나타나는지 잰다.
  await student.waitForTimeout(Math.max(0, endsAt - Date.now()));
  const heading = student.getByRole('heading', { name: '제출이 완료되었습니다' });
  await expect(heading).toBeVisible({ timeout: 5000 });
  const lag = Date.now() - endsAt;
  console.log(`마감 후 제출 완료 화면까지 ${lag}ms`);
  // AC(F-11)는 "마감 후 1초 안"이다. 서버 마감 티커가 250ms 주기이므로 1초 이내를 필수로 단정한다.
  expect(lag).toBeLessThanOrEqual(1000);

  // 마감으로 제출된 답안이 보존됐는지(서술형 답안이 결과 화면에 보인다)
  await api.post(`/api/exams/${examId}/end`).catch(() => undefined);
  await staff.goto(`/staff/exams/${examId}/results`);
  await expect(staff.getByText('마감 전에 입력한 답안')).toBeVisible();
  await ctx.close();
});
