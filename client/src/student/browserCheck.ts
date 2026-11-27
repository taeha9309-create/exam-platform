export type SupportedBrowser = 'chrome' | 'edge' | 'unsupported';

/**
 * `navigator.userAgentData.brands`로 브라우저를 판별한다(SPEC F-09).
 * Chrome·Edge만 통과한다. userAgentData가 없는 Firefox·Safari와 Whale 같은 다른 Chromium 계열은 unsupported.
 * Edge는 brands에 "Chromium"도 함께 있으므로 Edge를 먼저 본다.
 */
export function detectBrowser(brands: readonly { brand: string }[] | undefined): SupportedBrowser {
  if (!brands) return 'unsupported';
  const names = brands.map((b) => b.brand);
  if (names.includes('Microsoft Edge')) return 'edge';
  if (names.includes('Google Chrome')) return 'chrome';
  return 'unsupported';
}
