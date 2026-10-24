import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import RarityMap from 'webtorrent/lib/rarity-map.js';

function fixture(t, pieceCount = 4) {
  const torrent = new EventEmitter();
  const peerPieces = new Set();
  const wire = new EventEmitter();
  wire.peerPieces = { get: (index) => peerPieces.has(index) };
  torrent.pieces = new Array(pieceCount);
  torrent.wires = [wire];
  const rarity = new RarityMap(torrent);
  t.after(() => rarity.destroy());
  return { rarity, wire, peerPieces };
}

test('valid HAVE indices preserve piece availability through recalculation', (t) => {
  const { rarity, wire, peerPieces } = fixture(t);
  for (const index of [0, 3]) {
    peerPieces.add(index);
    wire.emit('have', index);
  }
  assert.deepEqual(rarity._pieces, [1, 0, 0, 1]);
  wire.emit('bitfield');
  assert.deepEqual(rarity._pieces, [1, 0, 0, 1]);
  wire.emit('close');
  assert.deepEqual(rarity._pieces, [0, 0, 0, 0]);
});

test('invalid HAVE indices cannot grow or add properties to the rarity array', (t) => {
  const { rarity, wire } = fixture(t);
  const keys = Reflect.ownKeys(rarity._pieces);
  const invalidIndices = [
    4, 5, 100_000_000, 0xffff_fffe, 0xffff_ffff,
    -1, 1.5, NaN, Infinity, -Infinity, '0', null, undefined,
  ];
  for (const index of invalidIndices) {
    wire.emit('have', index);
    // Check length before recalculating so a missing patch cannot cause OOM in the test.
    assert.equal(rarity._pieces.length, 4, `invalid index: ${String(index)}`);
    assert.deepEqual(Reflect.ownKeys(rarity._pieces), keys);
    assert.deepEqual(rarity._pieces, [0, 0, 0, 0]);
  }
  wire.emit('bitfield');
  assert.deepEqual(rarity._pieces, [0, 0, 0, 0]);
});

test('an empty torrent rejects every piece index', (t) => {
  const { rarity, wire } = fixture(t, 0);
  wire.emit('have', 0);
  assert.equal(rarity._pieces.length, 0);
  wire.emit('bitfield');
  assert.deepEqual(rarity._pieces, []);
});
