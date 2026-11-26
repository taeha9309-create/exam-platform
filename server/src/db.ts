import { PrismaClient } from '@prisma/client';

// 연결 문자열은 환경변수 DATABASE_URL에서 읽는다(.env.example 참고). 테스트에서는 _test 데이터베이스를 가리킨다.
export const prisma = new PrismaClient();
