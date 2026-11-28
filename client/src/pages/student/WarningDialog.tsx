import { t } from '../../copy/ko';
import { Dialog } from '../staff/staffUi';

/** 감독관 경고(F-16). [확인]을 눌러야만 닫힌다: Esc로는 닫히지 않는다. 메시지는 텍스트로만 그린다. */
export function WarningDialog({ message, onConfirm }: { message: string; onConfirm: () => void }) {
  return (
    <Dialog title={t.student.taking.warningTitle} onClose={() => undefined}>
      <p>{message}</p>
      <button type="button" autoFocus onClick={onConfirm}>
        {t.student.taking.warningConfirm}
      </button>
    </Dialog>
  );
}
