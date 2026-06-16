const axios = require('axios');
const { updateDJ } = require('./database');
const moment = require('moment');

let shouldStopScraping = false;

const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function parseJsonValue(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function mergeEmailData(existingEmails, existingSources, newEmails, newSources) {
  const mergedEmails = Array.from(new Set([
    ...(Array.isArray(existingEmails) ? existingEmails : []),
    ...(Array.isArray(newEmails) ? newEmails : [])
  ].map(email => String(email || '').trim().toLowerCase()).filter(Boolean)));

  const mergedSources = {
    ...(existingSources && typeof existingSources === 'object' && !Array.isArray(existingSources) ? existingSources : {})
  };

  for (const [email, urls] of Object.entries(newSources || {})) {
    const normalisedEmail = String(email || '').trim().toLowerCase();
    if (!normalisedEmail) continue;

    const existingUrls = Array.isArray(mergedSources[normalisedEmail])
      ? mergedSources[normalisedEmail]
      : [];
    mergedSources[normalisedEmail] = Array.from(new Set([
      ...existingUrls,
      ...(Array.isArray(urls) ? urls : [])
    ].map(url => String(url || '').trim()).filter(Boolean)));
  }

  return { emails: mergedEmails, emailSources: mergedSources };
}

async function scrapeEmails(urls, io, dj) {
  let emails = [];
  const emailSources = {};
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
        foundEmails = foundEmails
          .filter(email => !email.endsWith('.png'))
          .map(email => email.toLowerCase());

        for (const email of foundEmails) {
          if (!emailSources[email]) {
            emailSources[email] = [];
          }
          if (!emailSources[email].includes(url)) {
            emailSources[email].push(url);
          }
        }

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

  return {
    emails: [...new Set(emails)],
    emailSources
  };
}

async function processDJsForEmails(djs, io) {
  const today = moment();
  const totalDJs = djs.length;
  let processedDJs = 0;

  console.log(`Starting email scraping for ${totalDJs} DJs`);
  io.emit('emailScrapingStarted', `Starting email scraping for ${totalDJs} DJs`);

  for (const dj of djs) {
    if (shouldStopScraping) break;

    const rawEmailUpdatedAt = dj.emailsUpdatedAt || dj.lastUpdated;
    const lastUpdatedDate = rawEmailUpdatedAt ? moment(rawEmailUpdatedAt) : null;
    const daysSinceUpdate = lastUpdatedDate && lastUpdatedDate.isValid()
      ? today.diff(lastUpdatedDate, 'days')
      : Infinity;

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

      const { emails, emailSources } = await scrapeEmails(urls, io, dj);
      const existingEmails = parseJsonValue(dj.emails, []);
      const existingEmailSources = parseJsonValue(dj.emailSources, {});
      const mergedEmailData = mergeEmailData(
        existingEmails,
        existingEmailSources,
        emails,
        emailSources
      );

      await updateDJ(
        dj.id,
        null,
        null,
        null,
        JSON.stringify(mergedEmailData.emails),
        JSON.stringify(mergedEmailData.emailSources)
      );

      const saveLogMessage = `Emails saved for ${dj.name}: ${mergedEmailData.emails.join(', ')}`;
      console.log(saveLogMessage);
      io.emit('emailsSaved', { dj: dj.name, emails: mergedEmailData.emails });
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
}

function setShouldStopScraping(value) {
  shouldStopScraping = value;
}

function startEmailScraping(djs, io) {
  shouldStopScraping = false;  // Reset the stop signal
  io.emit('emailScrapingStarted', 'Email scraping started.');
  return processDJsForEmails(djs, io);
}

module.exports = {
  scrapeEmails,
  processDJsForEmails,
  setShouldStopScraping,
  startEmailScraping
};
