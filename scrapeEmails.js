const axios = require('axios');
const { updateDJ, getAllDJs } = require('./database');
const moment = require('moment');

let shouldStopScraping = false;

const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

async function scrapeEmails(urls, io, dj) {
  let emails = [];
  const totalUrls = urls.length;

  for (let i = 0; i < totalUrls; i++) {
    if (shouldStopScraping) break;
    const url = urls[i];
    if (url.includes('google.com')) continue;

    const logMessage = `Currently scraping URL: ${url}`;
    console.log(logMessage);
    io.emit('emailSearchOutput', logMessage);
    io.emit('scraperStatus', { currentDJ: dj.name, currentURL: url });

    try {
      const response = await axios.get(url);
      let foundEmails = response.data.match(emailRegex);
      if (foundEmails) {
        // Filter out emails ending with .png
        foundEmails = foundEmails.filter(email => !email.endsWith('.png'));
        emails = emails.concat(foundEmails);
        const foundLogMessage = `Found emails for ${dj.name}: ${foundEmails.join(', ')}`;
        console.log(foundLogMessage);
        io.emit('emailsFound', { dj: dj.name, url, emails: foundEmails });
        io.emit('emailSearchOutput', foundLogMessage);
      }
    } catch (error) {
      const errorMessage = `Error scraping ${url}: ${error.message}`;
      console.error(errorMessage);
      io.emit('emailSearchOutput', errorMessage);
    }

    const progress = Math.round(((i + 1) / totalUrls) * 100);
    io.emit('scrapingProgress', progress);
    const progressLogMessage = `Progress: ${progress}% (${i + 1}/${totalUrls})`;
    console.log(progressLogMessage);
    io.emit('emailSearchOutput', progressLogMessage);
  }

  return [...new Set(emails)];  // Remove duplicate emails
}

async function processDJsForEmails(djs, io) {
  const today = moment();
  const totalDJs = djs.length;
  let processedDJs = 0;

  console.log(`Starting email scraping for ${totalDJs} DJs`);
  io.emit('emailScrapingStarted', `Starting email scraping for ${totalDJs} DJs`);

  for (const dj of djs) {
    if (shouldStopScraping) break;

    const lastUpdatedDate = moment(dj.lastUpdated);
    const daysSinceUpdate = today.diff(lastUpdatedDate, 'days');

    if (daysSinceUpdate < 90 && dj.emails) {
      const skipMessage = `Skipping ${dj.name}: updated less than 90 days ago`;
      console.log(skipMessage);
      //io.emit('emailScrapingStarted', skipMessage);
      continue;
    }

    if (dj.socialMediaUrls) {
      const urls = JSON.parse(dj.socialMediaUrls);
      const processLogMessage = `Processing DJ: ${dj.name} with ${urls.length} URLs`;
      console.log(processLogMessage);
      io.emit('emailScrapingStarted', processLogMessage);

      const emails = await scrapeEmails(urls, io, dj);
      await updateDJ(dj.id, dj.country, dj.socialMediaUrls, dj.musicStyles, JSON.stringify(emails));

      const saveLogMessage = `Emails saved for ${dj.name}: ${emails.join(', ')}`;
      console.log(saveLogMessage);
      io.emit('emailsSaved', { dj: dj.name, emails });
      //io.emit('emailScrapingStarted', saveLogMessage);
    }

    processedDJs++;
    const progress = Math.round((processedDJs / totalDJs) * 100);
    const processedLogMessage = `Processed DJs: ${processedDJs}/${totalDJs} (${progress}%)`;
    console.log(processedLogMessage);
    io.emit('scrapingProgress', progress);
    io.emit('emailSearchOutput', processedLogMessage);
  }

  const completeMessage = 'Email scraping complete';
  console.log(completeMessage);
  io.emit('scrapingComplete', completeMessage);
}

function setShouldStopScraping(value) {
  shouldStopScraping = value;
}

function startEmailScraping(djs, io) {
  shouldStopScraping = false;  // Reset the stop signal
  processDJsForEmails(djs, io).then(() => {
    io.emit('emailScrapingStarted', 'Email scraping started.');  // Emit when the process starts
  });
}

module.exports = {
  scrapeEmails,
  processDJsForEmails,
  setShouldStopScraping,
  startEmailScraping
};
