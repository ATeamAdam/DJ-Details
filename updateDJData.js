const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { promisify } = require('util');
const { getDJsToUpdate, updateDJ, recordDJProfileFailure, getSearchableDJCount } = require('./database');
const notifier = require('node-notifier');
const path = require('path');

const sleep = promisify(setTimeout);
let stopSignal = false;
const ELEMENT_TIMEOUT = 60000; // 60 seconds timeout for elements
const profileDelay = Number(process.env.UPDATER_PROFILE_DELAY_MS) || 7000;
const profileScrollDelay = Number(process.env.UPDATER_SCROLL_DELAY_MS) || 2200;
const captchaPollDelay = Number(process.env.UPDATER_CAPTCHA_POLL_MS) || 5000;
const captchaCooldownMs = Number(process.env.UPDATER_CAPTCHA_COOLDOWN_MS) || 300000;
const browserRestartEvery = Math.max(1, Number(process.env.UPDATER_BROWSER_RESTART_EVERY) || 40);
const searchableCountRefreshEvery = Math.max(1, Number(process.env.UPDATER_COUNT_REFRESH_EVERY) || 25);
const chromeProfileDir = process.env.CHROME_PROFILE_DIR ||
  path.join(__dirname, 'chrome-user-data', '1001tracklists');
const chromeWindowMode = (process.env.UPDATER_CHROME_WINDOW_MODE || process.env.SCRAPER_CHROME_WINDOW_MODE || 'minimized').toLowerCase();
let updaterQuietMode = false;

function setUpdaterQuietMode(value) {
  updaterQuietMode = Boolean(value);
}

function getProfileDelay() {
  return updaterQuietMode
    ? Number(process.env.SCHEDULED_UPDATER_PROFILE_DELAY_MS) || Math.max(profileDelay, 12000)
    : profileDelay;
}

function getProfileScrollDelay() {
  return updaterQuietMode
    ? Number(process.env.SCHEDULED_UPDATER_SCROLL_DELAY_MS) || Math.max(profileScrollDelay, 3500)
    : profileScrollDelay;
}

function getCaptchaPollDelay() {
  return updaterQuietMode
    ? Number(process.env.SCHEDULED_UPDATER_CAPTCHA_POLL_MS) || Math.max(captchaPollDelay, 10000)
    : captchaPollDelay;
}

function getCaptchaCooldownMs() {
  return updaterQuietMode
    ? Number(process.env.SCHEDULED_UPDATER_CAPTCHA_COOLDOWN_MS) || Math.max(captchaCooldownMs, 600000)
    : captchaCooldownMs;
}

function jitter(baseMs, spreadMs = 700) {
  const spread = Math.max(0, spreadMs);
  return Math.max(250, baseMs + Math.floor(Math.random() * (spread * 2 + 1)) - spread);
}

async function politeSleep(ms) {
  const endAt = Date.now() + jitter(ms);
  while (!stopSignal && Date.now() < endAt) {
    await sleep(Math.min(250, endAt - Date.now()));
  }
}

function createChromeOptions() {
  const options = new chrome.Options();
  options.addArguments('ignore-certificate-errors');
  options.addArguments('disable-notifications');
  options.addArguments(`--user-data-dir=${chromeProfileDir}`);

  if (chromeWindowMode === 'visible') {
    options.addArguments('start-maximized');
  } else if (chromeWindowMode === 'offscreen') {
    options.addArguments('--window-size=1200,900');
    options.addArguments('--window-position=-32000,-32000');
  } else {
    options.addArguments('--start-minimized');
    options.addArguments('--window-size=1200,900');
  }

  return options;
}

async function keepBrowserInBackground(driver) {
  if (chromeWindowMode !== 'minimized') return;

  try {
    await driver.manage().window().minimize();
  } catch (error) {
    console.warn(`Unable to minimize updater Chrome window: ${error.message}`);
  }
}

async function createChromeDriver() {
  const options = createChromeOptions();
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  await keepBrowserInBackground(driver);
  return driver;
}

async function quitChromeDriver(driver, io, reason) {
  if (!driver) return;

  try {
    await driver.quit();
    if (reason) {
      io.emit('updaterOutput', reason);
    }
  } catch (error) {
    console.warn(`Unable to close updater Chrome window: ${error.message}`);
    io.emit('updaterOutput', `Unable to close updater Chrome window: ${error.message}`);
  }
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function cleanStringArray(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  ));
}

function buildProfileFieldValue(existingValue, extractedValues) {
  const cleanExtracted = cleanStringArray(extractedValues);
  if (cleanExtracted.length > 0) {
    return JSON.stringify(cleanExtracted);
  }

  const existingValues = cleanStringArray(parseJsonArray(existingValue));
  if (existingValues.length > 0) {
    return JSON.stringify(existingValues);
  }

  return JSON.stringify([]);
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
  const cooldownMs = getCaptchaCooldownMs();
  const seconds = Math.round(cooldownMs / 1000);
  io.emit('updaterOutput', `Access challenge detected. Cooling down for ${seconds} seconds before continuing.`);

  const startedAt = Date.now();
  while (!stopSignal && Date.now() - startedAt < cooldownMs) {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, Math.ceil((cooldownMs - elapsed) / 1000));
    if (remaining > 0 && remaining % 60 === 0) {
      io.emit('updaterOutput', `Cooldown still active. About ${remaining} seconds remaining.`);
    }
    await politeSleep(Math.min(10000, Math.max(1000, cooldownMs - elapsed)));
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
      await politeSleep(getProfileDelay());
      break;
    }
    await politeSleep(getCaptchaPollDelay());
  }
}

async function checkForCaptcha(driver, io) {
  if (stopSignal) return;
  if (await detectAccessChallenge(driver)) {
    await waitForCaptchaToBeSolved(driver, io);
  }
}

async function scrollToBottom(driver, io) {
  let lastHeight = await driver.executeScript('return document.body.scrollHeight');
  let isInitialScroll = true;
  while (true) {
    if (stopSignal) break;
    if (isInitialScroll) {
      io.emit('updaterOutput', `Scrolling to the bottom of the page...`);
      isInitialScroll = false;
    }
    await driver.executeScript('window.scrollBy(0, Math.floor(window.innerHeight * 0.8));');
    await politeSleep(getProfileScrollDelay());
    if (stopSignal) break;
    await checkForCaptcha(driver, io);
    if (stopSignal) break;

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
    if (stopSignal) return { country, socialMediaUrls, musicStyles };
    await driver.wait(until.elementLocated(By.css('body')), ELEMENT_TIMEOUT);
    await politeSleep(1000);

    await scrollToBottom(driver, io);
    if (stopSignal) return { country, socialMediaUrls, musicStyles };

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
      await politeSleep(getProfileDelay());
    }
  }
}

async function processDJ(dj, driver, io) {
  try {
    if (stopSignal) return false;
    const { country, socialMediaUrls, musicStyles } = await fetchDJDataWithRetries(dj, driver, io);
    if (stopSignal) return false;

    await updateDJ(
      dj.id,
      buildProfileFieldValue(dj.country, country),
      buildProfileFieldValue(dj.socialMediaUrls, socialMediaUrls),
      buildProfileFieldValue(dj.musicStyles, musicStyles)
    );
    console.log(`Updated DJ: ${dj.name}`);
    io.emit('updaterOutput', `Updated DJ: ${dj.name}`);
    return true;

  } catch (error) {
    console.error(`Failed to process DJ: ${dj.name} - ${error.message}`);
    io.emit('updaterError', `Failed to process DJ: ${dj.name} - ${error.message}`);
    try {
      const failure = await recordDJProfileFailure(dj.id, error.message);
      io.emit('updaterOutput', `Will retry ${dj.name} after ${failure.profileRetryAfter} (failure ${failure.profileFailureCount}).`);
    } catch (failureError) {
      io.emit('updaterError', `Unable to record profile failure for ${dj.name}: ${failureError.message}`);
    }
    return false;
  } finally {
    try {
      await driver.close();
    } catch (error) {
      console.warn(`Unable to close updater tab for ${dj.name}: ${error.message}`);
    }
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

  let driver = null;
  let processedWithCurrentDriver = 0;

  const ensureDriver = async () => {
    if (driver && processedWithCurrentDriver < browserRestartEvery) {
      return driver;
    }

    if (driver) {
      await quitChromeDriver(driver, io, `Restarted updater Chrome after ${processedWithCurrentDriver} DJs to clear browser memory.`);
    }

    driver = await createChromeDriver();
    processedWithCurrentDriver = 0;
    return driver;
  };

  try {
    while (currentDJIndex < totalDJs && !stopSignal) {
      const dj = djs[currentDJIndex++];
      const activeDriver = await ensureDriver();
      console.log(`Fetching data for DJ: ${dj.name}`);
      io.emit('updaterOutput', `Fetching data for DJ: ${dj.name}`);

      await activeDriver.executeScript('window.open("about:blank", "_blank");');
      const handles = await activeDriver.getAllWindowHandles();
      const mainHandle = handles[0];
      const newTabHandle = handles[handles.length - 1];
      await activeDriver.switchTo().window(newTabHandle);

      await processDJ(dj, activeDriver, io);
      processedDJs++;
      processedWithCurrentDriver++;
      const progress = Math.round((processedDJs / totalDJs) * 100);
      io.emit('updateProgress', progress);

      const remainingHandles = await activeDriver.getAllWindowHandles();
      if (remainingHandles.includes(mainHandle)) {
        await activeDriver.switchTo().window(mainHandle);
      } else if (remainingHandles.length > 0) {
        await activeDriver.switchTo().window(remainingHandles[0]);
      }

      if (processedDJs % searchableCountRefreshEvery === 0 || processedDJs === totalDJs) {
        const searchableDJCount = await getSearchableDJCount();
        io.emit('updateSearchableDJCount', searchableDJCount);
      }

      await politeSleep(getProfileDelay());
    }
  } finally {
    await quitChromeDriver(driver, io);
  }

  if (stopSignal) {
    io.emit('updaterStopped', 'Updater has been stopped.');
    return;
  }

  io.emit('updaterComplete', 'Updater completed successfully.');
}

function setShouldStopUpdater(value) {
  stopSignal = value;
}

module.exports = { updateAllDJs, setShouldStopUpdater, setUpdaterQuietMode };
