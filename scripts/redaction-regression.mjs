import assert from 'node:assert/strict';
import { hasSecretValue, redactSensitiveText } from '../dist/redact.js';

for (const name of ['input_tokens_reserved', 'output_tokens_reserved']) {
  for (const addition of ['+%s', ' + %s', '+$1', '+123']) {
    const sql = 'UPDATE ai_run_budgets SET ' + name + '=' + name + addition + ', updated_at=now()';
    assert.equal(hasSecretValue(sql), false, 'SQL counter was misread as a credential');
    assert.equal(redactSensitiveText(sql), sql, 'SQL counter was falsely redacted');
  }
}
const sample = 'SyntheticCredentialValue0123456789';
const assigned = 'input_tokens_reserved' + '=' + sample;
const quoted = 'input_tokens_reserved' + '="' + sample + '"';
const other = 'api_key' + '=' + sample;
const embedded = 'input_tokens_reserved' + '=' + 'input_tokens_reserved' + '+' + sample;
const bearer = 'Authorization: Bearer ' + 'SyntheticBearerValue0123456789';
const provider = 'codexpro_token' + '=' + sample;
for (const suspicious of [assigned, quoted, other, embedded, bearer, provider]) {
  assert.equal(hasSecretValue(suspicious), true, 'secret guard incorrectly admitted suspicious data');
  const redacted = redactSensitiveText(suspicious);
  assert.equal(redacted.includes(sample), false, 'synthetic test credential not redacted');
  assert.equal(redacted.includes('SyntheticBearerValue0123456789'), false, 'synthetic bearer not redacted');
}
const counter = 'input_tokens_reserved';
const combined = 'UPDATE budgets SET ' + counter + '=' + counter + '+%s, ' + other;
assert.equal(hasSecretValue(combined), true);
assert.equal(redactSensitiveText(combined).includes(sample), false);
assert.equal(redactSensitiveText(combined).includes(counter + '=' + counter + '+%s'), true);
console.log('secret filter regression: counter increments allowed, credential guard retained');
