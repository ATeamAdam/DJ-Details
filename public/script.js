const socket = io();

let scraperRunning = false;
let updaterRunning = false;
let emailScrapingRunning = false;
let scraperTimer = null;
let updaterTimer = null;

const elements = {
  toggleScraper: document.getElementById('toggleScraper'),
  toggleUpdater: document.getElementById('toggleUpdater'),
  scrapeEmails: document.getElementById('scrapeEmails'),
  scraperTimer: document.getElementById('scraperTimer'),
  updaterTimer: document.getElementById('updaterTimer'),
  scraperOutput: document.getElementById('scraperOutput'),
  updaterOutput: document.getElementById('updaterOutput'),
  emailSearchOutput: document.getElementById('emailSearchOutput'),
  filterDJs: document.getElementById('filterDJs'),
  searchBox: document.getElementById('searchBox'),
  djResults: document.getElementById('djResults'),
  totalDJs: document.getElementById('totalDJs'),
  searchableDJs: document.getElementById('searchableDJs'),
  updateProgress: document.getElementById('updateProgress'),
  emailSearchProgress: document.getElementById('emailSearchProgress'),
  scraperMessage: document.getElementById('scraperMessage'),
  lastDJ: document.getElementById('lastDJ'),
  processedCount: document.getElementById('processedCount'),
  newDJCount: document.getElementById('newDJCount'),
  currentDJ: document.getElementById('currentDJ'),
  currentURL: document.getElementById('currentURL'),
  foundEmails: document.getElementById('foundEmails'),
  djsWithEmailsCount: document.getElementById('djsWithEmailsCount')
};

function startTimer(timerElement) {
  let seconds = 0;
  return setInterval(() => {
    seconds++;
    const hours = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const secs = String(seconds % 60).padStart(2, '0');
    timerElement.textContent = `${hours}:${minutes}:${secs}`;
  }, 1000);
}

function handleScraperToggle() {
  if (scraperRunning) {
    socket.emit('stopScraper');
  } else {
    const startLetter = document.getElementById('startLetter').value || 'a';
    socket.emit('startScraper', startLetter);
    scraperTimer = startTimer(elements.scraperTimer);
    scraperRunning = true;
    elements.toggleScraper.textContent = 'Stop Scraper';
  }
}

function handleUpdaterToggle() {
  if (updaterRunning) {
    socket.emit('stopUpdater');
  } else {
    socket.emit('startUpdater');
    updaterTimer = startTimer(elements.updaterTimer);
    updaterRunning = true;
    elements.toggleUpdater.textContent = 'Stop Updater';
  }
}

function handleEmailScrapingToggle() {
  console.log(emailScrapingRunning)
  if (emailScrapingRunning) {
    socket.emit('stopEmailScraping');
  } else {
    const filters = {
      search: elements.searchBox.value,
    };
    socket.emit('filterDJsForEmails', filters);
    emailScrapingRunning = true;
    elements.scrapeEmails.textContent = 'Stop Email Scraping';
  }
}

function updateOutput(outputElement, data, replace = false) {
  if (replace) {
    const lines = outputElement.value.split('\n');
    lines[lines.length - 1] = data;
    outputElement.value = lines.join('\n');
  } else {
    outputElement.value += `${data}\n`;
  }
  outputElement.scrollTop = outputElement.scrollHeight;
}

elements.toggleScraper.addEventListener('click', handleScraperToggle);
elements.toggleUpdater.addEventListener('click', handleUpdaterToggle);
elements.scrapeEmails.addEventListener('click', handleEmailScrapingToggle);

socket.on('scraperOutput', (data) => updateOutput(elements.scraperOutput, data));
socket.on('scraperError', (data) => updateOutput(elements.scraperOutput, data));
socket.on('scraperComplete', (data) => {
  updateOutput(elements.scraperOutput, data);
  clearInterval(scraperTimer);
  scraperRunning = false;
  elements.toggleScraper.textContent = 'Start Scraper';
});
socket.on('scraperStopped', (data) => {
  updateOutput(elements.scraperOutput, data);
  clearInterval(scraperTimer);
  scraperRunning = false;
  elements.toggleScraper.textContent = 'Start Scraper';
});
socket.on('scraperMessage', (data) => updateOutput(elements.scraperOutput, data));
socket.on('scraperStatus', ({ currentDJ, currentURL }) => {
  elements.currentDJ.textContent = `Current DJ: ${currentDJ}`;
  elements.currentURL.textContent = `Current URL: ${currentURL}`;
});
socket.on('emailScrapingStarted', (data) => {
  updateOutput(elements.emailSearchOutput, data);
  elements.scrapeEmails.textContent = 'Stop Email Scraping';
  emailScrapingRunning = true;
});

socket.on('emailScrapingStopped', (data) => {
  updateOutput(elements.emailSearchOutput, data);
  elements.scrapeEmails.textContent = 'Start Email Scraping';
  emailScrapingRunning = false;
});
socket.on('emailsFound', ({ dj, url, emails }) => {
  elements.foundEmails.value += `DJ: ${dj}\nURL: ${url}\nEmails: ${emails.join(', ')}\n\n`;
  updateOutput(elements.emailSearchOutput, `Found emails for DJ: ${dj}\nURL: ${url}\nEmails: ${emails.join(', ')}\n`);
});
socket.on('emailsSaved', ({ dj, emails }) => {
  updateOutput(elements.emailSearchOutput, `Emails saved for DJ: ${dj}`);
});
socket.on('scrapingProgress', (percentage) => {
  elements.emailSearchProgress.style.width = `${percentage}%`;
  elements.emailSearchProgress.textContent = `${percentage}%`;
});
socket.on('scrapingComplete', (data) => {
  updateOutput(elements.emailSearchOutput, data);
  emailScrapingRunning = false;
  elements.scrapeEmails.textContent = 'Start Email Scraping';
});
socket.on('updaterOutput', (data) => updateOutput(elements.updaterOutput, data));
socket.on('updaterError', (data) => updateOutput(elements.updaterOutput, data));
socket.on('updaterComplete', (data) => {
  updateOutput(elements.updaterOutput, data);
  clearInterval(updaterTimer);
  updaterRunning = false;
  elements.toggleUpdater.textContent = 'Start Updater';
});
socket.on('updaterStopped', (data) => {
  updateOutput(elements.updaterOutput, data);
  clearInterval(updaterTimer);
  updaterRunning = false;
  elements.toggleUpdater.textContent = 'Start Updater';
});
socket.on('updateDJCount', (totalCount) => {
  elements.totalDJs.textContent = totalCount;
});
socket.on('djStats', (stats) => {
  elements.totalDJs.textContent = stats.total;
  elements.searchableDJs.textContent = stats.withAdditionalData;
});

elements.filterDJs.addEventListener('click', () => {
  const filters = {
    search: elements.searchBox.value,
  };
  socket.emit('getDJData', filters);
});

socket.on('djData', (djs) => {
  console.log('DJ Data received:', djs);  // Verify data reception
  const djResults = elements.djResults;
  djResults.innerHTML = '<table id="djTable"><thead><tr><th>Name</th><th>Country</th><th>Social Media</th><th>Music Styles</th><th>Emails</th></tr></thead><tbody></tbody></table>';
  const tbody = djResults.querySelector('tbody');
  djs.forEach(dj => {
    const tr = document.createElement('tr');

    // Check if the properties are not null or undefined before using them
    const socialMediaUrls = dj.socialMediaUrls ? JSON.parse(dj.socialMediaUrls) : [];
    const socialMediaLinks = socialMediaUrls.map(url => `<a href="${url}" target="_blank">${url}</a>`).join('<br>');

    const countries = dj.country ? JSON.parse(dj.country) : [];
    const countryNames = countries.map(country => country.replace('Home Country ', '')).join(', ');

    const musicStyles = dj.musicStyles ? JSON.parse(dj.musicStyles) : [];
    const musicStylesText = musicStyles.join(', ');

    const emails = dj.emails ? JSON.parse(dj.emails) : [];
    const emailsText = emails.join(', ');

    tr.innerHTML = `
      <td>${dj.name || ''}</td>
      <td>${countryNames}</td>
      <td>${socialMediaLinks}</td>
      <td>${musicStylesText}</td>
      <td>${emailsText}</td>
    `;
    tbody.appendChild(tr);
  });
  console.log('Table populated, initializing DataTable');
  initializeDataTable();  // Initialize the DataTable after data is populated
});


socket.on('updateProgress', (percentage) => {
  const updateProgress = elements.updateProgress;
  updateProgress.style.width = `${percentage}%`;
  updateProgress.textContent = `${percentage}%`;
});

socket.on('updateSearchableDJCount', (count) => {
  elements.searchableDJs.textContent = count;
});

socket.on('djsWithEmailsCount', (count) => {
  elements.djsWithEmailsCount.textContent = count;
});

function initializeDataTable() {
  $('#djTable').DataTable({
    dom: 'Blfrtip',
    buttons: [
      'copy', 'csv', 'excel', 'pdf', 'print'
    ],
    searching: false,
    initComplete: function (settings, json) {
      console.log('DataTable fully initialized and data loaded');
      console.log('LengthMenu:', settings._iDisplayLength, settings.aLengthMenu);
      // Additional setup can be done here
    }
  });
}

document.addEventListener('DOMContentLoaded', (event) => {
  // Display the "Good Things Come To Those That Wait!" text after 1 second, fade in, and disappear after 2 seconds
  setTimeout(() => {
    const waitText = document.getElementById('waitText');
    waitText.style.transition = 'opacity 2s';
    waitText.style.opacity = 1;
    setTimeout(() => {
      waitText.style.transition = 'opacity 1s';
      waitText.style.opacity = 0;
    }, 2000);
  }, 500);

  socket.emit('getDJData', {});  // Request data with any required filters (e.g., an empty object for no filters)
  // Initial load of DJ stats
  socket.emit('getDJStats');
  // Request DJs with emails count
  socket.emit('getDJsWithEmailsCount');
  // Request DJ count every minute
  setInterval(() => {
    socket.emit('requestDJCount');
    socket.emit('getDJsWithEmailsCount');
  }, 60000);  // 60000 ms = 1 minute

  // Hide the loader after data is loaded
  socket.on('djDataLoaded', () => {
    const loaderContainer = document.getElementById('loadingScreen');
    loaderContainer.style.transition = 'opacity 3s';
    loaderContainer.style.opacity = 0;
    setTimeout(() => loaderContainer.style.display = 'none', 3000);
  });
});
