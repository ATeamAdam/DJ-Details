const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { scrapeAllDJs, setShouldStopScraper, setScraperQuietMode } = require('./scraper');
const { updateAllDJs, setShouldStopUpdater, setUpdaterQuietMode } = require('./updateDJData');
const { startEmailScraping, setShouldStopScraping } = require('./scrapeEmails');
const {
  getDJsWithEmailsCount,
  getAllDJs,
  getDJsForEmailSearch,
  getDJCount,
  getSearchableDJCount,
  createPipelineRun,
  updatePipelineRun,
  getLastSuccessfulPipelineRun,
  queueMagicEmailerSyncContacts
} = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

let scraperRunning = false;
let updaterRunning = false;
let emailScrapingRunning = false;
let emailScrapingProcess = null;
let scraperProcess = null;
let updaterProcess = null;
let scraperStopRequested = false;
let updaterStopRequested = false;
let emailScrapingStopRequested = false;

const PIPELINE_LOG_LIMIT = 300;
const pipelineAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const schedulerDayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const schedulerEnabled = String(process.env.PIPELINE_SCHEDULER_ENABLED || '1').toLowerCase() !== '0';
const schedulerDay = String(process.env.PIPELINE_SCHEDULER_DAY || 'tuesday').toLowerCase();
const schedulerTime = String(process.env.PIPELINE_SCHEDULER_TIME || '02:00');
const schedulerStartLetter = String(process.env.PIPELINE_SCHEDULER_START_LETTER || 'resume').toLowerCase();
const pipelineStageOrder = {
  idle: 0,
  scraper: 0,
  updater: 1,
  emails: 2,
  complete: 3
};
const pipelineUnitsPerStage = pipelineAlphabet.length;
const pipelineTotalUnits = pipelineUnitsPerStage * 3;
let schedulerTimer = null;
let schedulerNextRunAt = null;
let schedulerLastRunAt = null;
let schedulerLastStatus = schedulerEnabled ? 'scheduled' : 'disabled';
let pipelineQuietMode = false;

let pipelineState = {
  runId: null,
  running: false,
  stage: 'idle',
  progress: 0,
  label: 'Idle',
  startLetter: 'a',
  startedAt: null,
  endedAt: null,
  lastRunDurationMs: null,
  lastSuccessfulRun: null,
  runStats: {
    djsFound: 0,
    newDjs: 0,
    profilesUpdated: 0,
    emailsFound: 0,
    emailsQueuedForMagic: 0
  },
  messages: []
};

function addPipelineMessage(stage, message) {
  if (!message) return;
  const rawText = typeof message === 'string' ? message : JSON.stringify(message);
  if (pipelineQuietMode && shouldSuppressQuietMessage(rawText)) return;
  const text = summarizePipelineMessage(rawText);
  const lastMessage = pipelineState.messages[pipelineState.messages.length - 1];

  if (lastMessage && lastMessage.message === text) {
    lastMessage.time = Date.now();
    lastMessage.repeatCount = (lastMessage.repeatCount || 1) + 1;
    return;
  }

  pipelineState.messages.push({
    time: Date.now(),
    stage,
    message: text
  });

  if (pipelineState.messages.length > PIPELINE_LOG_LIMIT) {
    pipelineState.messages = pipelineState.messages.slice(-PIPELINE_LOG_LIMIT);
  }
}

function summarizePipelineMessage(message) {
  const text = String(message || '');

  if (/access challenge detected|captcha/i.test(text)) {
    return 'CAPTCHA encountered: cooling down or waiting for clearance.';
  }

  if (/no new content loaded|retrying after a short pause/i.test(text)) {
    return 'Page stalled: still waiting for more content.';
  }

  if (/stuck for too long|moving on/i.test(text)) {
    return 'Page stalled: saved current discoveries and moving on.';
  }

  if (/closed chrome after|restarted updater chrome/i.test(text)) {
    return 'Chrome restarted to clear browser memory.';
  }

  if (/failed to load dj list/i.test(text)) {
    return '1001Tracklists unavailable for this letter: moving on.';
  }

  return text;
}

function shouldSuppressQuietMessage(message) {
  return [
    /^Inserted new DJ:/i,
    /^Attempt \d+ - Fetching data for DJ:/i,
    /^Fetching data for DJ:/i,
    /^Updated DJ:/i,
    /^Emails saved for /i,
    /^Found emails for /i
  ].some(pattern => pattern.test(message));
}

function shouldSuppressQuietEvent(event, data) {
  if (!pipelineQuietMode) return false;
  const suppressibleEvents = new Set([
    'scraperOutput',
    'updaterOutput',
    'emailSearchOutput',
    'emailsFound',
    'emailsSaved'
  ]);
  if (!suppressibleEvents.has(event)) return false;
  const text = typeof data === 'string'
    ? data
    : data && data.dj && Array.isArray(data.emails)
      ? `Found emails for ${data.dj}: ${data.emails.join(', ')}`
      : '';
  return shouldSuppressQuietMessage(text);
}

function resetPipelineQuietMode() {
  pipelineQuietMode = false;
  setScraperQuietMode(false);
  setUpdaterQuietMode(false);
}

function setPipelineState(patch) {
  pipelineState = {
    ...pipelineState,
    ...patch
  };
}

function setPipelineStageProgress(stage, stagePercent, label) {
  if (stage === 'complete') {
    setPipelineState({
      stage,
      progress: 100,
      label: label || 'Complete'
    });
    return;
  }

  const stageIndex = pipelineStageOrder[stage] || 0;
  const bounded = Math.max(0, Math.min(100, Number(stagePercent) || 0));
  const stageUnits = (bounded / 100) * pipelineUnitsPerStage;
  const overall = ((stageIndex * pipelineUnitsPerStage + stageUnits) / pipelineTotalUnits) * 100;
  setPipelineState({
    stage,
    progress: Math.max(pipelineState.progress || 0, overall),
    label: label || `${stage} (${getPipelineUnit(stage, bounded)}/${pipelineTotalUnits})`
  });
}

function getPipelineUnit(stage, percent) {
  const stageIndex = pipelineStageOrder[stage] || 0;
  const bounded = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.min(
    pipelineTotalUnits,
    Math.max(0, Math.floor(stageIndex * pipelineUnitsPerStage + ((bounded / 100) * pipelineUnitsPerStage)))
  );
}

function createEmptyRunStats() {
  return {
    djsFound: 0,
    newDjs: 0,
    profilesUpdated: 0,
    emailsFound: 0,
    emailsQueuedForMagic: 0
  };
}

function updatePipelineRunStats(patch) {
  pipelineState.runStats = {
    ...createEmptyRunStats(),
    ...(pipelineState.runStats || {}),
    ...patch
  };
}

async function refreshLastSuccessfulRun() {
  try {
    const lastSuccessfulRun = await getLastSuccessfulPipelineRun();
    if (lastSuccessfulRun) {
      setPipelineState({
        lastSuccessfulRun,
        lastRunDurationMs: lastSuccessfulRun.durationMs
      });
    }
    return lastSuccessfulRun;
  } catch (error) {
    console.error(`Unable to load last successful pipeline run: ${error.message}`);
    return null;
  }
}

async function startPersistedPipelineRun(startLetter) {
  try {
    return await createPipelineRun(startLetter);
  } catch (error) {
    console.error(`Unable to create pipeline run history row: ${error.message}`);
    return null;
  }
}

async function finishPersistedPipelineRun(status, errorSummary = null) {
  if (!pipelineState.runId) return;

  const endedAt = pipelineState.endedAt || Date.now();
  const durationMs = pipelineState.startedAt ? endedAt - pipelineState.startedAt : null;
  const stats = {
    ...createEmptyRunStats(),
    ...(pipelineState.runStats || {})
  };

  try {
    await updatePipelineRun(pipelineState.runId, {
      status,
      finishedAt: new Date(endedAt).toISOString(),
      durationMs,
      djsFound: stats.djsFound,
      newDjs: stats.newDjs,
      profilesUpdated: stats.profilesUpdated,
      emailsFound: stats.emailsFound,
      emailsQueuedForMagic: stats.emailsQueuedForMagic,
      errorSummary
    });

    if (status === 'success') {
      await refreshLastSuccessfulRun();
    }
  } catch (error) {
    console.error(`Unable to finish pipeline run history row: ${error.message}`);
  }
}

async function emitPipelineSnapshot(socket) {
  await refreshLastSuccessfulRun();
  socket.emit('pipelineState', getPipelineSnapshot());
}

function beginPipelineState(startLetter, runRecord = null) {
  const lastRunDurationMs = pipelineState.lastRunDurationMs;
  const lastSuccessfulRun = pipelineState.lastSuccessfulRun;
  pipelineState = {
    runId: runRecord ? runRecord.id : null,
    running: true,
    stage: 'scraper',
    progress: 0,
    label: 'Starting full run',
    startLetter: startLetter || 'a',
    startedAt: runRecord ? new Date(runRecord.startedAt).getTime() : Date.now(),
    endedAt: null,
    lastRunDurationMs,
    lastSuccessfulRun,
    runStats: createEmptyRunStats(),
    messages: []
  };
}

function completePipelineState(label) {
  const endedAt = Date.now();
  const duration = pipelineState.startedAt ? endedAt - pipelineState.startedAt : null;
  setPipelineState({
    running: false,
    stage: 'complete',
    progress: 100,
    label: label || 'Complete',
    endedAt,
    lastRunDurationMs: duration
  });
  void finishPersistedPipelineRun('success');
}

function getPipelineSnapshot() {
  return {
    ...pipelineState,
    running: pipelineState.running || scraperRunning || updaterRunning || emailScrapingRunning,
    stopRequested: scraperStopRequested || updaterStopRequested || emailScrapingStopRequested,
    scheduler: getSchedulerSnapshot(),
    messages: [...pipelineState.messages]
  };
}

function parseSchedulerTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 2, minute: 0 };

  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return { hour, minute };
}

function getSchedulerDayIndex() {
  const index = schedulerDayNames.indexOf(schedulerDay);
  return index >= 0 ? index : 2;
}

function getNextScheduledRunDate(fromDate = new Date()) {
  const { hour, minute } = parseSchedulerTime(schedulerTime);
  const targetDay = getSchedulerDayIndex();
  const next = new Date(fromDate);
  next.setHours(hour, minute, 0, 0);

  let daysUntilTarget = targetDay - next.getDay();
  if (daysUntilTarget < 0 || (daysUntilTarget === 0 && next <= fromDate)) {
    daysUntilTarget += 7;
  }

  next.setDate(next.getDate() + daysUntilTarget);
  return next;
}

function getSchedulerSnapshot() {
  return {
    enabled: schedulerEnabled,
    day: schedulerDayNames[getSchedulerDayIndex()],
    time: schedulerTime,
    startLetter: schedulerStartLetter,
    nextRunAt: schedulerNextRunAt ? schedulerNextRunAt.toISOString() : null,
    lastRunAt: schedulerLastRunAt ? schedulerLastRunAt.toISOString() : null,
    lastStatus: schedulerLastStatus
  };
}

function updatePipelineFromScraperMessage(message) {
  const text = String(message || '');
  const completed = text.match(/Completed fetching DJs for '([a-z0-9])'/i);
  const fetching = text.match(/Fetching DJs starting with '([a-z0-9])'/i);
  const match = completed || fetching;
  if (!match) return;

  const letter = match[1].toLowerCase();
  const index = pipelineAlphabet.indexOf(letter);
  if (index < 0) return;

  const completedUnits = index + (completed ? 1 : 0);
  const stagePercent = (completedUnits / pipelineUnitsPerStage) * 100;
  const currentUnit = Math.min(pipelineTotalUnits, completedUnits + (fetching ? 1 : 0));
  const action = completed ? 'Scanned' : 'Scanning';

  setPipelineStageProgress(
    'scraper',
    stagePercent,
    `${action} ${letter.toUpperCase()} (${currentUnit}/${pipelineTotalUnits})`
  );
}

function recordPipelineEvent(event, data) {
  switch (event) {
    case 'scraperOutput':
      setPipelineState({ stage: 'scraper' });
      addPipelineMessage('scraper', data);
      updatePipelineFromScraperMessage(data);
      break;
    case 'scraperStatus': {
      const currentDJ = data && data.currentDJ;
      const processedCount = data && data.processedCount;
      const newDJCount = data && data.newDJCount;
      updatePipelineRunStats({
        djsFound: Math.max(pipelineState.runStats?.djsFound || 0, Number(processedCount) || 0),
        newDjs: Math.max(pipelineState.runStats?.newDjs || 0, Number(newDJCount) || 0)
      });
      setPipelineState({
        stage: 'scraper',
        label: currentDJ
          ? `Scanning: ${currentDJ}`
          : `Scanning ${processedCount || 0} processed / ${newDJCount || 0} new`
      });
      break;
    }
    case 'scraperError':
      setPipelineState({ stage: 'scraper', label: 'Scanner needs attention' });
      addPipelineMessage('scraper', `Scraper: ${data}`);
      break;
    case 'scraperComplete':
      setPipelineStageProgress('scraper', 100, 'Scanning complete');
      addPipelineMessage('scraper', data);
      break;
    case 'scraperStopped':
      setPipelineState({ running: false, stage: 'scraper', label: 'Stopped', endedAt: Date.now() });
      addPipelineMessage('scraper', data);
      void finishPersistedPipelineRun('stopped', data || 'Scraper stopped.');
      break;
    case 'updaterOutput':
      if (/^Updated DJ:/i.test(String(data || ''))) {
        updatePipelineRunStats({
          profilesUpdated: (pipelineState.runStats?.profilesUpdated || 0) + 1
        });
      }
      setPipelineStageProgress('updater', 0, `Updating DJ data (${getPipelineUnit('updater', 0)}/${pipelineTotalUnits})`);
      addPipelineMessage('updater', data);
      break;
    case 'updaterError':
      setPipelineState({ stage: 'updater', label: 'Updater needs attention' });
      addPipelineMessage('updater', `Updater: ${data}`);
      break;
    case 'updateProgress':
      setPipelineStageProgress('updater', data, `Updating DJ data (${getPipelineUnit('updater', data)}/${pipelineTotalUnits})`);
      break;
    case 'updaterComplete':
      setPipelineStageProgress('updater', 100, 'DJ data updated');
      addPipelineMessage('updater', data);
      break;
    case 'updaterStopped':
      setPipelineState({ running: false, stage: 'updater', label: 'Stopped', endedAt: Date.now() });
      addPipelineMessage('updater', data);
      void finishPersistedPipelineRun('stopped', data || 'Updater stopped.');
      break;
    case 'emailScrapingStarted':
      setPipelineStageProgress('emails', 0, `Searching emails (${getPipelineUnit('emails', 0)}/${pipelineTotalUnits})`);
      addPipelineMessage('emails', data);
      break;
    case 'emailSearchOutput':
      setPipelineStageProgress('emails', 0, `Searching emails (${getPipelineUnit('emails', 0)}/${pipelineTotalUnits})`);
      addPipelineMessage('emails', data);
      break;
    case 'emailScrapingError':
      setPipelineState({ stage: 'emails', label: 'Email search needs attention' });
      addPipelineMessage('emails', `Email search: ${data}`);
      break;
    case 'emailsFound':
      if (data && data.dj && Array.isArray(data.emails)) {
        updatePipelineRunStats({
          emailsFound: (pipelineState.runStats?.emailsFound || 0) + data.emails.length
        });
        addPipelineMessage('emails', `Found emails for ${data.dj}: ${data.emails.join(', ')}`);
      }
      break;
    case 'emailsSaved':
      if (data && data.dj && Array.isArray(data.emails)) {
        addPipelineMessage('emails', `Emails saved for ${data.dj}: ${data.emails.length}`);
      }
      break;
    case 'magicSyncQueued': {
      const queued = Number(data?.queued || 0) + Number(data?.updated || 0);
      const skippedSynced = Number(data?.skippedSynced || 0) + Number(data?.skippedAlreadyExists || 0);
      updatePipelineRunStats({
        emailsQueuedForMagic: queued,
        skippedSynced
      });
      addPipelineMessage('emails', `Magic Emailer queue updated: ${queued} pending contacts, ${skippedSynced} skipped/synced.`);
      break;
    }
    case 'scrapingProgress':
      setPipelineStageProgress('emails', data, `Searching emails (${getPipelineUnit('emails', data)}/${pipelineTotalUnits})`);
      break;
    case 'scrapingComplete':
      completePipelineState('Complete');
      addPipelineMessage('emails', data);
      break;
    case 'emailScrapingStopped':
      setPipelineState({ running: false, stage: 'emails', label: 'Stopped', endedAt: Date.now() });
      addPipelineMessage('emails', data);
      void finishPersistedPipelineRun('stopped', data || 'Email scraping stopped.');
      break;
    default:
      break;
  }
}

const pipelineEmitter = {
  emit(event, ...args) {
    recordPipelineEvent(event, args[0]);
    if (shouldSuppressQuietEvent(event, args[0])) return;
    io.emit(event, ...args);
  }
};

function emitPipeline(socket, event, data) {
  recordPipelineEvent(event, data);
  if (shouldSuppressQuietEvent(event, data)) return;
  socket.emit(event, data);
}

async function startEmailScrapingRun(socket) {
  if (emailScrapingRunning) {
    emitPipeline(socket, 'emailSearchOutput', 'Email scraping is already running.');
    return false;
  }

  emailScrapingRunning = true;
  emailScrapingStopRequested = false;
  try {
    const djs = await getDJsForEmailSearch();
    emitPipeline(socket, 'emailSearchOutput', `Email search queue contains ${djs.length} stale or missing DJ records.`);
    emailScrapingProcess = startEmailScraping(djs, pipelineEmitter);
    await emailScrapingProcess;
    if (!emailScrapingStopRequested) {
      const magicSummary = await queueMagicEmailerSyncContacts();
      emitPipeline(socket, 'magicSyncQueued', magicSummary);
    }
    return true;
  } catch (err) {
    emitPipeline(socket, 'emailScrapingError', `Email scraping exited with error: ${err.message}`);
    setPipelineState({ running: false, endedAt: Date.now() });
    await finishPersistedPipelineRun('failed', `Email scraping exited with error: ${err.message}`);
    return false;
  } finally {
    emailScrapingRunning = false;
    emailScrapingProcess = null;
  }
}

async function startUpdaterRun(socket, options = {}) {
  const autoStartEmails = options.autoStartEmails !== false;

  if (scraperRunning) {
    emitPipeline(socket, 'updaterError', 'Scraper is currently running. Stop it before starting the updater so Chrome can reuse the same 1001 session safely.');
    return false;
  }

  if (updaterRunning) {
    emitPipeline(socket, 'updaterOutput', 'Updater is already running.');
    return false;
  }

  updaterRunning = true;
  updaterStopRequested = false;
  let completedNormally = false;
  try {
    updaterProcess = updateAllDJs(pipelineEmitter);
    await updaterProcess;
    if (!updaterStopRequested) {
      emitPipeline(socket, 'updaterComplete', 'Updater completed successfully.');
    }
    completedNormally = !updaterStopRequested;
  } catch (err) {
    emitPipeline(socket, 'updaterError', `Updater exited with error: ${err.message}`);
    setPipelineState({ running: false, endedAt: Date.now() });
    await finishPersistedPipelineRun('failed', `Updater exited with error: ${err.message}`);
    return false;
  } finally {
    updaterRunning = false;
    updaterProcess = null;
  }

  if (updaterStopRequested) {
    emitPipeline(socket, 'updaterStopped', 'Updater has been stopped.');
    return false;
  }

  if (completedNormally && autoStartEmails) {
    emitPipeline(socket, 'emailSearchOutput', 'DJ data updater finished. Starting email scraping automatically...');
    await startEmailScrapingRun(socket);
  }

  return completedNormally;
}

async function startPipelineRun(socket, startLetter, options = {}) {
  if (scraperRunning || updaterRunning || emailScrapingRunning) {
    emitPipeline(socket, 'scraperOutput', 'A full run is already in progress.');
    return;
  }

  pipelineQuietMode = Boolean(options.quiet);
  setScraperQuietMode(pipelineQuietMode);
  setUpdaterQuietMode(pipelineQuietMode);

  const effectiveStartLetter = String(startLetter || '').trim().toLowerCase() || 'resume';
  const runRecord = await startPersistedPipelineRun(effectiveStartLetter);
  beginPipelineState(effectiveStartLetter, runRecord);
  emitPipeline(socket, 'scraperOutput', `Starting ${pipelineQuietMode ? 'quiet scheduled ' : ''}end-to-end run from letter "${effectiveStartLetter}".`);
  scraperRunning = true;
  scraperStopRequested = false;
  try {
    scraperProcess = scrapeAllDJs(effectiveStartLetter, pipelineEmitter);
    await scraperProcess;
    if (!scraperStopRequested) {
      emitPipeline(socket, 'scraperComplete', 'Scraper completed successfully.');
    }
  } catch (err) {
    emitPipeline(socket, 'scraperError', `Scraper exited with error: ${err.message}`);
    setPipelineState({ running: false, endedAt: Date.now() });
    await finishPersistedPipelineRun('failed', `Scraper exited with error: ${err.message}`);
    resetPipelineQuietMode();
    return;
  } finally {
    scraperRunning = false;
    scraperProcess = null;
  }

  if (scraperStopRequested) {
    emitPipeline(socket, 'scraperStopped', 'Scraper has been stopped.');
    resetPipelineQuietMode();
    return;
  }

  if (!scraperStopRequested && !updaterRunning) {
    emitPipeline(socket, 'updaterOutput', 'Scraper finished. Starting DJ data updater automatically...');
    await startUpdaterRun(socket);
  }

  resetPipelineQuietMode();
}

function stopPipelineRun(socket) {
  if (scraperRunning && scraperProcess) {
    scraperStopRequested = true;
    setShouldStopScraper(true);
    emitPipeline(socket, 'scraperOutput', 'Stop requested. Waiting for the scraper to finish its current step...');
    return;
  }

  if (updaterRunning && updaterProcess) {
    updaterStopRequested = true;
    setShouldStopUpdater(true);
    emitPipeline(socket, 'updaterOutput', 'Stop requested. Waiting for the updater to finish its current step...');
    return;
  }

  if (emailScrapingRunning && emailScrapingProcess) {
    emailScrapingStopRequested = true;
    setShouldStopScraping(true);
    emitPipeline(socket, 'emailScrapingStopped', 'Email scraping has been stopped.');
    return;
  }

  emitPipeline(socket, 'scraperOutput', 'No full run is currently running.');
}

function scheduleNextPipelineRun() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  if (!schedulerEnabled) {
    schedulerNextRunAt = null;
    schedulerLastStatus = 'disabled';
    return;
  }

  schedulerNextRunAt = getNextScheduledRunDate();
  schedulerLastStatus = schedulerLastStatus || 'scheduled';
  const delayMs = Math.max(1000, schedulerNextRunAt.getTime() - Date.now());

  schedulerTimer = setTimeout(() => {
    void runScheduledPipeline();
  }, delayMs);
}

async function runScheduledPipeline() {
  schedulerLastRunAt = new Date();

  const schedulerSocket = {
    emit(event, data) {
      io.emit(event, data);
    }
  };

  if (scraperRunning || updaterRunning || emailScrapingRunning) {
    schedulerLastStatus = 'skipped_running';
    emitPipeline(schedulerSocket, 'scraperOutput', 'Scheduled full run skipped because a pipeline is already running.');
    scheduleNextPipelineRun();
    io.emit('pipelineState', getPipelineSnapshot());
    return;
  }

  schedulerLastStatus = 'running';
  emitPipeline(schedulerSocket, 'scraperOutput', `Scheduled full run starting from "${schedulerStartLetter}".`);
  io.emit('pipelineState', getPipelineSnapshot());

  try {
    await startPipelineRun(schedulerSocket, schedulerStartLetter, { quiet: true });
    schedulerLastStatus = 'completed';
  } catch (error) {
    schedulerLastStatus = 'failed';
    emitPipeline(schedulerSocket, 'scraperError', `Scheduled full run failed: ${error.message}`);
  } finally {
    scheduleNextPipelineRun();
    io.emit('pipelineState', getPipelineSnapshot());
  }
}

io.on('connection', (socket) => {
  console.log('New client connected');
  void emitPipelineSnapshot(socket);

  socket.on('startPipeline', async (startLetter) => {
    await startPipelineRun(socket, startLetter || 'resume');
  });

  socket.on('stopPipeline', () => {
    stopPipelineRun(socket);
  });

  socket.on('getPipelineState', () => {
    void emitPipelineSnapshot(socket);
  });

  socket.on('startScraper', async (startLetter) => {
    await startPipelineRun(socket, startLetter || 'resume');
  });

  socket.on('stopScraper', () => {
    stopPipelineRun(socket);
  });

  socket.on('startUpdater', async () => {
    await startUpdaterRun(socket);
  });

  socket.on('stopUpdater', () => {
    stopPipelineRun(socket);
  });

  socket.on('getDJData', async (filters) => {
    try {
      const djs = await getAllDJs(filters);
      socket.emit('djData', djs);
      socket.emit('djDataLoaded');
    } catch (err) {
      socket.emit('djDataError', `Error fetching DJ data: ${err.message}`);
    }
  });

  socket.on('getDJStats', async () => {
    try {
      const totalDJs = await getDJCount();
      const searchableDJs = await getSearchableDJCount();
      socket.emit('djStats', {
        total: totalDJs,
        withAdditionalData: searchableDJs
      });
    } catch (err) {
      socket.emit('djStatsError', `Error fetching DJ stats: ${err.message}`);
    }
  });

  socket.on('requestDJCount', async () => {
    try {
      const totalCount = await getDJCount();
      io.emit('updateDJCount', totalCount);
    } catch (error) {
      console.error('Error fetching DJ count:', error);
    }
  });

  socket.on('filterDJsForEmails', async (filters) => {
    try {
      const djs = await getAllDJs(filters);
      startEmailScraping(djs, pipelineEmitter);
    } catch (error) {
      console.error('Error filtering DJs for emails:', error.message);
      emitPipeline(socket, 'emailScrapingStarted', `Error filtering DJs for emails: ${error.message}`);
    }
  });

  socket.on('startEmailScraping', async () => {
    await startEmailScrapingRun(socket);
  });
  
  socket.on('stopEmailScraping', () => {
    stopPipelineRun(socket);
  });
  
  // New handler to get the count of DJs with email addresses
  socket.on('getDJsWithEmailsCount', async () => {
    try {
      console.log('getDJsWithEmailsCount event received');
      const djsWithEmailsCount = await getDJsWithEmailsCount();
      console.log('DJs with emails count:', djsWithEmailsCount);
      socket.emit('djsWithEmailsCount', djsWithEmailsCount);
    } catch (err) {
      console.error('Error fetching DJs with email addresses count:', err.message);
      socket.emit('djStatsError', `Error fetching DJs with email addresses count: ${err.message}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  scheduleNextPipelineRun();
  if (schedulerEnabled && schedulerNextRunAt) {
    console.log(`Pipeline scheduler enabled. Next run: ${schedulerNextRunAt.toLocaleString()}`);
  } else {
    console.log('Pipeline scheduler disabled.');
  }
});
