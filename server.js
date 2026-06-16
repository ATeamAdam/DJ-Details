const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { scrapeAllDJs, setShouldStopScraper } = require('./scraper');
const { updateAllDJs, setShouldStopUpdater } = require('./updateDJData');
const { startEmailScraping, setShouldStopScraping } = require('./scrapeEmails');
const { getDJsWithEmailsCount, getAllDJs, getDJCount, getSearchableDJCount } = require('./database');

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

io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('startScraper', async (startLetter) => {
    if (!scraperRunning) {
      scraperRunning = true;
      try {
        scraperProcess = scrapeAllDJs(startLetter, io);
        await scraperProcess;
        socket.emit('scraperComplete', 'Scraper completed successfully.');
      } catch (err) {
        socket.emit('scraperError', `Scraper exited with error: ${err.message}`);
      } finally {
        scraperRunning = false;
      }
    }
  });

  socket.on('stopScraper', () => {
    if (scraperRunning && scraperProcess) {
      setShouldStopScraper(true);
      scraperRunning = false;
      socket.emit('scraperStopped', 'Scraper has been stopped.');
    }
  });

  socket.on('startUpdater', async () => {
    if (!updaterRunning) {
      updaterRunning = true;
      try {
        updaterProcess = updateAllDJs(io);
        await updaterProcess;
        socket.emit('updaterComplete', 'Updater completed successfully.');
      } catch (err) {
        socket.emit('updaterError', `Updater exited with error: ${err.message}`);
      } finally {
        updaterRunning = false;
      }
    }
  });

  socket.on('stopUpdater', () => {
    if (updaterRunning && updaterProcess) {
      setShouldStopUpdater(true);
      updaterRunning = false;
      socket.emit('updaterStopped', 'Updater has been stopped.');
    }
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
      startEmailScraping(djs, io); // Use startEmailScraping instead of processDJsForEmails
    } catch (error) {
      console.error('Error filtering DJs for emails:', error.message);
      socket.emit('emailScrapingStarted', `Error filtering DJs for emails: ${error.message}`);
    }
  });

  socket.on('startEmailScraping', async () => {
    if (!emailScrapingRunning) {
      emailScrapingRunning = true;
      try {
        const djs = await getAllDJs();
        startEmailScraping(djs, io);
        socket.emit('emailScrapingStarted', 'Email scraping started.');
      } catch (err) {
        socket.emit('emailScrapingError', `Email scraping exited with error: ${err.message}`);
        emailScrapingRunning = false;
      }
    }
  });
  
  socket.on('stopEmailScraping', () => {
    emailScrapingRunning = true;
    if (emailScrapingRunning) {
      setShouldStopScraping(true);
      emailScrapingRunning = false;
      socket.emit('emailScrapingStopped', 'Email scraping has been stopped.');
    }
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
});
