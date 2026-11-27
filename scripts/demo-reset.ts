/**
 * 평가자 시연용 데모 데이터를 지우고 다시 만든다(F-19 일부).
 * 사용: DEMO_STAFF_PASSWORD=******** [DEMO_PASSCODE=246810] npm run demo:reset
 *
 * - 비밀번호(DEMO_STAFF_PASSWORD)는 환경변수로만 받고 출력·기록하지 않는다.
 * - 삭제 대상은 "데모 교수자(demo@exam.local)가 만든 시험"과 그 교수자 계정뿐이다.
 *   시험을 지우면 문항·명단·응시·답안·신호·조치·설문이 Cascade로 함께 지워진다(schema.prisma).
 *   다른 교수자의 시험·계정은 건드리지 않는다. 전부 한 트랜잭션이다.
 * - 입장 비밀번호(DEMO_PASSCODE): 개발·테스트에서는 기본 246810. NODE_ENV=production이면 6자리 숫자로 직접 지정해야 한다.
 */
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../server/src/auth/staffAuth';
import { prisma } from '../server/src/db';
import { generateExamCode } from '../server/src/domain/codes';
import { parseQuestionsInput } from '../server/src/domain/questions';

export const DEMO_EMAIL = 'demo@exam.local';
export const DEMO_TITLE = '[데모] 웹 프로그래밍 기말 시험';
const DEFAULT_PASSCODE = '246810';

export class DemoResetError extends Error {}

/** 환경변수에서 설정을 읽는다. 오류 메시지에는 비밀번호 값을 넣지 않는다. */
export function readDemoConfig(env: NodeJS.ProcessEnv): { staffPassword: string; passcode: string } {
  const staffPassword = env.DEMO_STAFF_PASSWORD ?? '';
  if (staffPassword.length < 8 || Buffer.byteLength(staffPassword, 'utf8') > 72) {
    throw new DemoResetError('DEMO_STAFF_PASSWORD 환경변수(8자 이상, 72바이트 이하)가 필요합니다.');
  }
  const raw = env.DEMO_PASSCODE;
  if (raw === undefined || raw === '') {
    if (env.NODE_ENV === 'production') throw new DemoResetError('운영(NODE_ENV=production)에서는 DEMO_PASSCODE(6자리 숫자)를 직접 지정해야 합니다.');
    return { staffPassword, passcode: DEFAULT_PASSCODE };
  }
  if (!/^\d{6}$/.test(raw)) throw new DemoResetError('DEMO_PASSCODE는 6자리 숫자여야 합니다.');
  return { staffPassword, passcode: raw };
}

const mcq = (prompt: string, correct: string, wrong: string[]) => ({
  type: 'MCQ' as const,
  prompt,
  points: 10,
  choices: [correct, ...wrong].map((text, i) => ({ id: `c${i + 1}`, text })),
  correctChoiceId: 'c1', // 정답 id는 서버에만 있고 학생 API에는 내려가지 않는다
});

const QUESTIONS = [
  mcq('HTTP 상태 코드 404의 의미는?', '요청한 자원을 찾을 수 없음', ['서버 내부 오류', '인증이 필요함', '요청이 성공함']),
  mcq('브라우저에서 비동기 요청을 보낼 때 쓰는 내장 함수는?', 'fetch', ['printf', 'require', 'import.meta']),
  mcq('CSS에서 글자 색을 바꾸는 속성은?', 'color', ['font-style', 'margin', 'display']),
  mcq('JavaScript에서 변경할 수 없는 변수를 선언하는 키워드는?', 'const', ['var', 'let', 'static']),
  mcq('관계형 데이터베이스에서 행을 고유하게 구분하는 키는?', '기본키', ['외래키', '인덱스', '뷰']),
  { type: 'ESSAY' as const, prompt: 'REST API가 무엇인지 두세 문장으로 설명하시오.', points: 25 },
  { type: 'ESSAY' as const, prompt: '쿠키와 로컬 스토리지의 차이를 설명하시오.', points: 25 },
];

const ROSTER = Array.from({ length: 20 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { studentNo: `202690${n}`, name: `학생${n}` };
});

async function main(): Promise<number> {
  let config: ReturnType<typeof readDemoConfig>;
  try {
    config = readDemoConfig(process.env);
  } catch (e) {
    console.error(`데모 데이터를 만들지 못했습니다: ${(e as Error).message}`);
    return 1;
  }
  const parsed = parseQuestionsInput(QUESTIONS);
  if (!parsed.ok) {
    console.error('데모 문항이 문항 검증을 통과하지 못했습니다(스크립트 오류).');
    return 1;
  }
  try {
    const passwordHash = await hashPassword(config.staffPassword);
    const exam = await prisma.$transaction(async (tx) => {
      // 삭제 대상: 데모 교수자가 만든 시험(Cascade로 문항·명단·응시·답안·신호·조치·설문 포함)과 데모 교수자 계정.
      const demo = await tx.staff.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } });
      if (demo) {
        await tx.exam.deleteMany({ where: { ownerId: demo.id } });
        await tx.staff.delete({ where: { id: demo.id } });
      }
      const staff = await tx.staff.create({ data: { email: DEMO_EMAIL, name: '데모 교수자', passwordHash } });
      return tx.exam.create({
        data: {
          ownerId: staff.id,
          examCode: generateExamCode(),
          title: DEMO_TITLE,
          instructions: '평가자 시연용 데모 시험입니다.',
          durationMin: 30,
          status: 'OPEN',
          passcode: config.passcode,
          questions: {
            create: parsed.questions.map((q, position) => ({
              position,
              type: q.type,
              prompt: q.prompt,
              points: q.points,
              choices: q.choices ?? undefined,
              correctChoiceId: q.correctChoiceId ?? null,
            })),
          },
          roster: { create: ROSTER },
        },
        select: { examCode: true },
      });
    });
    console.log(`데모 데이터를 만들었습니다. 교수자: ${DEMO_EMAIL} / 시험 코드: ${exam.examCode} (입장 주소: /e/${exam.examCode}) / 명단: 20269001~20269020`);
    return 0;
  } catch {
    console.error('데모 데이터를 만들지 못했습니다: 데이터베이스 연결 또는 내부 오류입니다. DATABASE_URL을 확인하세요.');
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
