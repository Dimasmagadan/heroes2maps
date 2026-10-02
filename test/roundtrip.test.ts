import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { decodeMap, encodeBody, encodeMap, inflateBody } from '../src/fh2m/codec.ts';

const dir = new URL('../fixtures/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.fh2m'));

describe('fh2m codec', () => {
  it('has fixtures', () => {
    assert.ok(files.length > 0);
  });

  for (const file of files) {
    describe(file, () => {
      const bytes = new Uint8Array(readFileSync(new URL(file, dir)));
      const map = decodeMap(bytes);

      it('decodes a square tile grid', () => {
        assert.equal(map.tiles.length, map.width * map.width);
      });

      it('re-encodes the body identically to the original', () => {
        assert.deepEqual(encodeBody(map), inflateBody(bytes));
      });

      it('survives a full encode/decode cycle', () => {
        assert.deepEqual(decodeMap(encodeMap(map)), map);
      });
    });
  }
});
