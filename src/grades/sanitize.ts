/**
 * Texto livre vindo do CSV é entrada não confiável: remove caracteres de controle,
 * colapsa espaços e tira `<`/`>` (que quebrariam delimitadores de prompt/HTML).
 */
export function sanitizeText(input: string, maxLength = 100): string {
  return input
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 5511999990000 -> 55*******0000 (sem expor o número inteiro em logs). */
export function maskPhone(phone: string): string {
  return phone.length <= 6 ? '***' : `${phone.slice(0, 2)}${'*'.repeat(phone.length - 6)}${phone.slice(-4)}`;
}
