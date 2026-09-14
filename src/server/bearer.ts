/**
 * The token in an `Authorization: Bearer …` header, or undefined when the header is
 * absent or carries another scheme. The scheme is case-insensitive (RFC 7235); proxies
 * and clients spell it as they like.
 */
export function bearerToken(header: string | undefined): string | undefined {
  return /^bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
}
