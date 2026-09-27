import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiCredentialsError, readAiCredentials } from '../ai-credentials.js';

function credentialFile(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-ai-credentials-'));
  const path = join(dir, 'credentials.json');
  writeFileSync(path, content);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

test('usa variables de entorno solo cuando no hay archivo configurado', () => {
  const snapshot = readAiCredentials({ OPENAI_API_KEY: ' env-key ', UNKNOWN: 'ignored' });
  assert.deepEqual(snapshot.credentials, { OPENAI_API_KEY: 'env-key' });
});

test('el archivo es autoritativo y permite rotación y revocación', t => {
  const path = credentialFile(t, '{"OPENAI_API_KEY":"first"}');
  const env = { AI_CREDENTIALS_FILE: path, OPENAI_API_KEY: 'ignored' };
  const first = readAiCredentials(env);
  writeFileSync(path, '{"OPENAI_API_KEY":"second"}');
  const second = readAiCredentials(env);
  writeFileSync(path, '{}');
  const revoked = readAiCredentials(env);

  assert.equal(first.credentials.OPENAI_API_KEY, 'first');
  assert.equal(second.credentials.OPENAI_API_KEY, 'second');
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(revoked.credentials, {});
  assert.notEqual(second.revision, revoked.revision);
});

test('falla cerrado y sanitiza todos los errores del archivo', t => {
  const secret = 'do-not-expose';
  const cases = [
    ['missing.json', null],
    ['invalid.json', `{${secret}`],
    ['unknown.json', `{"UNKNOWN":"${secret}"}`],
    ['type.json', '{"OPENAI_API_KEY":42}'],
    ['large.json', `{"OPENAI_API_KEY":"${'x'.repeat(17 * 1024)}"}`]
  ];
  const dir = mkdtempSync(join(tmpdir(), 'vocab-ai-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of cases) {
    const path = join(dir, name);
    if (content !== null) writeFileSync(path, content);
    assert.throws(() => readAiCredentials({ AI_CREDENTIALS_FILE: path }), error => {
      assert.ok(error instanceof AiCredentialsError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'AI_CREDENTIALS_UNAVAILABLE');
      assert.doesNotMatch(error.message, new RegExp(`${secret}|${name.replace('.', '\\.')}|${dir.replaceAll('\\', '\\\\')}`));
      return true;
    });
  }
});
