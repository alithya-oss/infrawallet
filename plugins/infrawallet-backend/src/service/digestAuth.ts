import { createHash, randomBytes } from 'crypto';

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

interface DigestCredentials {
  username: string;
  password: string;
}

/**
 * Parse the WWW-Authenticate header from a 401 response into its components.
 */
function parseDigestChallenge(header: string): DigestChallenge {
  const challenge: Partial<DigestChallenge> = {};

  const regex = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g; // NOSONAR - uses possessive-like character classes ([^"]+ and [^\s,]+) that can't cause catastrophic backtracking
  let match: RegExpExecArray | null = regex.exec(header);

  while (match !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3];

    switch (key) {
      case 'realm':
        challenge.realm = value;
        break;
      case 'nonce':
        challenge.nonce = value;
        break;
      case 'qop':
        challenge.qop = value;
        break;
      case 'opaque':
        challenge.opaque = value;
        break;
      case 'algorithm':
        challenge.algorithm = value;
        break;
      default:
        break;
    }

    match = regex.exec(header);
  }

  if (!challenge.realm || !challenge.nonce) {
    throw new Error(`Invalid Digest challenge header: ${header}`);
  }

  return challenge as DigestChallenge;
}

/**
 * MD5 hash function required by HTTP Digest Authentication (RFC 2617).
 * The digest auth protocol mandates MD5 — this cannot be replaced with a stronger algorithm
 * as the server dictates the hash function used in the challenge-response exchange.
 */
function md5(input: string): string {
  return createHash('md5').update(input).digest('hex'); // NOSONAR - MD5 is mandated by RFC 2617 Digest Auth
}

function generateCnonce(): string {
  return randomBytes(16).toString('hex').substring(0, 16);
}

let nonceCount = 0;

/**
 * Build the Authorization header value for HTTP Digest Authentication.
 */
function buildDigestHeader(
  credentials: DigestCredentials,
  challenge: DigestChallenge,
  method: string,
  uri: string,
): string {
  const { username, password } = credentials;
  const { realm, nonce, qop, opaque, algorithm } = challenge;

  const algo = (algorithm || 'MD5').toUpperCase();
  if (algo !== 'MD5' && algo !== 'MD5-SESS') {
    throw new Error(`Unsupported digest algorithm: ${algo}`);
  }

  let ha1 = md5(`${username}:${realm}:${password}`);
  if (algo === 'MD5-SESS') {
    const cnonce = generateCnonce();
    ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  }

  const ha2 = md5(`${method}:${uri}`);

  let response: string;
  const parts: string[] = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`];

  if (qop) {
    nonceCount++;
    const nc = nonceCount.toString(16).padStart(8, '0');
    const cnonce = generateCnonce();
    const qopValue = qop.split(',')[0].trim();
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qopValue}:${ha2}`);
    parts.push(`qop=${qopValue}`, `nc=${nc}`, `cnonce="${cnonce}"`, `response="${response}"`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
    parts.push(`response="${response}"`);
  }

  if (opaque) {
    parts.push(`opaque="${opaque}"`);
  }

  if (algorithm) {
    parts.push(`algorithm=${algorithm}`);
  }

  return `Digest ${parts.join(', ')}`;
}

export interface DigestFetchOptions {
  method?: string;
  headers?: Record<string, string>;
}

export interface DigestFetchResponse {
  status: number;
  statusText: string;
  data: any;
}

/**
 * Perform an HTTP request with Digest Authentication.
 *
 * Flow:
 * 1. Send the request without auth
 * 2. Receive a 401 with WWW-Authenticate challenge
 * 3. Compute the digest response and retry with Authorization header
 */
export async function digestFetch(
  url: string,
  credentials: DigestCredentials,
  options: DigestFetchOptions = {},
): Promise<DigestFetchResponse> {
  const method = options.method || 'GET';
  const headers = options.headers || {};

  // Step 1: Initial request to get the challenge
  const initialResponse = await fetch(url, { method, headers });

  if (initialResponse.status !== 401) {
    const contentType = initialResponse.headers.get('content-type') || '';
    let data: any;
    if (contentType.includes('application/json')) {
      data = await initialResponse.json();
    } else {
      data = await initialResponse.text();
    }
    return { status: initialResponse.status, statusText: initialResponse.statusText, data };
  }

  // Step 2: Parse the WWW-Authenticate challenge
  const wwwAuthenticate = initialResponse.headers.get('www-authenticate');
  if (!wwwAuthenticate || !wwwAuthenticate.toLowerCase().startsWith('digest')) {
    throw new Error(`Server did not return a Digest authentication challenge. Got: ${wwwAuthenticate}`);
  }

  const challenge = parseDigestChallenge(wwwAuthenticate);

  // Step 3: Build the digest auth header and retry
  const uri = new URL(url).pathname + new URL(url).search;
  const authHeader = buildDigestHeader(credentials, challenge, method, uri);

  const authedResponse = await fetch(url, {
    method,
    headers: { ...headers, Authorization: authHeader },
  });

  const contentType = authedResponse.headers.get('content-type') || '';
  let data: any;
  if (contentType.includes('application/json')) {
    data = await authedResponse.json();
  } else {
    data = await authedResponse.text();
  }

  return { status: authedResponse.status, statusText: authedResponse.statusText, data };
}
