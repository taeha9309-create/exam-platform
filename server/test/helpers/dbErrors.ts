import { Prisma } from '@prisma/client';
import { expect } from 'vitest';

/** 성공하면 안 되는 작업의 오류를 받아 온다. 성공해 버리면 테스트를 실패시킨다. */
async function failure(op: Promise<unknown>): Promise<unknown> {
  return op.then(
    () => {
      throw new Error('오류가 나야 하는 작업이 성공했습니다');
    },
    (err: unknown) => err,
  );
}

function known(err: unknown): Prisma.PrismaClientKnownRequestError {
  expect(err, `PrismaClientKnownRequestError가 아님: ${String(err)}`).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  return err as Prisma.PrismaClientKnownRequestError;
}

/**
 * 같은 "오류가 난다"여도 이유가 다르면 다른 결함이다. 그래서 오류의 종류와 대상까지 단언한다
 * (측정 결과: unique=P2002, FK=P2003, 길이 초과=P2000, CHECK=코드 없는 UnknownRequestError + PostgreSQL 23514).
 */

/** UNIQUE 위반(P2002). target은 위반된 필드 목록 */
export async function expectUniqueViolation(op: Promise<unknown>, target: string[]): Promise<void> {
  const err = known(await failure(op));
  expect(err.code).toBe('P2002');
  expect(err.meta?.target).toEqual(target);
}

/** FOREIGN KEY 위반(P2003). 예: Restrict로 막힌 삭제 */
export async function expectForeignKeyViolation(op: Promise<unknown>, constraint: string): Promise<void> {
  const err = known(await failure(op));
  expect(err.code).toBe('P2003');
  expect(err.meta?.constraint).toBe(constraint);
}

/** 값이 컬럼 길이를 넘음(P2000) */
export async function expectValueTooLong(op: Promise<unknown>): Promise<void> {
  const err = known(await failure(op));
  expect(err.code).toBe('P2000');
}

/** CHECK 제약 위반. Prisma가 코드 없이 던지므로 메시지의 PostgreSQL 코드(23514)와 제약 이름을 확인한다 */
export async function expectCheckViolation(op: Promise<unknown>, constraint: string): Promise<void> {
  const err = await failure(op);
  expect(err, `PrismaClientUnknownRequestError가 아님: ${String(err)}`).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
  const message = (err as Error).message;
  expect(message).toContain('23514');
  expect(message).toContain(constraint);
}
