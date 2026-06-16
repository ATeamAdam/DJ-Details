const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { promisify } = require('util');
const { getDJsToUpdate, updateDJ, getSearchableDJCount } = require('./database');
const notifier = require('node-notifier');
const path = require('path');

const sleep = promisify(setTimeout);
let stopSignal = false;
const MAX_CONCURRENT_INSTANCES = 1; // Keep this single-browser so Chrome can reuse the same 1001 session safely
const ELEMENT_TIMEOUT = 60000; // 60 seconds timeout for elements
const profileDelay = Number(process.env.UPDATER_PROFILE_DELAY_MS) || 7000;
const profileScrollDelay = Number(process.env.UPDATER_SCROLL_DELAY_MS) || 2200;
const captchaPollDelay = Number(process.env.UPDATER_CAPTCHA_POLL_MS) || 5000;
const captchaCooldownMs = Number(process.env.UPDATER_CAPTCHA_COOLDOWN_MS) || 300000;
const chromeProfileDir = process.env.CHROME_PROFILE_DIR ||
  path.join(__dirname, 'chrome-user-data', '1001tracklists');

function jitter(baseMs, spreadMs = 700) {
  const spread = Math.max(0, spreadMs);
  return Math.max(250, baseMs + Math.floor(Math.random() * (spread * 2 + 1)) - spread);
}

async function politeSleep(ms) {
  await sleep(jitter(ms));
}

function createChromeOptions() {
  const options = new chrome.Options();
  options.addArguments('ignore-certificate-errors');
  options.addArguments('start-maximized');
  options.addArguments('disable-notifications');
  options.addArguments(`--user-data-dir=${chromeProfileDir}`);
  return options;
}

async function detectAccessChallenge(driver) {
  try {
    return await driver.executeScript(`
      const text = ((document.body && document.body.innerText) || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      const challengeElement = document.querySelector(
        'img[alt*="Captcha"], iframe[src*="captcha"], iframe[title*="captcha"], input[name*="captcha"], textarea[name*="g-recaptcha-response"]'
      );
      return Boolean(
        challengeElement ||
        text.includes('captcha') ||
        title.includes('captcha') ||
        (text.includes('please wait') && text.includes('forwarded')) ||
        text.includes('checking your browser') ||
        text.includes('just a moment')
      );
    `);
  } catch (error) {
    return false;
  }
}

async function cooldownAfterChallenge(io) {
  const seconds = Math.round(captchaCooldownMs / 1000);
  io.emit('updaterOutput', `Access challenge detected. Cooling down for ${seconds} seconds before continuing.`);

  const startedAt = Date.now();
  while (!stopSignal && Date.now() - startedAt < captchaCooldownMs) {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, Math.ceil((captchaCooldownMs - elapsed) / 1000));
    if (remaining > 0 && remaining % 60 === 0) {
      io.emit('updaterOutput', `Cooldown still active. About ${remaining} seconds remaining.`);
    }
    await sleep(Math.min(10000, Math.max(1000, captchaCooldownMs - elapsed)));
  }
}

async function waitForCaptchaToBeSolved(driver, io) {
  console.log("Access challenge detected. Please solve it manually in the browser if needed...");
  io.emit('updaterOutput', `Access challenge detected. Please solve it manually in the browser if needed...`);

  notifier.notify({
    title: 'CAPTCHA Detected',
    message: 'Please solve the CAPTCHA manually in the browser.',
    sound: true
  });

  await cooldownAfterChallenge(io);

  while (!stopSignal) {
    const stillChallenged = await detectAccessChallenge(driver);
    if (!stillChallenged) {
      console.log("Access challenge cleared. Resuming gently...");
      io.emit('updaterOutput', `Access challenge cleared. Resuming gently...`);
      await politeSleep(profileDelay);
      break;
    }
    await sleep(captchaPollDelay);
  }
}

async function checkForCaptcha(driver, io) {
  if (await detectAccessChallenge(driver)) {
    await waitForCaptchaToBeSolved(driver, io);
  }
}

async function scrollToBottom(driver, io) {
  let lastHeight = await driver.executeScript('return document.body.scrollHeight');
  let isInitialScroll = true;
  while (true) {
    if (isInitialScroll) {
      io.emit('updaterOutput', `Scrolling to the bottom of the page...`);
      isInitialScroll = false;
    }
    await driver.executeScript('window.scrollBy(0, Math.floor(window.innerHeight * 0.8));');
    await politeSleep(profileScrollDelay);
    await checkForCaptcha(driver, io);

    const scrollState = await driver.executeScript(`
      return {
        height: document.body.scrollHeight,
        bottom: window.scrollY + window.innerHeight
      };
    `);
    const newHeight = scrollState.height;
    const nearBottom = scrollState.bottom >= newHeight - 300;
    if (newHeight === lastHeight && nearBottom) {
      break;
    }
    lastHeight = newHeight;
  }
}

async function getDJData(driver, url, io) {
  let country = [];
  let socialMediaUrls = [];
  let musicStyles = [];

  try {
    await driver.get(url);
    await checkForCaptcha(driver, io);
    await driver.wait(until.elementsLocated(By.css('img.flag, div.cRow a')), ELEMENT_TIMEOUT);

    await scrollToBottom(driver, io);

    const flagElements = await driver.findElements(By.css('img.flag'));
    for (let element of flagElements) {
      const title = await element.getAttribute('title');
      if (title) {
        country.push(title);
      }
    }

    const cRowElements = await driver.findElements(By.css('div.cRow a'));
    for (let element of cRowElements) {
      const href = await element.getAttribute('href');
      if (href) {
        socialMediaUrls.push(href);
      }
    }

    const musicStyleElements = await driver.findElements(By.css('div[title="musicstyle(s)"]'));
    for (let element of musicStyleElements) {
      const styles = await element.getText();
      if (styles) {
        musicStyles.push(...styles.split(',').map(style => style.trim()));
      }
    }
    musicStyles = [...new Set(musicStyles)];

  } catch (error) {
    console.error(`Error fetching DJ data from ${url}:`, error.message);
    throw error;
  }

  return { country, socialMediaUrls, musicStyles };
}

async function fetchDJDataWithRetries(dj, driver, io) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      io.emit('updaterOutput', `Attempt ${attempt} - Fetching data for DJ: ${dj.name}`);
      return await getDJData(driver, dj.url, io);
    } catch (error) {
      console.error(`Attempt ${attempt} - Error fetching DJ data for ${dj.name}:`, error.message);
      io.emit('updaterError', `Attempt ${attempt} - Error fetching DJ data for ${dj.name}: ${error.message}`);
      if (attempt === 3) throw error;
      await politeSleep(profileDelay);
    }
  }
}

async function processDJ(dj, driver, io) {
  try {
    const { country, socialMediaUrls, musicStyles } = await fetchDJDataWithRetries(dj, driver, io);
    await updateDJ(dj.id, JSON.stringify(country), JSON.stringify(socialMediaUrls), JSON.stringify(musicStyles));
    console.log(`Updated DJ: ${dj.name}`);
    io.emit('updaterOutput', `Updated DJ: ${dj.name}`);

    // Emit the updated searchable DJ count
    const searchableDJCount = await getSearchableDJCount();
    io.emit('updateSearchableDJCount', searchableDJCount);

  } catch (error) {
    console.error(`Failed to process DJ: ${dj.name} - ${error.message}`);
    io.emit('updaterError', `Failed to process DJ: ${dj.name} - ${error.message}`);
  } finally {
    // Close the tab
    await driver.close();
  }
}

async function updateAllDJs(io) {
  stopSignal = false;
  const djs = await getDJsToUpdate();
  const totalDJs = djs.length;
  let currentDJIndex = 0;
  let processedDJs = 0;

  if (totalDJs === 0) {
    io.emit('updateProgress', 100);
    io.emit('updaterComplete', 'Updater completed successfully. No DJs needed updating.');
    return;
  }

  const drivers = [];
  const activeInstances = Math.min(Math.max(1, MAX_CONCURRENT_INSTANCES), totalDJs);
  for (let i = 0; i < activeInstances; i++) {
    const options = createChromeOptions();
    const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
    drivers.push(driver);
  }

  const processNextDJ = async (driver) => {
    while (currentDJIndex < totalDJs && !stopSignal) {
      const dj = djs[currentDJIndex++];
      console.log(`Fetching data for DJ: ${dj.name}`);
      io.emit('updaterOutput', `Fetching data for DJ: ${dj.name}`);

      await driver.executeScript('window.open("about:blank", "_blank");');
      const handles = await driver.getAllWindowHandles();
      const newTabHandle = handles[handles.length - 1];
      await driver.switchTo().window(newTabHandle);

      await processDJ(dj, driver, io);
      processedDJs++;
      const progress = Math.round((processedDJs / totalDJs) * 100);
      io.emit('updateProgress', progress);

      await driver.switchTo().window(handles[0]); // Switch back to the main window
      await politeSleep(profileDelay);
    }
  };

  const promises = drivers.map(driver => processNextDJ(driver));
  await Promise.all(promises);

  for (const driver of drivers) {
    await driver.quit();
  }

  io.emit('updaterComplete', 'Updater completed successfully.');
}

function setShouldStopUpdater(value) {
  stopSignal = value;
}

module.exports = { updateAllDJs, setShouldStopUpdater };
