-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('DRAFT', 'OPEN', 'RUNNING', 'ENDED');

-- CreateEnum
CREATE TYPE "PasteMode" AS ENUM ('RECORD', 'BLOCK');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('MCQ', 'ESSAY');

-- CreateEnum
CREATE TYPE "AttemptState" AS ENUM ('WAITING', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'SUBMITTED', 'TERMINATED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SubmitReason" AS ENUM ('STUDENT', 'TIMEOUT', 'EXAM_ENDED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('NONE', 'INFO', 'WARN', 'ALERT');

-- CreateEnum
CREATE TYPE "SignalSeverity" AS ENUM ('INFO', 'WARN', 'ALERT');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('LEAVE', 'LEAVE_START', 'FULLSCREEN_EXIT', 'PASTE', 'DROP', 'MULTI_MONITOR', 'DISCONNECT', 'RECONNECT', 'HEARTBEAT_GAP', 'SEQ_GAP');

-- CreateEnum
CREATE TYPE "ProctorActionType" AS ENUM ('APPROVE_ENTRY', 'REJECT_ENTRY', 'APPROVE_SESSION', 'REJECT_SESSION', 'WARN', 'PAUSE', 'RESUME', 'TERMINATE', 'ADD_TIME', 'ACK', 'AUTO_PAUSE');

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exam" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "examCode" VARCHAR(8) NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "durationMin" INTEGER NOT NULL,
    "status" "ExamStatus" NOT NULL DEFAULT 'DRAFT',
    "passcode" VARCHAR(6),
    "lockNewEntry" BOOLEAN NOT NULL DEFAULT false,
    "pasteMode" "PasteMode" NOT NULL DEFAULT 'RECORD',
    "shuffle" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "QuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "choices" JSONB,
    "correctChoiceId" TEXT,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterEntry" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "studentNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "RosterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "rosterEntryId" TEXT NOT NULL,
    "state" "AttemptState" NOT NULL DEFAULT 'WAITING',
    "sessionTokenHash" TEXT NOT NULL,
    "pendingTokenHash" TEXT,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentDeclined" BOOLEAN NOT NULL DEFAULT false,
    "envBrowser" TEXT,
    "envIsExtended" BOOLEAN,
    "envCheckedAt" TIMESTAMP(3),
    "questionOrder" JSONB NOT NULL,
    "choiceOrders" JSONB NOT NULL,
    "extraSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "lastHeartbeatAt" TIMESTAMP(3),
    "violationCount" INTEGER NOT NULL DEFAULT 0,
    "pausedAt" TIMESTAMP(3),
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "submitReason" "SubmitReason",
    "surveyDone" BOOLEAN NOT NULL DEFAULT false,
    "unackedSeverity" "Severity" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "choiceId" TEXT,
    "text" VARCHAR(5000),
    "rev" INTEGER NOT NULL DEFAULT 0,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "awardedPoints" INTEGER,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "severity" "SignalSeverity" NOT NULL,
    "seq" INTEGER,
    "clientAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,
    "questionId" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProctorAction" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "staffId" TEXT,
    "type" "ProctorActionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProctorAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "difficulty" INTEGER,
    "comment" VARCHAR(1000),

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Staff_email_key" ON "Staff"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Exam_examCode_key" ON "Exam"("examCode");

-- CreateIndex
CREATE UNIQUE INDEX "Question_examId_position_key" ON "Question"("examId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RosterEntry_examId_studentNo_key" ON "RosterEntry"("examId", "studentNo");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_rosterEntryId_key" ON "Attempt"("rosterEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_sessionTokenHash_key" ON "Attempt"("sessionTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_pendingTokenHash_key" ON "Attempt"("pendingTokenHash");

-- CreateIndex
CREATE INDEX "Attempt_examId_state_idx" ON "Attempt"("examId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_attemptId_questionId_key" ON "Answer"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "Signal_attemptId_receivedAt_idx" ON "Signal"("attemptId", "receivedAt");

-- CreateIndex
CREATE INDEX "ProctorAction_attemptId_createdAt_idx" ON "ProctorAction"("attemptId", "createdAt");

-- AddForeignKey
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterEntry" ADD CONSTRAINT "RosterEntry_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_rosterEntryId_fkey" FOREIGN KEY ("rosterEntryId") REFERENCES "RosterEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctorAction" ADD CONSTRAINT "ProctorAction_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProctorAction" ADD CONSTRAINT "ProctorAction_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── 값 제약(CHECK): Prisma 스키마로 표현할 수 없어 직접 건다 (SPEC 4장, F-02, F-03, F-18) ──
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_durationMin_range" CHECK ("durationMin" BETWEEN 1 AND 300);
ALTER TABLE "Question" ADD CONSTRAINT "Question_points_min" CHECK ("points" >= 1);
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_difficulty_range" CHECK ("difficulty" IS NULL OR "difficulty" BETWEEN 1 AND 5);
