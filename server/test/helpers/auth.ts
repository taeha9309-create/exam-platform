import type { Staff } from '@prisma/client';
import { hashPassword, signStaffToken } from '../../src/auth/staffAuth';
import { makeStaff } from './db';

export const TEST_PASSWORD = 'correct-horse-battery';

/** 실제 bcrypt 해시를 가진 교수자를 만든다(로그인 테스트용). */
export async function makeLoginStaff(overrides: Partial<Omit<Staff, 'id' | 'createdAt' | 'passwordHash'>> = {}, password = TEST_PASSWORD): Promise<Staff> {
  return makeStaff({ ...overrides, passwordHash: await hashPassword(password) });
}

/** 해당 교수자로 로그인한 것과 같은 Cookie 헤더 값. 다른 작업의 테스트에서도 쓴다. */
export function staffCookie(staffId: string): string {
  return `staff_token=${signStaffToken(staffId)}`;
}
