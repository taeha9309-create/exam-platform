import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * 감지·감독 대시보드 E2E (계획 2 Task 10).
 * 목적: "학생 화면의 신호가 서버를 거쳐 대시보드·학생 화면까지 흐르는 통합"을 검증한다. 실제 기기 감지의 정확도는 0단계 실험(#6)에서 사람이 확인한다.
 *
 * 어떤 것을 실제로, 어떤 것을 흉내 냈는가:
 * - 이탈(LEAVE): 흉내. Playwright(headless Chromium)는 포커스 에뮬레이션 때문에 탭 전환·창 포커스 이탈이 실제로 일어나지 않는다.
 *   CDP Emulation.setFocusEmulationEnabled(false) + 두 번째 탭 bringToFront도 visibilitychange/blur를 일으키지 못함을 확인했다.
 *   그래서 `document.hidden`·`visibilityState`·`document.hasFocus()`를 페이지 안에서 덮어쓰고 실제 `visibilitychange`·`blur`/`focus` 이벤트를 발생시킨다.
 *   앱의 이벤트 리스너와 1초 폴링은 진짜 코드 경로 그대로 동작하고, "브라우저가 이탈을 알려 주는 부분"만 가짜다.
 * - 전체화면 해제(FULLSCREEN_EXIT): 실제. 학생 화면이 진짜 requestFullscreen으로 전체화면에 들어가고, `document.exitFullscreen()`으로 실제 fullscreenchange를 일으킨다.
 * - 붙여넣기(PASTE): 반쯤 흉내. 운영체제 클립보드 대신 DataTransfer를 담은 합성 `paste` 이벤트를 답안 입력란에 보낸다(앱의 paste 리스너·차단 로직은 실제).
 * - 서버·소켓·DB·대시보드 화면·경고 창은 모두 실제(빌드된 서버 + Chromium 컨텍스트).
 *
 * 실행 방법은 docs/DEMO.md 3장(전용 DB exam_e2e). 데모 교수자(demo@exam.local)로 로그인하며, 시험은 이 파일이 API로 새로 만든다.
 */
const STAFF_EMAIL = 'demo@exam.local';
const STAFF_PASSWORD = process.env.DEMO_STAFF_PASSWORD ?? '';
const LIMIT = 5;

test.use({ actionTimeout: 15_000 }); // 요소를 못 찾을 때 4분을 기다리지 않고 빨리 실패

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

async function readTimerSeconds(page: Page): Promise<number> {
  const text = (await page.getByRole('timer').textContent()) ?? '';
  return text.trim().split(':').map(Number).reduce((acc, p) => acc * 60 + p, 0);
}

/** 흉내: 탭이 숨겨지고 창이 포커스를 잃은 것처럼 브라우저 상태를 덮어쓰고 실제 이벤트를 보낸다. */
async function leaveTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.hasFocus = () => false;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
}

/** 흉내: 탭으로 돌아온 상태로 되돌린다(덮어쓴 값을 지우면 브라우저의 진짜 값이 보인다). */
async function returnToTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    delete (document as unknown as Record<string, unknown>).hidden;
    delete (document as unknown as Record<string, unknown>).visibilityState;
    delete (document as unknown as Record<string, unknown>).hasFocus;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** 반쯤 흉내: 클립보드 데이터를 가진 paste 이벤트를 답안 입력란에 보내고, 앱이 기본 동작을 막았는지 돌려준다. */
async function pasteInto(field: Locator, text: string): Promise<boolean> {
  return field.evaluate((el, value) => {
    const dt = new DataTransfer();
    dt.setData('text', value);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, text);
}

const cardOf = (staff: Page, studentNo: string) => staff.getByTestId('student-card').and(staff.locator(`[data-student-no="${studentNo}"]`));

test('감지·대시보드 흐름: 신호 → 카드·타임라인 → 자동 잠금 → 재개·시간 추가 → 경고 (F-12~F-16)', async ({ browser, page: staff }) => {
  test.setTimeout(240_000);
  await staffLogin(staff);

  // 시험 준비: BLOCK 시험(붙여넣기 차단), 학생 2명 명단, 입장 열기
  const api = staff.request;
  const created = await api.post('/api/exams', { data: { title: '[E2E] 감지 시험', durationMin: 30 } });
  expect(created.status()).toBe(201);
  const examId = (await created.json()).exam.id as string;
  expect((await api.patch(`/api/exams/${examId}`, { data: { pasteMode: 'BLOCK' } })).status()).toBe(200);
  const qRes = await api.put(`/api/exams/${examId}/questions`, {
    data: {
      questions: [
        { type: 'MCQ', prompt: '감지 확인용 객관식', points: 10, choices: [{ id: 'a', text: '가' }, { id: 'b', text: '나' }], correctChoiceId: 'a' },
        { type: 'ESSAY', prompt: '감지 확인용 서술형', points: 10 },
      ],
    },
  });
  expect(qRes.status()).toBe(200);
  expect((await api.put(`/api/exams/${examId}/roster`, { data: { csv: '20269001,학생01\n20269002,학생02' } })).status()).toBe(200);
  const opened = (await (await api.post(`/api/exams/${examId}/open`)).json()).exam as { examCode: string; passcode: string };

  const s1ctx = await newStudentContext(browser);
  const s2ctx = await newStudentContext(browser);
  const s1 = await s1ctx.newPage();
  const s2 = await s2ctx.newPage();
  await enterAndGetReady(s1, opened.examCode, '20269001', '학생01', opened.passcode);
  await enterAndGetReady(s2, opened.examCode, '20269002', '학생02', opened.passcode);

  // 교수자 대시보드 2개: 첫 번째(staff) + 두 번째 교수자 컨텍스트(h)
  await staff.goto(`/staff/exams/${examId}/run`);
  const staff2ctx = await browser.newContext();
  const staff2 = await staff2ctx.newPage();
  await staffLogin(staff2);
  await staff2.goto(`/staff/exams/${examId}/run`);

  expect((await api.post(`/api/exams/${examId}/start`)).status()).toBe(200);
  await expect(s1.getByRole('timer')).toBeVisible({ timeout: 2000 });
  await expect(s2.getByRole('timer')).toBeVisible({ timeout: 2000 });
  const c1 = cardOf(staff, '20269001');
  const c2 = cardOf(staff, '20269002');
  const c1b = cardOf(staff2, '20269001');
  await expect(c1).toHaveAttribute('data-tone', 'green');
  await expect(c1).toContainText(`위반 0/${LIMIT}`);

  // (a) 다른 탭으로 5초 → 돌아오면 LEAVE(약 5초)가 2초 안에 대시보드에 나타나고 카드가 노랑
  await leaveTab(s1);
  await expect(c1).toContainText('이탈 중', { timeout: 3000 }); // LEAVE_START도 대시보드에 반영
  await s1.waitForTimeout(5000);
  await returnToTab(s1);
  await expect(c1).toContainText(/다른 탭\/앱으로 이동 \([4-6]초\)/, { timeout: 2000 });
  await expect(c1).toHaveAttribute('data-tone', 'yellow');
  await expect(c1).toContainText(`위반 1/${LIMIT}`);
  // (h) 두 번째 교수자 컨텍스트도 같은 신호를 받는다
  await expect(c1b).toContainText(/다른 탭\/앱으로 이동 \([4-6]초\)/, { timeout: 2000 });
  await expect(c1b).toHaveAttribute('data-tone', 'yellow');
  await expect(s1.getByText(`위반 1/${LIMIT}: 화면 이탈`)).toBeVisible();

  // (b) 전체화면 해제(실제 fullscreenchange): 문항이 가려지고 FULLSCREEN_EXIT 기록, 위반 누적 2/5
  await s1.evaluate(() => document.exitFullscreen());
  await expect(s1.getByRole('heading', { name: '전체화면으로 돌아가 주세요' })).toBeVisible({ timeout: 2000 });
  await expect(s1.getByLabel('답안 입력')).toHaveCount(0);
  await expect(c1).toContainText('전체화면 해제', { timeout: 2000 });
  await expect(c1).toContainText(`위반 2/${LIMIT}`);
  await s1.getByRole('button', { name: '전체화면으로 돌아가기' }).click();
  await expect(s1.getByRole('heading', { name: '전체화면으로 돌아가 주세요' })).toHaveCount(0);

  // (c) BLOCK 시험: 붙여넣기가 막히고 PASTE(차단됨)가 기록된다(위반 3/5)
  await s1.getByRole('navigation', { name: '문항 목록' }).getByRole('listitem').getByRole('button').nth(1).click();
  let essay = s1.getByLabel('답안 입력');
  if (!(await essay.isVisible())) {
    await s1.getByRole('navigation', { name: '문항 목록' }).getByRole('listitem').getByRole('button').nth(0).click();
    essay = s1.getByLabel('답안 입력');
  }
  await expect(essay).toBeVisible();
  const pasted = '복사해 온 답안 340자 가정';
  const pastedLen = [...pasted].length;
  expect(await pasteInto(essay, pasted)).toBe(true); // 앱이 preventDefault 했다
  await expect(essay).toHaveValue('');
  await expect(s1.getByText('이 시험에서는 붙여넣기를 할 수 없습니다')).toBeVisible();
  await expect(c1).toContainText(`붙여넣기 ${pastedLen}자 (차단됨)`, { timeout: 2000 });
  await expect(c1).toContainText(`위반 3/${LIMIT}`);
  // 상세 패널 타임라인에 시간순으로 기록된다
  await c1.getByRole('button', { name: '학생01 상세 보기' }).click();
  const panel = staff.getByRole('dialog', { name: '학생01 (20269001) 상세' });
  const items = panel.getByTestId('signal-item');
  await expect(items.filter({ hasText: '다른 탭/앱으로 이동 (' })).toHaveCount(1);
  await expect(items.filter({ hasText: '전체화면 해제' })).toHaveCount(1);
  await expect(items.filter({ hasText: `붙여넣기 ${pastedLen}자 (차단됨)` })).toHaveCount(1);

  // (d) 위반 5회: 붙여넣기 2번 더 → 학생1 화면 잠김, 카드 빨강 + 잠금
  await pasteInto(essay, '두 번째 시도');
  await expect(c1).toContainText(`위반 4/${LIMIT}`, { timeout: 2000 });
  await pasteInto(essay, '세 번째 시도');
  await expect(s1.getByText(`위반이 ${LIMIT}회 쌓여 화면이 잠겼습니다`)).toBeVisible({ timeout: 2000 });
  await expect(c1).toHaveAttribute('data-locked', 'true', { timeout: 2000 });
  await expect(c1).toHaveAttribute('data-tone', 'red');
  await expect(c1).toContainText('잠김');
  await expect(c1b).toHaveAttribute('data-locked', 'true', { timeout: 2000 });
  await expect(c1b).toHaveAttribute('data-tone', 'red');
  await expect(items.filter({ hasText: '붙여넣기 ' })).toHaveCount(3); // 패널은 열린 채 새 신호가 실시간으로 추가된다
  // (조치 기록은 패널을 열 때 한 번 조회하므로 실시간으로 늘지 않는다. 새로고침 뒤 다시 열어 확인한다.)

  // (g) 대시보드를 새로고침해도 같은 카드 색·상태
  await staff.reload();
  await expect(c1).toHaveAttribute('data-locked', 'true');
  await expect(c1).toHaveAttribute('data-tone', 'red');
  await expect(c1).toHaveAttribute('data-paused', 'true');
  await expect(c1).toContainText(`위반 5/${LIMIT}`);
  await expect(c1).toContainText('붙여넣기 ');
  await c1.getByRole('button', { name: '학생01 상세 보기' }).click();
  await expect(staff.getByRole('dialog', { name: '학생01 (20269001) 상세' }).getByTestId('action-item').filter({ hasText: '자동 일시정지(위반 누적)' })).toHaveCount(1);
  await staff.getByRole('dialog', { name: '학생01 (20269001) 상세' }).getByRole('button', { name: '닫기' }).click();

  // (i) 학생2는 영향 없이 계속 응시
  await expect(c2).toHaveAttribute('data-tone', 'green');
  await expect(c2).toContainText(`위반 0/${LIMIT}`);
  await expect(s2.getByRole('timer')).toBeVisible();
  await expect(s2.getByLabel('답안 입력').or(s2.getByRole('radio').first())).toBeVisible();

  // (e) 감독관: 학생1 [조치] → 사유 → [재개 + 잠겨 있던 시간 추가] → 이어서 응시, 마감 +1분, RESUME·ADD_TIME 기록
  await c1.getByRole('button', { name: '조치', exact: true }).click();
  await staff.getByLabel('사유(경고는 학생에게 보이는 메시지)').fill('현장 확인 후 재개');
  await staff.getByRole('button', { name: /^잠겨 있던 시간 \d+분 추가$/ }).click();
  await expect(c1).toHaveAttribute('data-paused', 'false', { timeout: 2000 });
  await expect(c1).toHaveAttribute('data-locked', 'false');
  await expect(s1.getByRole('timer')).toBeVisible({ timeout: 2000 });
  await expect(s1.getByLabel('답안 입력').or(s1.getByRole('radio').first())).toBeVisible();
  const [t1, t2] = await Promise.all([readTimerSeconds(s1), readTimerSeconds(s2)]);
  expect(t1 - t2).toBeGreaterThanOrEqual(55); // 잠겨 있던 시간은 1분 미만 → 올림해서 1분 추가
  expect(t1 - t2).toBeLessThanOrEqual(65);
  await c1.getByRole('button', { name: '학생01 상세 보기' }).click();
  const panel2 = staff.getByRole('dialog', { name: '학생01 (20269001) 상세' });
  await expect(panel2).toContainText('추가 시간 1분');
  const actions = panel2.getByTestId('action-item');
  await expect(actions.filter({ hasText: /재개 · /})).toHaveCount(1);
  await expect(actions.filter({ hasText: /시간 추가 · /})).toHaveCount(1);
  await expect(actions.filter({ hasText: '현장 확인 후 재개' }).first()).toBeVisible();
  await panel2.getByRole('button', { name: '닫기' }).click();

  // (f) 경고 메시지: 2초 안에 학생 화면에 뜨고 [확인]으로 닫힌다
  if ((await c1.getByRole('button', { name: '조치', exact: true }).getAttribute('aria-pressed')) !== 'true') await c1.getByRole('button', { name: '조치', exact: true }).click(); // 선택은 토글이라 이미 선택돼 있으면 누르지 않는다
  await staff.getByLabel('사유(경고는 학생에게 보이는 메시지)').fill('옆 사람 화면을 보지 마세요');
  await staff.getByRole('button', { name: '경고 메시지 보내기' }).click();
  const warning = s1.getByRole('dialog', { name: '감독관 안내' });
  await expect(warning).toContainText('옆 사람 화면을 보지 마세요', { timeout: 2000 });
  await warning.getByRole('button', { name: '확인' }).click();
  await expect(warning).toHaveCount(0);
  await expect(s2.getByRole('dialog', { name: '감독관 안내' })).toHaveCount(0); // (i) 학생2에게는 가지 않는다

  await s1ctx.close();
  await s2ctx.close();
  await staff2ctx.close();
});
