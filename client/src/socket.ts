import { io, type Socket } from 'socket.io-client';

/** 학생 소켓: 세션 토큰을 handshake auth로 보낸다(ADR-005). 자동 재연결은 기본값. */
export function connectStudentSocket(token: string): Socket {
  return io({ auth: { token } });
}

/** 교수자 소켓: 같은 출처 쿠키(staff_token)로 인증한다. */
export function connectStaffSocket(): Socket {
  return io({ withCredentials: true });
}
