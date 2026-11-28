import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * 답안 보존 E2E (계획 3 Task 2, SPEC F-11 AC "네트워크를 끊고 입력한 뒤 다시 연결하면 서버에 저장", "새로고침 후 복구").
 * 시나리오: 서술형 입력(저장됨) → 네트워크 차단 → 추가 입력(서버에는 아직 없음을 확인) → 오프라인 새로고침
 *          → 복구 후 새로고침 → 화면에 답이 남고, 서버(API 조회)에도 저장됨.
 * 헬퍼는 core-flow.spec.ts와 같은 내용을 복제했다(spec 파일을 import하면 그쪽 테스트까지 등록되므로 core-flow는 수정하지 않는다).
 * 같은 시나리오를 3번 반복해 플레이크(간헐 실패)를 드러낸다.
 */
const STAFF_EMAIL = 'demo@exam.local';
const STAFF_PASSWORD = process.env.DEMO_STAFF_PASSWORD ?? '';

test.beforeAll(() => {
  if (!STAFF_PASSWORD) throw new Error('DEMO_STAFF_PASSWORD 환경변수가 필요합니다.');
});

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

async function enterAndGetReady(page: Page, examCode: string, studentNo: string, name: string, passcode: string): Promise<void> {
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

async function openQuestion(page: Page, promptPart: string): Promise<void> {
  const buttons = page.getByRole('navigation', { name: '문항 목록' }).getByRole('listitem').getByRole('button');
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    await buttons.nth(i).click();
    if (await page.getByText(promptPart).first().isVisible()) return;
  }
  throw new Error(`문항을 찾지 못했습니다: ${promptPart}`);
}

const ESSAY_PROMPT = '답안 보존 확인용 서술형';
const ONLINE_TEXT = '온라인일 때 입력한 답안입니다.';
const OFFLINE_TEXT = `${ONLINE_TEXT} 네트워크가 끊긴 동안 추가로 입력한 내용입니다.`;

for (const run of [1, 2, 3]) {
  test(`답안 보존: 네트워크 차단 중 입력 → 오프라인 새로고침 → 복구 후 서버 저장·화면 복구 (반복 ${run}/3)`, async ({ browser, page: staff }) => {
    await staffLogin(staff);
    const api = staff.request;
    const created = await api.post('/api/exams', { data: { title: `[데모] 답안 보존 시험 ${run}`, durationMin: 10 } });
    expect(created.status()).toBe(201);
    const examId = (await created.json()).exam.id as string;
    expect(
      (await api.put(`/api/exams/${examId}/questions`, { data: { questions: [{ type: 'ESSAY', prompt: ESSAY_PROMPT, points: 10 }] } })).status(),
    ).toBe(200);
    expect((await api.put(`/api/exams/${examId}/roster`, { data: { csv: '20269001,학생01' } })).status()).toBe(200);
    const opened = (await (await api.post(`/api/exams/${examId}/open`)).json()).exam as { examCode: string; passcode: string };

    const ctx = await newStudentContext(browser);
    try {
      const s = await ctx.newPage();
      // WebSocket 프레임을 관찰한다. 오프라인 에뮬레이션은 소켓을 닫지 않고(close 이벤트 없음) 전송만 막으므로,
      // 클라이언트가 answer:save를 "보냈는지"(시도)와 서버 응답(ack)이 "왔는지"를 프레임 이벤트로 센다.
      let sockets = 0;
      let saveSent = 0;
      let saveAcked = 0;
      s.on('websocket', (ws) => {
        sockets += 1;
        ws.on('framesent', (f) => { if (String(f.payload).includes('answer:save')) saveSent += 1; });
        ws.on('framereceived', (f) => { if (/^43\d*\[/.test(String(f.payload)) && String(f.payload).includes('savedAt')) saveAcked += 1; });
      });
      await enterAndGetReady(s, opened.examCode, '20269001', '학생01', opened.passcode);
      expect((await api.post(`/api/exams/${examId}/start`)).status()).toBe(200);
      await expect(s.getByRole('timer')).toBeVisible({ timeout: 10_000 });
      const token = await s.evaluate((code) => localStorage.getItem(`exam:${code}:token`), opened.examCode);
      expect(token).toBeTruthy();

      /** 서버에 저장된 서술형 답안(학생 API 조회). 문항은 하나뿐이다. 조회는 교수자 컨텍스트의 요청으로 보내 학생 컨텍스트의 오프라인 설정과 무관하다. */
      const serverText = async (): Promise<string | undefined> => {
        const res = await api.get('/api/student/exam', { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { answers: { text?: string }[] };
        return body.answers[0]?.text;
      };

      // 1. 온라인 입력 → 저장됨 + 서버 반영 (문항 목록은 비동기로 받아 오므로 항목이 나타난 뒤 연다)
      await expect(s.getByRole('navigation', { name: '문항 목록' }).getByRole('listitem').getByRole('button')).toHaveCount(1);
      await openQuestion(s, ESSAY_PROMPT);
      await s.getByLabel('답안 입력').fill(ONLINE_TEXT);
      await expect(s.getByText(/저장됨 \d\d:\d\d:\d\d/)).toBeVisible();
      await expect.poll(serverText).toBe(ONLINE_TEXT);

      // 2. 네트워크 차단 → 추가 입력. 서버에는 반영되지 않아야 한다(차단이 소켓에도 실제로 효과가 있다는 확인).
      expect(sockets).toBeGreaterThan(0);
      expect(saveAcked).toBeGreaterThan(0); // 온라인에서는 저장 ack가 왔다
      const sentBefore = saveSent;
      const ackedBefore = saveAcked;
      await ctx.setOffline(true);
      expect(await s.evaluate(() => navigator.onLine)).toBe(false); // 차단이 브라우저에 적용됨
      await s.getByLabel('답안 입력').fill(OFFLINE_TEXT);
      // 이벤트 기반 대기(상한 15초): 오프라인 중에도 클라이언트가 저장을 "시도"했다(answer:save 프레임 전송). 시도가 없으면 아래 단정이 무의미하다.
      await expect.poll(() => saveSent, { timeout: 15_000 }).toBeGreaterThan(sentBefore);
      await expect(s.getByText('저장 중…')).toBeVisible(); // 화면은 미저장 상태
      expect(saveAcked).toBe(ackedBefore); // 시도했지만 서버 응답은 오지 않았다
      expect(await serverText()).toBe(ONLINE_TEXT);

      // 3. 오프라인 새로고침: 페이지를 못 불러오는 것이 정상이다(예외는 무시). 초안은 localStorage에 남아 있다.
      await expect(s.reload()).rejects.toThrow(); // 오프라인이므로 새로고침은 실패해야 한다(오류 화면)

      // 4. 복구 → 새로고침 → 화면 복구
      await ctx.setOffline(false);
      await s.reload();
      await expect(s.getByRole('timer')).toBeVisible({ timeout: 10_000 });
      await s.getByRole('button', { name: '전체화면으로 돌아가기' }).click();
      // 문항 목록은 새로고침 뒤 서버에서 다시 받아 오므로(비동기) 항목이 나타날 때까지 기다린 뒤 연다.
      await expect(s.getByRole('navigation', { name: '문항 목록' }).getByRole('listitem').getByRole('button')).toHaveCount(1);
      await openQuestion(s, ESSAY_PROMPT);
      await expect(s.getByLabel('답안 입력')).toHaveValue(OFFLINE_TEXT);

      // 5. 서버에도 저장됨(복구 후 재전송)
      await expect.poll(serverText, { timeout: 15_000 }).toBe(OFFLINE_TEXT);
    } finally {
      await api.post(`/api/exams/${examId}/end`).catch(() => undefined);
      await ctx.close();
    }
  });
}
