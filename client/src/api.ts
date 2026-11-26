// REST 호출 래퍼. 학생은 Bearer 토큰(ADR-005), 교수자는 쿠키(같은 출처)로 인증한다.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // 프록시 오류 등 JSON이 아닌 본문
  }
}

export async function api<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts?: { token?: string },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }

  const data = await readJson(res);
  if (!res.ok) {
    const err = (data as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
    const message = typeof err?.message === 'string' ? err.message : undefined;
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}
