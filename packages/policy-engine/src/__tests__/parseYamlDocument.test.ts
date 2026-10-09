import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlDocument, YamlSyntaxError } from '../PolicyLoader.js';

// ORACLE: WP-2.5 / D-08 — `.maf/config.yaml` and `roles.yaml` load through the parser policy
// files use, and a refusal names the line. These pin the shared wrapper both loaders call.

/** `assert.throws` for a YamlSyntaxError, returning it so the caller can check its position. */
function syntaxError(text: string): YamlSyntaxError {
  let caught: unknown;
  assert.throws(() => parseYamlDocument(text, '/p/x.yaml'), (err: unknown) => {
    caught = err;
    return err instanceof YamlSyntaxError;
  });
  assert.ok(caught instanceof YamlSyntaxError);
  return caught;
}

test('parses block YAML and JSON-with-comment-lines to the same value', () => {
  const block = parseYamlDocument('# settings\na: 1\nb:\n  - x\n  - y\n', '/p/x.yaml');
  const json  = parseYamlDocument('# settings\n{\n  "a": 1,\n  # inside\n  "b": ["x", "y"]\n}\n', '/p/x.yaml');
  assert.deepEqual(block.value, { a: 1, b: ['x', 'y'] });
  assert.deepEqual(json.value, block.value);
});

test('an empty or comment-only document is null, not an error', () => {
  assert.equal(parseYamlDocument('', '/p/x.yaml').value, null);
  assert.equal(parseYamlDocument('# nothing here\n', '/p/x.yaml').value, null);
});

test('lineOf gives the line of a key, a nested key and a list item', () => {
  const doc = parseYamlDocument(['top: 1', 'dag:', '  retry:', '    maxAttempts: 3', 'list:', '  - a', '  - b'].join('\n'), '/p');
  assert.equal(doc.lineOf(['top']), 1);
  assert.equal(doc.lineOf(['dag']), 2);
  assert.equal(doc.lineOf(['dag', 'retry', 'maxAttempts']), 4);
  assert.equal(doc.lineOf(['list', 1]), 7);
});

test('lineOf falls back to the nearest entry that exists', () => {
  const doc = parseYamlDocument('a: 1\ndag:\n  x: 2\n', '/p');
  // A field that is not there is reported at its parent, which is where it would go.
  assert.equal(doc.lineOf(['dag', 'missing']), 2);
  assert.equal(parseYamlDocument('', '/p').lineOf(['a']), undefined);
});

test('a syntax error names the source, line and column', () => {
  const err = syntaxError('a: 1\nb: [\n');
  assert.equal(err.sourcePath, '/p/x.yaml');
  assert.equal(err.line, 3);
  assert.equal(err.column, 1);
  assert.match(err.message, /"\/p\/x\.yaml" is not valid YAML at line 3, column 1: /);
  assert.ok(err.reason.length > 0);
});

test('a key repeated in one mapping is an error, not "the last one wins"', () => {
  const err = syntaxError('a: 1\nb: 2\na: 3\n');
  assert.equal(err.line, 3);
  assert.match(err.reason, /unique/i);
});

test('a second document is refused rather than ignored', () => {
  const err = syntaxError('a: 1\n---\nb: 2\n');
  assert.equal(err.line, 2);
});

test('a tag YAML cannot resolve is refused rather than read as a string', () => {
  const err = syntaxError('a: 1\nb: !custom value\n');
  assert.equal(err.line, 2);
});

test('an alias bomb is refused, not expanded', () => {
  let text = 'a: &a [x, x, x, x, x, x, x, x, x, x]\n';
  let prev = 'a';
  for (let i = 0; i < 8; i++) {
    text += `n${i}: &n${i} [${Array(10).fill(`*${prev}`).join(', ')}]\n`;
    prev = `n${i}`;
  }
  const err = syntaxError(text);
  assert.match(err.reason, /alias/i);
});

test('a "__proto__" key is an own key of the value, never its prototype', () => {
  const { value } = parseYamlDocument('__proto__:\n  polluted: true\nb: 1\n', '/p');
  assert.ok(typeof value === 'object' && value !== null);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.ok(Object.keys(value).includes('__proto__'), 'a loader sees the key, so it can refuse it');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('a "<<" merge key is refused at any depth, naming the line, rather than loaded as an ordinary key', () => {
  // YAML 1.2 has no merge keys: this used to load as a role with a literal "<<" field and no
  // `execution`, so the role ran on the cli tier and nothing said so (verifier finding F2).
  const probe = ['b: &b {execution: in-process}', 'roles:', '  - <<: *b', '    role: x', ''].join('\n');
  const err = syntaxError(probe);
  assert.equal(err.line, 3);
  assert.equal(err.column, 5);
  assert.match(err.reason, /"<<"/);
  assert.match(err.reason, /merge/);
  assert.match(err.message, /"\/p\/x\.yaml" is not valid YAML at line 3, column 5: /);

  // A YAML 1.1 document would perform the merge; it is refused all the same, so one rule holds.
  assert.equal(syntaxError(`%YAML 1.1\n---\n${probe}`).line, 5);
  // Quoted, as JSON writes it; deep inside a flow mapping; and through an alias used as a key.
  assert.equal(syntaxError('{\n  "a": { "b": { "<<": { "x": 1 } } }\n}\n').line, 2);
  assert.equal(syntaxError('k: &k "<<"\nm:\n  *k : 1\n').line, 3);
  // "<<" as a value, or inside a longer key, is not a merge key.
  assert.deepEqual(parseYamlDocument('a: "<<"\n"<<b": 1\n', '/p').value, { a: '<<', '<<b': 1 });
});
