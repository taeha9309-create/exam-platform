---
name: 작업 (Operator 작업 지시서)
about: 계획서의 작업 하나. 이 이슈 본문이 Operator에게 전달되는 작업 지시서다.
title: "[계획N-TaskM] 작업 이름"
labels: ["status:ready"]
---

## 작업 ID와 목표
- 작업 ID: `계획N-TaskM` (브랜치 `task/pN-tM`)
- 계획서: `docs/superpowers/plans/<파일>.md` — Task M
- 목표(한 문장):

## 참조 문서 (이것만 읽는다)
- SPEC: `docs/SPEC.md` §… (기능 F-…)
- ADR: ADR-…
- 의존 작업의 인터페이스: #이슈 (함수·타입 이름)

## 수정 허용 파일과 범위
- 생성:
- 수정:
- 테스트:

## 금지 사항
- 위 목록 밖 파일 수정 금지 (필요하면 NEEDS_CONTEXT로 보고)
- 보호 문서(`docs/PRD.md`, `docs/SPEC.md`, `docs/DECISIONS.md`, `CLAUDE.md`, `.claude/**`, `.github/workflows/**`) 변경 금지 — 편집 도구·셸·스크립트 모두
- `.env` 읽기·생성 금지, push·PR·병합·라벨 변경 금지
- (작업별 추가 금지 사항)

## 완료 조건
- [ ] (SPEC AC / 계획서 Step에서 옮김)

## 필수 테스트
```
(실행 명령)
```
기대 결과:

## 결과 보고 형식
`.claude/agents/operator.md`의 "보고 형식"을 따른다.

## 하네스 배정 (Coordinator 기입)
- 묶음: A/B/C/D/E · 병렬 가능 여부:
- Operator 모델: haiku / sonnet · Reviewer: sonnet / opus(critical)
- 선행 작업: #
