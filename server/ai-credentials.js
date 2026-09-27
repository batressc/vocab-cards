import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export const AI_CREDENTIAL_NAMES = Object.freeze([
  'OPENCODE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AI_API_KEY'
]);

const ALLOWED = new Set(AI_CREDENTIAL_NAMES);
const MAX_CREDENTIALS_BYTES = 16 * 1024;
const SAFE_ERROR = 'No se pudieron cargar las credenciales de IA. Revisa el archivo configurado y sus permisos.';
let previousFingerprint = '';
let revision = 0;

export class AiCredentialsError extends Error {
  constructor() {
    super(SAFE_ERROR);
    this.name = 'AiCredentialsError';
    this.code = 'AI_CREDENTIALS_UNAVAILABLE';
    this.status = 503;
  }
}

function nextRevision(credentials) {
  const canonical = AI_CREDENTIAL_NAMES.map(name => [name, credentials[name] ?? '']);
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
  if (fingerprint !== previousFingerprint) {
    previousFingerprint = fingerprint;
    revision++;
  }
  return revision;
}

function validate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AiCredentialsError();
  const credentials = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!ALLOWED.has(name) || typeof value !== 'string') throw new AiCredentialsError();
    credentials[name] = value.trim();
  }
  return Object.freeze(credentials);
}

function readCredentialsFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_CREDENTIALS_BYTES) throw new AiCredentialsError();
    const content = readFileSync(fd);
    if (content.length > MAX_CREDENTIALS_BYTES) throw new AiCredentialsError();
    return validate(JSON.parse(content.toString('utf8')));
  } catch (error) {
    if (error instanceof AiCredentialsError) throw error;
    throw new AiCredentialsError();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

/** Lee un snapshot coherente. El archivo, cuando se configura, es autoritativo. */
export function readAiCredentials(env = process.env) {
  const credentials = env.AI_CREDENTIALS_FILE
    ? readCredentialsFile(env.AI_CREDENTIALS_FILE)
    : validate(Object.fromEntries(AI_CREDENTIAL_NAMES.flatMap(name => env[name] === undefined ? [] : [[name, env[name]]])));
  return Object.freeze({ credentials, revision: nextRevision(credentials) });
}
