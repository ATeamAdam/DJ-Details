const socket = io();

let pipelineRunning = false;
let pipelineTimer = null;
let currentStage = 'idle';
let scraperSpeedStartAt = null;
let scraperSpeedStartCount = 0;

const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const stageOrder = {
  idle: 0,
  scraper: 0,
  updater: 1,
  emails: 2,
  complete: 3
};
const unitsPerStage = alphabet.length;
const totalPipelineUnits = unitsPerStage * 3;
const maxStatusLines = 300;

const elements = {
  togglePipeline: document.getElementById('togglePipeline'),
  pipelineTimer: document.getElementById('pipelineTimer'),
  lastRunDuration: document.getElementById('lastRunDuration'),
  pipelineRunState: document.getElementById('pipelineRunState'),
  schedulerStatus: document.getElementById('schedulerStatus'),
  schedulerNextRun: document.getElementById('schedulerNextRun'),
  pipelineSpeed: document.getElementById('pipelineSpeed'),
  pipelineProgress: document.getElementById('pipelineProgress'),
  pipelineOutput: document.getElementById('pipelineOutput'),
  startLetter: document.getElementById('startLetter'),
  filterDJs: document.getElementById('filterDJs'),
  searchBox: document.getElementById('searchBox'),
  djResults: document.getElementById('djResults'),
  totalDJs: document.getElementById('totalDJs'),
  searchableDJs: document.getElementById('searchableDJs'),
  djsWithEmailsCount: document.getElementById('djsWithEmailsCount')
};

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${secs}`;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function titleCase(value) {
  const text = String(value || '');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
}

function setTimerSeconds(seconds) {
  elements.pipelineTimer.textContent = formatDuration(seconds);
}

function startTimer(timerElement, initialSeconds = 0) {
  let seconds = Math.max(0, Math.floor(Number(initialSeconds) || 0));
  timerElement.textContent = formatDuration(seconds);
  return setInterval(() => {
    seconds++;
    timerElement.textContent = formatDuration(seconds);
  }, 1000);
}

function appendStatus(message) {
  if (!message) return;
  const timestamp = new Date().toLocaleTimeString();
  elements.pipelineOutput.value += `[${timestamp}] ${message}\n`;
  trimStatusWindow();
  elements.pipelineOutput.scrollTop = elements.pipelineOutput.scrollHeight;
}

function trimStatusWindow() {
  const text = elements.pipelineOutput.value.trimEnd();
  if (!text) return;

  const lines = text.split('\n');
  if (lines.length <= maxStatusLines) return;

  elements.pipelineOutput.value = `${lines.slice(-maxStatusLines).join('\n')}\n`;
}

function setSpeedLabel(message) {
  if (!elements.pipelineSpeed) return;
  elements.pipelineSpeed.textContent = message;
}

function resetScraperSpeed(message = 'Current speed: waiting for scan') {
  scraperSpeedStartAt = null;
  scraperSpeedStartCount = 0;
  setSpeedLabel(message);
}

function updateScraperSpeed(processedCount) {
  const count = Number(processedCount) || 0;
  const now = Date.now();

  if (!scraperSpeedStartAt || count < scraperSpeedStartCount) {
    scraperSpeedStartAt = now;
    scraperSpeedStartCount = count;
    setSpeedLabel('Current speed: warming up');
    return;
  }

  const elapsedMinutes = (now - scraperSpeedStartAt) / 60000;
  const processedSinceStart = Math.max(0, count - scraperSpeedStartCount);
  const djsPerMinute = elapsedMinutes > 0 ? processedSinceStart / elapsedMinutes : 0;
  const formatted = djsPerMinute >= 10 ? djsPerMinute.toFixed(0) : djsPerMinute.toFixed(1);

  setSpeedLabel(`Current speed: ${formatted} DJs/min`);
}

function setPipelineButton(running) {
  pipelineRunning = running;
  elements.togglePipeline.textContent = running ? 'Stop Full Run' : 'Start Full Run';
}

function setRunStateLabel(label) {
  if (!elements.pipelineRunState) return;
  elements.pipelineRunState.textContent = `Current state: ${label}`;
}

function updateSchedulerDisplay(scheduler) {
  if (!scheduler) return;

  if (elements.schedulerStatus) {
    const scheduleLabel = scheduler.enabled
      ? `enabled (${titleCase(scheduler.day)} ${scheduler.time})`
      : 'disabled';
    const lastStatus = scheduler.lastStatus ? `, last status: ${scheduler.lastStatus}` : '';
    elements.schedulerStatus.textContent = `Scheduler: ${scheduleLabel}${lastStatus}`;
  }

  if (elements.schedulerNextRun) {
    const nextRun = scheduler.enabled && scheduler.nextRunAt
      ? formatDateTime(scheduler.nextRunAt)
      : '';
    elements.schedulerNextRun.textContent = nextRun
      ? `Next scheduled run: ${nextRun}`
      : 'Next scheduled run: not scheduled';
  }
}

function setProgress(percent, label) {
  const bounded = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.pipelineProgress.style.width = `${bounded}%`;
  elements.pipelineProgress.textContent = label || `${Math.round(bounded)}%`;
}

function getPipelineUnit(stage, percent) {
  const stageIndex = stageOrder[stage] || 0;
  const bounded = Math.max(0, Math.min(100, Number(percent) || 0));
  return Math.min(
    totalPipelineUnits,
    Math.max(0, Math.floor(stageIndex * unitsPerStage + ((bounded / 100) * unitsPerStage)))
  );
}

function setStage(stage, message) {
  currentStage = stage;
  if (message) appendStatus(message);
  setRunStateLabel(stage);
  const stageIndex = stageOrder[stage] || 0;
  const overall = stage === 'complete'
    ? 100
    : ((stageIndex * unitsPerStage) / totalPipelineUnits) * 100;
  setProgress(overall, stage === 'idle' ? 'Idle' : `${stage} ${Math.round(overall)}%`);
}

function setStageProgress(stage, percent, label) {
  if (stage === 'complete') {
    setProgress(100, label || 'Complete');
    return;
  }

  const stageIndex = stageOrder[stage] || 0;
  const bounded = Math.max(0, Math.min(100, Number(percent) || 0));
  const stageUnits = (bounded / 100) * unitsPerStage;
  const overall = ((stageIndex * unitsPerStage + stageUnits) / totalPipelineUnits) * 100;
  setProgress(overall, label || `${stage} (${getPipelineUnit(stage, bounded)}/${totalPipelineUnits})`);
}

function finishPipeline(message) {
  if (message) appendStatus(message);
  setStage('complete');
  setProgress(100, 'Complete');
  if (elements.lastRunDuration) {
    elements.lastRunDuration.textContent = `Last full run: ${elements.pipelineTimer.textContent}`;
  }
  setPipelineButton(false);
  resetScraperSpeed('Current speed: not scanning');
  clearInterval(pipelineTimer);
  pipelineTimer = null;
  socket.emit('getDJStats');
  socket.emit('getDJsWithEmailsCount');
}

function stopPipeline(message) {
  if (message) appendStatus(message);
  setPipelineButton(false);
  resetScraperSpeed('Current speed: stopped');
  clearInterval(pipelineTimer);
  pipelineTimer = null;
}

function formatStatusEntry(entry) {
  const timestamp = entry && entry.time
    ? new Date(entry.time).toLocaleTimeString()
    : new Date().toLocaleTimeString();
  const message = entry && entry.message ? entry.message : '';
  return `[${timestamp}] ${message}`;
}

function hydratePipelineState(state) {
  if (!state) return;

  currentStage = state.stage || 'idle';

  if (Array.isArray(state.messages)) {
    elements.pipelineOutput.value = state.messages.map(formatStatusEntry).join('\n');
    if (elements.pipelineOutput.value) {
      elements.pipelineOutput.value += '\n';
    }
    elements.pipelineOutput.scrollTop = elements.pipelineOutput.scrollHeight;
  }

  setProgress(state.progress || 0, state.label || (state.running ? 'Running' : 'Idle'));
  setPipelineButton(Boolean(state.running));
  setRunStateLabel(state.running ? `${currentStage} running` : currentStage);
  updateSchedulerDisplay(state.scheduler);

  clearInterval(pipelineTimer);
  pipelineTimer = null;

  const startedAt = Number(state.startedAt) || 0;
  const endedAt = Number(state.endedAt) || Date.now();
  const elapsedSeconds = startedAt ? Math.floor(((state.running ? Date.now() : endedAt) - startedAt) / 1000) : 0;

  if (state.running) {
    pipelineTimer = startTimer(elements.pipelineTimer, elapsedSeconds);
  } else {
    setTimerSeconds(elapsedSeconds);
  }

  resetScraperSpeed(state.running && currentStage === 'scraper'
    ? 'Current speed: waiting for next scanner update'
    : 'Current speed: not scanning');

  if (elements.lastRunDuration) {
    const lastRun = state.lastSuccessfulRun || null;
    const finishedAt = formatDateTime(lastRun && lastRun.finishedAt);
    const durationMs = lastRun && lastRun.durationMs ? lastRun.durationMs : state.lastRunDurationMs;
    elements.lastRunDuration.textContent = durationMs
      ? `Last full run: ${finishedAt ? `${finishedAt} ` : ''}(${formatDuration(durationMs / 1000)})`
      : 'Last full run: not yet completed';
  }
}

function handlePipelineToggle() {
  if (pipelineRunning) {
    appendStatus('Stop requested.');
    socket.emit('stopPipeline');
    return;
  }

  elements.pipelineOutput.value = '';
  setPipelineButton(true);
  resetScraperSpeed();
  setStage('scraper', 'Starting full run...');
  clearInterval(pipelineTimer);
  pipelineTimer = startTimer(elements.pipelineTimer);
  socket.emit('startPipeline', elements.startLetter.value || 'a');
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function updateLetterProgress(message) {
  const text = String(message || '');
  const completed = text.match(/Completed fetching DJs for '([a-z0-9])'/i);
  const fetching = text.match(/Fetching DJs starting with '([a-z0-9])'/i);
  const match = completed || fetching;
  if (!match) return;

  const index = alphabet.indexOf(match[1].toLowerCase());
  if (index < 0) return;

  const completedUnits = index + (completed ? 1 : 0);
  const stagePercent = (completedUnits / unitsPerStage) * 100;
  const currentUnit = Math.min(totalPipelineUnits, completedUnits + (fetching ? 1 : 0));
  const action = completed ? 'Scanned' : 'Scanning';
  setStageProgress(
    'scraper',
    stagePercent,
    `${action} ${match[1].toUpperCase()} (${currentUnit}/${totalPipelineUnits})`
  );
}

elements.togglePipeline.addEventListener('click', handlePipelineToggle);

socket.on('pipelineState', hydratePipelineState);

socket.on('scraperOutput', (data) => {
  setStage('scraper');
  appendStatus(data);
  updateLetterProgress(data);
});

socket.on('scraperError', (data) => {
  setStage('scraper');
  appendStatus(`Scraper: ${data}`);
});

socket.on('scraperComplete', (data) => {
  setStageProgress('scraper', 100, 'Scanning complete');
  appendStatus(data);
});

socket.on('scraperStopped', (data) => {
  appendStatus(data);
  stopPipeline('Full run stopped during DJ scanning.');
});

socket.on('scraperStatus', ({ processedCount, newDJCount, currentDJ, currentURL }) => {
  if (currentStage !== 'scraper') return;
  updateScraperSpeed(processedCount);
  const label = currentDJ
    ? `Scanning: ${currentDJ}`
    : `Scanning ${processedCount || 0} processed / ${newDJCount || 0} new`;
  const currentWidth = parseFloat(elements.pipelineProgress.style.width) || 0;
  setProgress(Math.max(currentWidth, 3), label);
});

socket.on('updaterOutput', (data) => {
  if (currentStage !== 'updater') {
    setStage('updater');
  }
  appendStatus(data);
});

socket.on('updaterError', (data) => {
  if (currentStage !== 'updater') {
    setStage('updater');
  }
  appendStatus(`Updater: ${data}`);
});

socket.on('updateProgress', (percentage) => {
  setStageProgress('updater', percentage, `Updating DJ data (${getPipelineUnit('updater', percentage)}/${totalPipelineUnits})`);
});

socket.on('updaterComplete', (data) => {
  setStageProgress('updater', 100, 'DJ data updated');
  appendStatus(data);
});

socket.on('updaterStopped', (data) => {
  appendStatus(data);
  stopPipeline('Full run stopped during DJ data update.');
});

socket.on('emailScrapingStarted', (data) => {
  if (currentStage !== 'emails') {
    setStage('emails');
  }
  appendStatus(data);
});

socket.on('emailSearchOutput', (data) => {
  if (currentStage !== 'emails') {
    setStage('emails');
  }
  appendStatus(data);
});

socket.on('emailScrapingError', (data) => {
  if (currentStage !== 'emails') {
    setStage('emails');
  }
  appendStatus(`Email search: ${data}`);
});

socket.on('emailsFound', ({ dj, url, emails }) => {
  appendStatus(`Found emails for ${dj}: ${emails.join(', ')} (${url})`);
});

socket.on('emailsSaved', ({ dj, emails }) => {
  appendStatus(`Emails saved for ${dj}: ${emails.length}`);
});

socket.on('scrapingProgress', (percentage) => {
  setStageProgress('emails', percentage, `Searching emails (${getPipelineUnit('emails', percentage)}/${totalPipelineUnits})`);
});

socket.on('scrapingComplete', (data) => {
  finishPipeline(data);
});

socket.on('emailScrapingStopped', (data) => {
  appendStatus(data);
  stopPipeline('Full run stopped during email search.');
});

socket.on('updateDJCount', (totalCount) => {
  elements.totalDJs.textContent = totalCount;
});

socket.on('djStats', (stats) => {
  elements.totalDJs.textContent = stats.total;
  elements.searchableDJs.textContent = stats.withAdditionalData;
});

socket.on('updateSearchableDJCount', (count) => {
  elements.searchableDJs.textContent = count;
});

socket.on('djsWithEmailsCount', (count) => {
  elements.djsWithEmailsCount.textContent = count;
});

elements.filterDJs.addEventListener('click', () => {
  socket.emit('getDJData', {
    search: elements.searchBox.value
  });
});

socket.on('djData', (djs) => {
  const djResults = elements.djResults;
  djResults.innerHTML = '<table id="djTable"><thead><tr><th>Name</th><th>Country</th><th>Social Media</th><th>Music Styles</th><th>Emails</th></tr></thead><tbody></tbody></table>';
  const tbody = djResults.querySelector('tbody');

  djs.forEach(dj => {
    const tr = document.createElement('tr');
    const socialMediaUrls = parseJson(dj.socialMediaUrls, []);
    const socialMediaLinks = socialMediaUrls.map(url => `<a href="${url}" target="_blank">${url}</a>`).join('<br>');
    const countries = parseJson(dj.country, []);
    const countryNames = countries.map(country => country.replace('Home Country ', '')).join(', ');
    const musicStyles = parseJson(dj.musicStyles, []);
    const emails = parseJson(dj.emails, []);

    tr.innerHTML = `
      <td>${dj.name || ''}</td>
      <td>${countryNames}</td>
      <td>${socialMediaLinks}</td>
      <td>${musicStyles.join(', ')}</td>
      <td>${emails.join(', ')}</td>
    `;
    tbody.appendChild(tr);
  });

  initializeDataTable();
});

function initializeDataTable() {
  if ($.fn.DataTable.isDataTable('#djTable')) {
    $('#djTable').DataTable().destroy();
  }

  $('#djTable').DataTable({
    dom: 'Blfrtip',
    buttons: [
      'copy', 'csv', 'excel', 'pdf', 'print'
    ],
    searching: false
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const waitText = document.getElementById('waitText');
    waitText.style.transition = 'opacity 2s';
    waitText.style.opacity = 1;
    setTimeout(() => {
      waitText.style.transition = 'opacity 1s';
      waitText.style.opacity = 0;
    }, 2000);
  }, 500);

  socket.emit('getDJData', {});
  socket.emit('getDJStats');
  socket.emit('getDJsWithEmailsCount');
  socket.emit('getPipelineState');

  setInterval(() => {
    socket.emit('requestDJCount');
    socket.emit('getDJsWithEmailsCount');
  }, 60000);

  socket.on('djDataLoaded', () => {
    const loaderContainer = document.getElementById('loadingScreen');
    loaderContainer.style.transition = 'opacity 3s';
    loaderContainer.style.opacity = 0;
    setTimeout(() => loaderContainer.style.display = 'none', 3000);
  });
});
