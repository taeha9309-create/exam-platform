/**
 * 교수자 계정 생성 스크립트(회원가입 화면이 없으므로 운영자가 직접 만든다 — F-01).
 * 사용: npm run create-staff -- --email a@b.c --name 김교수 --password ********
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { hashPassword } from '../server/src/auth/staffAuth';
import { prisma } from '../server/src/db';

export class CreateStaffError extends Error {}

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  name: z.string().trim().min(1).max(100),
  // bcrypt는 72바이트를 넘는 부분을 무시하므로 글자 수가 아니라 바이트 수로 제한한다.
  password: z
    .string()
    .min(8)
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72),
});

export interface CreateStaffInput {
  email: string;
  name: string;
  password: string;
}

/** 오류 메시지에는 비밀번호를 포함하지 않는다. */
export async function createStaff(input: CreateStaffInput): Promise<{ id: string; email: string; name: string }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    const hints: Record<string, string> = {
      email: '이메일 형식이 올바르지 않습니다(254자 이하)',
      name: '이름은 1~100자여야 합니다',
      password: '비밀번호는 8자 이상, 72바이트(한글은 약 24자) 이하여야 합니다',
    };
    throw new CreateStaffError(fields.map((f) => hints[f] ?? `${f} 값이 올바르지 않습니다`).join(' / '));
  }
  const { email, name, password } = parsed.data;
  const passwordHash = await hashPassword(password);
  try {
    const s = await prisma.staff.create({ data: { email, name, passwordHash }, select: { id: true, email: true, name: true } });
    return s;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new CreateStaffError(`이미 등록된 이메일입니다: ${email}`);
    throw e;
  }
}

async function main(): Promise<number> {
  let values: { email?: string; name?: string; password?: string };
  try {
    ({ values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' } }, strict: true }));
  } catch {
    console.error('사용법: npm run create-staff -- --email a@b.c --name 김교수 --password ********');
    return 1;
  }
  if (!values.email || !values.name || !values.password) {
    console.error('--email, --name, --password를 모두 지정해야 합니다.');
    console.error('사용법: npm run create-staff -- --email a@b.c --name 김교수 --password ********');
    return 1;
  }
  try {
    const s = await createStaff({ email: values.email, name: values.name, password: values.password });
    console.log(`교수자 계정을 만들었습니다: ${s.name} <${s.email}>`); // 비밀번호는 출력하지 않는다
    return 0;
  } catch (e) {
    if (e instanceof CreateStaffError) {
      console.error(`계정을 만들지 못했습니다: ${e.message}`);
    } else {
      console.error('계정을 만들지 못했습니다: 데이터베이스 연결 또는 내부 오류입니다. DATABASE_URL을 확인하세요.');
    }
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

// 직접 실행했을 때만 main을 돈다(테스트에서 import할 때는 실행되지 않는다).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
