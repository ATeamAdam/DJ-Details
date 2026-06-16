#!/usr/bin/env node

const { scrapeAllDJs } = require('../scraper');
const { updateAllDJs } = require('../updateDJData');
const { processDJsForEmails } = require('../scrapeEmails');
const {
  getAllDJs,
  queueMagicEmailerSyncContacts,
  getMagicEmailerSyncStats
} = require('../database');

function createCliIo() {
  return {
    emit(event, payload) {
      if (payload === undefined || payload === null) {
        console.log(`[${event}]`);
        return;
      }

      if (typeof payload === 'string') {
        console.log(`[${event}] ${payload}`);
        return;
      }

      console.log(`[${event}] ${JSON.stringify(payload)}`);
    }
  };
}

function usage() {
  console.log(`
Usage:
  node scripts/dj-stage.js scrape-djs [startLetter]
  node scripts/dj-stage.js update-profiles
  node scripts/dj-stage.js scrape-emails
  node scripts/dj-stage.js queue-magic-sync
  node scripts/dj-stage.js all [startLetter]

Stages:
  scrape-djs        Scrape DJ names and profile URLs from 1001tracklists.
  update-profiles  Fetch profile metadata/social URLs for DJs that need refresh.
  scrape-emails    Search saved social/profile URLs for email addresses.
  queue-magic-sync Queue discovered emails for future Magic Emailer insertion.
  all              Run the stages above sequentially.
`);
}

async function scrapeEmailsStage(io) {
  const djs = await getAllDJs();
  await processDJsForEmails(djs, io);
}

async function queueMagicSyncStage(io) {
  const summary = await queueMagicEmailerSyncContacts();
  const stats = await getMagicEmailerSyncStats();
  io.emit('magicSyncQueue', {
    ...summary,
    stats
  });
}

async function run() {
  const stage = String(process.argv[2] || '').trim().toLowerCase();
  const startLetter = String(process.argv[3] || 'a').trim().toLowerCase();
  const io = createCliIo();

  if (!stage || stage === 'help' || stage === '--help' || stage === '-h') {
    usage();
    return;
  }

  if (stage === 'scrape-djs') {
    await scrapeAllDJs(startLetter, io);
    return;
  }

  if (stage === 'update-profiles') {
    await updateAllDJs(io);
    return;
  }

  if (stage === 'scrape-emails') {
    await scrapeEmailsStage(io);
    return;
  }

  if (stage === 'queue-magic-sync') {
    await queueMagicSyncStage(io);
    return;
  }

  if (stage === 'all') {
    await scrapeAllDJs(startLetter, io);
    await updateAllDJs(io);
    await scrapeEmailsStage(io);
    await queueMagicSyncStage(io);
    return;
  }

  console.error(`Unknown stage: ${stage}`);
  usage();
  process.exitCode = 1;
}

run().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
