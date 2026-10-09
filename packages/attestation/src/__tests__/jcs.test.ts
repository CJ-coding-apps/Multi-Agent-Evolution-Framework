import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jcs } from '../jcs.js';

// ORACLE: D-36 + verifier F1 — the attestation's signed bytes are RFC 8785 exactly, so a third
// party with any JCS library reproduces them. Expected strings are written by hand from the RFC
// (§3.2.3, §3.2.4, Appendix B), never produced by the code under test.

test('array-index keys sort as strings, as RFC 8785 does, not first in numeric order as JS lists them', () => {
  assert.equal(jcs({ '10': 1, '2': 2, a: 3 }), '{"10":1,"2":2,"a":3}');
  assert.equal(jcs({ '!': 1, '1': 2 }), '{"!":1,"1":2}');
  assert.equal(jcs({ '2': 'x', '10': 'y', '!': 'z', '1': 'w' }), '{"!":"z","1":"w","10":"y","2":"x"}');
  assert.equal(jcs({ n: { '2': [{ '10': true, '9': false }] } }), '{"n":{"2":[{"10":true,"9":false}]}}', 'at every depth');
});

test('RFC 8785 §3.2.3: properties sort by UTF-16 code unit, so an astral character sorts before U+FB33', () => {
  // JSON text with its escapes intact (doubled backslashes: not String.raw, whose \u escapes tsc rewrites).
  const input = JSON.parse(
    '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One",' +
    '"\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
  ) as unknown;
  assert.equal(jcs(input),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
    '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}');
});

test('RFC 8785 §3.2.4: the worked example', () => {
  const input = JSON.parse(
    '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
    '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
  ) as unknown;
  assert.equal(jcs(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
});

test('RFC 8785 Appendix B: numbers as ECMAScript writes them', () => {
  const fromBits = (hex: string): number => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${hex}`));
    return view.getFloat64(0);
  };
  const vectors: Array<[string, string]> = [
    ['0000000000000000', '0'], ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'], ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'], ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'], ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'], ['44b52d02c7e14af6', '1e+23'], ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'], ['444b1ae4d6e2ef4f', '999999999999999900000'], ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'], ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'], ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'], ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'], ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  for (const [bits, expected] of vectors) assert.equal(jcs(fromBits(bits)), expected, bits);
  assert.equal(jcs(-0), '0');
  assert.equal(jcs(1e21), '1e+21');
  assert.equal(jcs(1e-7), '1e-7');
  assert.equal(jcs(JSON.parse('9007199254740993')), '9007199254740992', '2^53+1 is the double JSON.parse makes of it');
});

test('strings: §3.2.2.2 escapes, everything else as is', () => {
  assert.equal(jcs('\u0000\b\t\n\u000b\f\r\u001f"\\'), '"\\u0000\\b\\t\\n\\u000b\\f\\r\\u001f\\"\\\\"');
  assert.equal(jcs('/ \u007f \u0080     é 😀'), '"/ \u007f \u0080     é 😀"', 'no escape for /, DEL, C1, U+2028/9');
  // Outside RFC 8785 (not Unicode): written as JSON.stringify writes it, so it neither throws nor collides.
  assert.equal(jcs('a\ud800b'), '"a\\ud800b"');
  assert.equal(jcs('\udc00\ud83d'), '"\\udc00\\ud83d"','a low surrogate before a high one is two lone ones');
  for (let unit = 0; unit <= 0xffff; unit++) {
    const s = String.fromCharCode(unit);
    if (jcs(s) !== JSON.stringify(s)) assert.fail(`U+${unit.toString(16)}: ${jcs(s)} vs ${JSON.stringify(s)}`);
  }
});

test('case-only keys, empty containers, literals and a "__proto__" key', () => {
  assert.equal(jcs({ b: 1, B: 2, a: 3, A: 4 }), '{"A":4,"B":2,"a":3,"b":1}');
  assert.equal(jcs({ z: {}, y: [], x: [{}, [], [[]], { w: {} }] }), '{"x":[{},[],[[]],{"w":{}}],"y":[],"z":{}}');
  assert.equal(jcs([null, true, false, 0, '']), '[null,true,false,0,""]');
  assert.equal(jcs(JSON.parse('{"b":2,"__proto__":{"a":1}}')), '{"__proto__":{"a":1},"b":2}', 'JSON.parse makes it an own key');
});

test('what RFC 8785 has no form for throws, with a sentence', () => {
  assert.throws(() => jcs(Number.NaN), /no form for the number NaN; expected a finite number/);
  assert.throws(() => jcs({ a: [Number.POSITIVE_INFINITY] }), /no form for the number Infinity/);
  assert.throws(() => jcs({ a: undefined }), /expected a JSON value, found undefined/);
  assert.throws(() => jcs(new Date(0)), /expected a plain object, found a Date/);
  assert.throws(() => jcs(1n), /found bigint/);
  assert.throws(() => jcs([1, , 3]), /found undefined/, 'an array hole is not JSON');
});
