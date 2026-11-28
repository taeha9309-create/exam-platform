import { EV } from '@exam/shared';
import type { Attempt, Exam } from '@prisma/client';
import type { Server } from 'socket.io';
import { prisma } from '../db';
import { loadAttemptSummaries } from '../services/dashboard';

// 방 이름은 서버만 만든다(클라이언트가 방 이름을 지정할 수 없다).
export const attemptRoom = (attemptId: string) => `attempt:${attemptId}`;
export const studentsRoom = (examId: string) => `exam:${examId}:students`;
export const staffRoom = (examId: string) => `exam:${examId}:staff`;

let io: Server | null = null;

/** attachSocket이 만든 Server를 싱글턴으로 등록한다. */
export function setIo(server: Server): void {
  io = server;
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.IO가 아직 초기화되지 않았습니다.');
  return io;
}

/** 학생별 마감 = exam.endsAt + attempt.extraSeconds (SPEC 2.2). 시작 전이면 null. */
export function attemptDeadline(attempt: Pick<Attempt, 'extraSeconds'>, exam: Pick<Exam, 'endsAt'>): number | null {
  return exam.endsAt ? exam.endsAt.getTime() + attempt.extraSeconds * 1000 : null;
}

/**
 * 학생에게 보내는 응시 상태. locked는 선택 필드다: 값을 아는 호출자만 넣고(자동 잠금이면 true), 모르면 생략한다.
 * 생략하면 기존 클라이언트 동작과 같다(필드가 없던 때와 동일).
 */
export function attemptStatePayload(attempt: Attempt, exam: Pick<Exam, 'endsAt'>, locked?: boolean) {
  return {
    ...(locked === undefined ? {} : { locked }),
    state: attempt.state,
    deadline: attemptDeadline(attempt, exam),
    serverNow: Date.now(),
    extraSeconds: attempt.extraSeconds,
    violationCount: attempt.violationCount,
  };
}

export const broadcast = {
  /** 그 응시의 소켓(들)에 현재 상태를 보낸다. */
  attemptState(attempt: Attempt, exam: Exam, locked?: boolean): void {
    getIo().to(attemptRoom(attempt.id)).emit(EV.ATTEMPT_STATE, attemptStatePayload(attempt, exam, locked));
  },

  /** 대기실 인원: ready = 준비 완료(WAITING이고 동의+환경 점검 완료) 응시 수(SPEC F-10), total = 명단 인원. 학생 방과 교수자 방 모두에 보낸다. */
  async waitingCount(examId: string): Promise<void> {
    const [ready, total] = await Promise.all([
      prisma.attempt.count({ where: { examId, state: 'WAITING', consentAt: { not: null }, envCheckedAt: { not: null } } }),
      prisma.rosterEntry.count({ where: { examId } }),
    ]);
    getIo().to(studentsRoom(examId)).to(staffRoom(examId)).emit(EV.WAITING_COUNT, { ready, total });
  },

  examStarted(exam: Exam): void {
    getIo().to(studentsRoom(exam.id)).emit(EV.EXAM_STARTED, { endsAt: exam.endsAt?.getTime() ?? null, serverNow: Date.now() });
  },

  /** 세션 무효화: session:revoked를 보낸 뒤 그 응시의 소켓을 모두 끊는다(이벤트가 먼저 전달된다). */
  revokeSession(attemptId: string): void {
    const room = getIo().in(attemptRoom(attemptId));
    room.emit(EV.SESSION_REVOKED, {});
    room.disconnectSockets(true);
  },

  /** 기존 이름 호환용. revokeSession과 같다. */
  sessionRevoked(attemptId: string): void {
    broadcast.revokeSession(attemptId);
  },

  /**
   * 응시 하나의 요약을 교수자 방에만 보낸다(attempt:updated). 응시가 없으면 무시하고, 실패해도 호출자에게 던지지 않고 로그만 남긴다.
   * 커밋이 끝난 뒤에만 호출한다(트랜잭션 안에서 부르지 않는다).
   */
  async attemptUpdated(attemptId: string): Promise<void> {
    try {
      getIo();
      const found = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { examId: true } });
      if (!found) return;
      await broadcast.attemptsUpdated(found.examId, [attemptId]);
    } catch (err) {
      console.error('attempt:updated 전송 실패', err instanceof Error ? err.message : 'unknown');
    }
  },

  /** 같은 시험의 여러 응시를 한꺼번에 알린다(시험 시작·종료). 쿼리는 응시 수와 무관하게 상수 개이고 이벤트만 응시마다 1건이다. */
  async attemptsUpdated(examId: string, attemptIds: string[]): Promise<void> {
    try {
      getIo();
      for (const summary of await loadAttemptSummaries(examId, attemptIds)) getIo().to(staffRoom(examId)).emit(EV.ATTEMPT_UPDATED, summary);
    } catch (err) {
      console.error('attempt:updated 전송 실패', err instanceof Error ? err.message : 'unknown');
    }
  },

  toStaff(examId: string, event: string, payload: unknown): void {
    getIo().to(staffRoom(examId)).emit(event, payload);
  },
};
