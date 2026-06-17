const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dj-details-db-'));
process.env.DJ_DETAILS_DB_PATH = path.join(tempDir, 'djs.test.db');

const database = require('../database');

function rawRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(process.env.DJ_DETAILS_DB_PATH);
    db.run(sql, params, function onRun(err) {
      db.close(closeErr => {
        if (err) return reject(err);
        if (closeErr) return reject(closeErr);
        resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  });
}

test.after(async () => {
  await database.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('pipeline run history persists final Magic queue counters', async () => {
  await database.schemaReady;

  const run = await database.createPipelineRun('a');
  const finishedAt = new Date().toISOString();

  const updated = await database.updatePipelineRun(run.id, {
    status: 'success',
    finishedAt,
    durationMs: 1234,
    djsFound: 10,
    newDjs: 2,
    profilesUpdated: 3,
    emailsFound: 4,
    emailsQueuedForMagic: 5
  });

  assert.equal(updated.status, 'success');
  assert.equal(updated.emailsQueuedForMagic, 5);

  const lastSuccessful = await database.getLastSuccessfulPipelineRun();
  assert.equal(lastSuccessful.id, run.id);
  assert.equal(lastSuccessful.emailsQueuedForMagic, 5);
});

test('Magic Emailer queueing skips unchanged synced DJ email data', async () => {
  await database.schemaReady;

  const djId = await database.insertDJ('Queue Smoke Test', 'https://example.com/djs/queue-smoke');
  await database.updateDJ(
    djId,
    JSON.stringify(['United Kingdom']),
    JSON.stringify(['https://instagram.com/queuesmoke']),
    JSON.stringify(['House']),
    JSON.stringify(['Agent@Example.com']),
    JSON.stringify({ 'agent@example.com': ['https://instagram.com/queuesmoke'] })
  );

  const firstQueue = await database.queueMagicEmailerSyncContacts();
  assert.equal(firstQueue.scannedDjs, 1);
  assert.equal(firstQueue.queued, 1);
  assert.equal(firstQueue.markedSyncedDjs, 1);

  await rawRun(
    "UPDATE magic_emailer_sync SET status = 'synced', synced_at = datetime('now'), updated_at = datetime('now') WHERE email = ?",
    ['agent@example.com']
  );

  const secondQueue = await database.queueMagicEmailerSyncContacts();
  assert.equal(secondQueue.scannedDjs, 0);
  assert.equal(secondQueue.queued, 0);
  assert.equal(secondQueue.updated, 0);
});

test('profile failure backoff excludes DJs until retry time passes', async () => {
  await database.schemaReady;

  const djId = await database.insertDJ('Backoff Smoke Test', 'https://example.com/djs/backoff-smoke');
  await database.recordDJProfileFailure(djId, 'captcha challenge');

  const djsToUpdate = await database.getDJsToUpdate();
  assert.equal(djsToUpdate.some(dj => dj.id === djId), false);
});
