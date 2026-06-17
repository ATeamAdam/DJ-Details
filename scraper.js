const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const readline = require('readline');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { insertDJ, checkDJExists, getDJCount } = require('./database');
const notifier = require('node-notifier');
const path = require('path');
const { promises: fsp } = require('fs');

const baseUrl = 'https://www.1001tracklists.com/djs/';
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const crawlDelay = Number(process.env.SCRAPER_CRAWL_DELAY_MS) || 8000;
const scrollDelay = Number(process.env.SCRAPER_SCROLL_DELAY_MS) || 1800;
const captchaPollDelay = Number(process.env.SCRAPER_CAPTCHA_POLL_MS) || 5000;
const captchaCooldownMs = Number(process.env.SCRAPER_CAPTCHA_COOLDOWN_MS) || 300000;
const batchSize = 50;
const chromeProfileDir = process.env.CHROME_PROFILE_DIR ||
  path.join(__dirname, 'chrome-user-data', '1001tracklists');
const scraperProgressFile = process.env.SCRAPER_PROGRESS_FILE ||
  path.join(__dirname, 'scraper-progress.json');
const chromeWindowSize = process.env.SCRAPER_CHROME_WINDOW_SIZE || '1200,900';
const chromeWindowPosition = process.env.SCRAPER_CHROME_WINDOW_POSITION || '1600,80';

const sleep = promisify(setTimeout);
const execFileAsync = promisify(execFile);
let shouldStopScraper = false;
let scraperQuietMode = false;

function setShouldStopScraper(value) {
  shouldStopScraper = value;
}

function setScraperQuietMode(value) {
  scraperQuietMode = Boolean(value);
}

function getCrawlDelay() {
  return scraperQuietMode
    ? Number(process.env.SCHEDULED_SCRAPER_CRAWL_DELAY_MS) || Math.max(crawlDelay, 12000)
    : crawlDelay;
}

function getScrollDelay() {
  return scraperQuietMode
    ? Number(process.env.SCHEDULED_SCRAPER_SCROLL_DELAY_MS) || Math.max(scrollDelay, 3000)
    : scrollDelay;
}

function getCaptchaPollDelay() {
  return scraperQuietMode
    ? Number(process.env.SCHEDULED_SCRAPER_CAPTCHA_POLL_MS) || Math.max(captchaPollDelay, 10000)
    : captchaPollDelay;
}

function getCaptchaCooldownMs() {
  return scraperQuietMode
    ? Number(process.env.SCHEDULED_SCRAPER_CAPTCHA_COOLDOWN_MS) || Math.max(captchaCooldownMs, 600000)
    : captchaCooldownMs;
}

function jitter(baseMs, spreadMs = 600) {
  const spread = Math.max(0, spreadMs);
  return Math.max(250, baseMs + Math.floor(Math.random() * (spread * 2 + 1)) - spread);
}

async function politeSleep(ms) {
  const endAt = Date.now() + jitter(ms);
  while (!shouldStopScraper && Date.now() < endAt) {
    await sleep(Math.min(250, endAt - Date.now()));
  }
}

function scraperWasStopped(io) {
  if (!shouldStopScraper) return false;
  if (io && typeof io.emit === 'function') {
    io.emit('scraperStopped', 'Scraper has been stopped.');
  }
  return true;
}

function createChromeOptions() {
  const options = new chrome.Options();
  options.addArguments('ignore-certificate-errors');
  options.addArguments('disable-notifications');
  options.addArguments(`--user-data-dir=${chromeProfileDir}`);
  options.addArguments(`--window-size=${chromeWindowSize}`);
  options.addArguments(`--window-position=${chromeWindowPosition}`);

  return options;
}

async function createChromeDriver() {
  const options = createChromeOptions();
  return new Builder().forBrowser('chrome').setChromeOptions(options).build();
}

async function cleanupStaleScraperChrome(io) {
  if (process.platform !== 'win32') {
    return;
  }

  const command = `
$targetProfile = [System.IO.Path]::GetFullPath($args[0])
$matches = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains($targetProfile)
}
$closed = 0
foreach ($process in $matches) {
  try {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    $closed++
  } catch {
  }
}
Write-Output $closed
`;

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command,
        chromeProfileDir
      ],
      {
        timeout: 10000,
        windowsHide: true
      }
    );
    const closed = Number(String(stdout || '').trim().split(/\s+/).pop() || 0);
    if (closed > 0 && io && typeof io.emit === 'function') {
      io.emit('scraperOutput', `Closed ${closed} stale scraper Chrome process${closed === 1 ? '' : 'es'} before starting the next browser.`);
    }
  } catch (error) {
    console.warn(`Unable to clean up stale scraper Chrome processes: ${error.message}`);
    if (io && typeof io.emit === 'function') {
      io.emit('scraperOutput', `Unable to clean up stale scraper Chrome processes: ${error.message}`);
    }
  }
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

async function cooldownAfterChallenge(io, channel) {
  const cooldownMs = getCaptchaCooldownMs();
  const seconds = Math.round(cooldownMs / 1000);
  io.emit(channel, `Access challenge detected. Cooling down for ${seconds} seconds before continuing.`);

  const startedAt = Date.now();
  while (!shouldStopScraper && Date.now() - startedAt < cooldownMs) {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, Math.ceil((cooldownMs - elapsed) / 1000));
    if (remaining > 0 && remaining % 60 === 0) {
      io.emit(channel, `Cooldown still active. About ${remaining} seconds remaining.`);
    }
    await politeSleep(Math.min(10000, Math.max(1000, cooldownMs - elapsed)));
  }
}

async function writeScraperCheckpoint(payload) {
  try {
    await fsp.writeFile(scraperProgressFile, JSON.stringify({
      ...payload,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (error) {
    console.error(`Unable to write scraper checkpoint: ${error.message}`);
  }
}

async function readScraperCheckpoint() {
  try {
    const raw = await fsp.readFile(scraperProgressFile, 'utf8');
    const checkpoint = JSON.parse(raw);
    const nextLetter = String(checkpoint.nextLetter || '').toLowerCase();
    return alphabet.includes(nextLetter) ? checkpoint : null;
  } catch (error) {
    return null;
  }
}

async function resolveStartLetter(startLetter) {
  const requested = String(startLetter || '').trim().toLowerCase();
  const checkpoint = await readScraperCheckpoint();

  if ((requested === '' || requested === 'resume') && checkpoint?.nextLetter) {
    return checkpoint.nextLetter;
  }

  if (requested === '' || requested === 'resume') {
    return 'a';
  }

  if (process.env.SCRAPER_AUTO_RESUME === '1' && checkpoint?.nextLetter) {
    const requestedIndex = alphabet.indexOf(requested);
    const checkpointIndex = alphabet.indexOf(checkpoint.nextLetter);
    if (requestedIndex === -1 || checkpointIndex > requestedIndex) {
      return checkpoint.nextLetter;
    }
  }

  return requested;
}

async function waitForCaptchaToBeSolved(driver, io) {
  console.log("Access challenge detected. Please solve it manually in the browser if needed...");
  io.emit('scraperOutput', 'Access challenge detected. Please solve it manually in the browser if needed...');
  
  // Send a notification with sound
  notifier.notify({
    title: 'CAPTCHA Detected',
    message: 'Please solve the CAPTCHA manually in the browser.',
    sound: true
  });

  await cooldownAfterChallenge(io, 'scraperOutput');

  while (!shouldStopScraper) {
    const stillChallenged = await detectAccessChallenge(driver);
    if (!stillChallenged) {
      console.log("Access challenge cleared. Resuming gently...");
      io.emit('scraperOutput', 'Access challenge cleared. Resuming gently...');
      await politeSleep(getCrawlDelay());
      break;
    }
    await politeSleep(getCaptchaPollDelay());
  }
}

async function checkForCaptcha(driver, io) {
  if (scraperWasStopped(io)) return;
  if (await detectAccessChallenge(driver)) {
    await waitForCaptchaToBeSolved(driver, io);
  }
}

async function checkForPageNotExist(driver) {
  const pageNotExistElement = await driver.findElements(By.xpath("//*[contains(text(), 'Sorry, that page does not exist')]"));
  return pageNotExistElement.length > 0;
}

async function processDJElementsOnPage(driver, io, state) {
  if (scraperWasStopped(io)) return 0;
  const djElements = await driver.findElements(By.css('div.bTitle a'));

  for (const element of djElements) {
    if (scraperWasStopped(io)) break;

    let djName = '';
    let djUrl = '';

    try {
      djName = await element.getText();
      djUrl = await element.getAttribute('href');
    } catch (error) {
      continue;
    }

    if (!djName || !djUrl) {
      continue;
    }

    const djKey = `${djName}|${djUrl}`;
    if (state.seenDJs.has(djKey)) {
      continue;
    }

    state.seenDJs.add(djKey);

    try {
      const exists = await checkDJExists(djName, djUrl);
      if (!exists) {
        await insertDJ(djName, djUrl);
        state.newDJCount++;
        if (state.runTotals) {
          state.runTotals.newDJCount++;
        }
        console.log(`Inserted new DJ: ${djName}`);
        io.emit('scraperOutput', `Inserted new DJ: ${djName}`);
      } else {
        console.log(`DJ already exists: ${djName}`);
      }
    } catch (err) {
      console.error(`Error processing DJ: ${djName} - ${err.message}`);
      io.emit('scraperError', `Error processing DJ: ${djName} - ${err.message}`);
    } finally {
      state.processedCount++;
      if (state.runTotals) {
        state.runTotals.processedCount++;
      }
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(`Processed: ${state.processedCount}, New: ${state.newDJCount}`);
      io.emit('scraperStatus', {
        processedCount: state.processedCount,
        newDJCount: state.newDJCount,
        runProcessedCount: state.runTotals ? state.runTotals.processedCount : state.processedCount,
        runNewDJCount: state.runTotals ? state.runTotals.newDJCount : state.newDJCount,
        currentDJ: djName,
        currentURL: djUrl
      });
    }
  }

  return djElements.length;
}

async function scrollToBottom(driver, io, onDjBatch = null) {
  let lastHeight = await driver.executeScript('return document.body.scrollHeight');
  let retries = 0;
  const maxRetries = 10;
  let initialScroll = true;

  while (true) {
    if (scraperWasStopped(io)) break;

    if (initialScroll) {
      io.emit('scraperOutput', 'Scrolling to the bottom of the page...');
      initialScroll = false;
    }

    if (typeof onDjBatch === 'function') {
      await onDjBatch();
    }

    await driver.executeScript('window.scrollBy(0, Math.floor(window.innerHeight * 0.85));');
    await politeSleep(getScrollDelay());
    if (scraperWasStopped(io)) break;
    await checkForCaptcha(driver, io);
    if (scraperWasStopped(io)) break;

    if (typeof onDjBatch === 'function') {
      await onDjBatch();
    }

    const scrollState = await driver.executeScript(`
      return {
        height: document.body.scrollHeight,
        bottom: window.scrollY + window.innerHeight
      };
    `);
    const newHeight = scrollState.height;
    const nearBottom = scrollState.bottom >= newHeight - 300;
    const noMoreItemsMessage = await driver.findElements(By.xpath("//*[contains(text(), 'No more items found')]"));

    if (newHeight === lastHeight) {
      if (nearBottom) {
        retries++;
        if (retries % 5 === 0) {
          console.log("No new content loaded, retrying...");
          io.emit('scraperOutput', 'No new content loaded, retrying...');
        }
        await driver.executeScript('window.scrollBy(0, -120);');
        await politeSleep(4000);
        if (scraperWasStopped(io)) break;
        if (typeof onDjBatch === 'function') {
          await onDjBatch();
        }
      } else {
        retries = 0;
      }
    } else {
      retries = 0;
    }

    lastHeight = newHeight;

    if (noMoreItemsMessage.length > 0) {
      console.log("Reached the bottom of the page. No more items found.");
      io.emit('scraperOutput', 'Reached the bottom of the page. No more items found.');
      break;
    }

    if (retries >= maxRetries) {
      console.log("Stuck for too long, moving on...");
      io.emit('scraperOutput', 'Stuck for too long, moving on...');
      break;
    }
  }
}

async function waitForDJElements(driver) {
  if (shouldStopScraper) return;
  await driver.wait(until.elementsLocated(By.css('div.bTitle a')), 30000);
  if (shouldStopScraper) return;
  const djElements = await driver.findElements(By.css('div.bTitle a'));
  if (djElements.length > 0) {
    await driver.executeScript('arguments[0].scrollIntoView()', djElements[djElements.length - 1]);
    await politeSleep(getScrollDelay());
  }
}

async function fetchDJNamesWithSelenium(letter, driver, io, runTotals = null) {
  const djState = {
    processedCount: 0,
    newDJCount: 0,
    seenDJs: new Set(),
    runTotals
  };
  let totalDJCount = 0;

  try {
    const url = `${baseUrl}${letter}/index.html`;
    console.log(`Fetching DJs from URL: ${url}`);
    //io.emit('scraperOutput', `Fetching DJs from URL: ${url}`);
    await driver.get(url);

    await checkForCaptcha(driver, io);

    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      if (shouldStopScraper) {
        console.log('Scraper stopped.');
        io.emit('scraperStopped', 'Scraper has been stopped.');
        return { stopped: true };
      }

      if (await checkForPageNotExist(driver)) {
        console.log("Page does not exist. Refreshing page...");
        io.emit('scraperOutput', 'Page does not exist. Refreshing page...');
        await driver.navigate().refresh();
        await politeSleep(5000);
        if (shouldStopScraper) return { stopped: true };
        await checkForCaptcha(driver, io);
        retries++;
        continue;
      }

      try {
        await driver.wait(until.elementLocated(By.css('div.bTitle a')), 10000);
        if (shouldStopScraper) return { stopped: true };
        await waitForDJElements(driver);
        if (shouldStopScraper) return { stopped: true };
        await processDJElementsOnPage(driver, io, djState);
        if (shouldStopScraper) return { stopped: true };
        await scrollToBottom(driver, io, () => processDJElementsOnPage(driver, io, djState));
        if (shouldStopScraper) return { stopped: true };
        break;
      } catch (error) {
        retries++;
        console.log(`Attempt ${retries + 1}: Failed to find 'div.bTitle a'. Retrying...`);
        io.emit('scraperOutput', `Attempt ${retries + 1}: Failed to find 'div.bTitle a'. Retrying...`);
        await driver.navigate().refresh();
        await politeSleep(5000);
        if (shouldStopScraper) return { stopped: true };
        await checkForCaptcha(driver, io);
      }
    }

    if (retries === maxRetries) {
      console.log(`Failed to load DJ list after ${maxRetries} attempts. Skipping ${letter}.`);
      io.emit('scraperOutput', `Failed to load DJ list after ${maxRetries} attempts. Skipping ${letter}.`);
      return { success: false };
    }

    const djElements = await driver.findElements(By.css('div.bTitle a'));
    totalDJCount = djElements.length;
    console.log(`Found ${totalDJCount} DJ elements for letter '${letter}'`);
    io.emit('scraperOutput', `Found ${totalDJCount} DJ elements for letter '${letter}'`);

    await processDJElementsOnPage(driver, io, djState);

    console.log(`Processed: ${djState.processedCount}, New: ${djState.newDJCount}`);
    io.emit('scraperOutput', `Processed: ${djState.processedCount}, New: ${djState.newDJCount}`);
    return {
      success: true,
      processedCount: djState.processedCount,
      newDJCount: djState.newDJCount
    };
  } catch (error) {
    console.error(`Error fetching DJ names for letter ${letter}:`, error.message);
    io.emit('scraperError', `Error fetching DJ names for letter ${letter}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function scrapeAllDJs(startLetter, io) {
  shouldStopScraper = false;

  try {
    const effectiveStartLetter = await resolveStartLetter(startLetter);
    const startIndex = alphabet.indexOf(effectiveStartLetter);
    if (startIndex === -1) {
      console.error(`Invalid start letter: ${startLetter}`);
      io.emit('scraperError', `Invalid start letter: ${startLetter}`);
      return;
    }

    io.emit('scraperOutput', `Scraper started with letter: ${effectiveStartLetter}`);
    const runTotals = {
      processedCount: 0,
      newDJCount: 0
    };

    for (let i = startIndex; i < alphabet.length; i++) {
      if (shouldStopScraper) {
        console.log('Scraper stopped.');
        io.emit('scraperStopped', 'Scraper has been stopped.');
        break;
      }

      const letter = alphabet[i];
      const nextLetter = alphabet[i + 1] || null;
      await writeScraperCheckpoint({
        status: 'running',
        currentLetter: letter,
        nextLetter: letter
      });
      console.log(`Fetching DJs starting with '${letter}'...`);
      io.emit('scraperOutput', `Fetching DJs starting with '${letter}'...`);
      let driver = null;
      let result = null;

      try {
        await cleanupStaleScraperChrome(io);
        driver = await createChromeDriver();
        result = await fetchDJNamesWithSelenium(letter, driver, io, runTotals);
      } finally {
        if (driver) {
          try {
            await driver.quit();
            io.emit('scraperOutput', `Closed Chrome after '${letter}' to clear browser memory.`);
          } catch (quitError) {
            console.warn(`Unable to close Chrome after '${letter}': ${quitError.message}`);
            io.emit('scraperOutput', `Unable to close Chrome after '${letter}': ${quitError.message}`);
          }
        }
      }

      if (result?.stopped || shouldStopScraper) {
        console.log('Scraper stopped.');
        io.emit('scraperStopped', 'Scraper has been stopped.');
        break;
      }
      console.log(`Completed fetching DJs for '${letter}'`);
      io.emit('scraperOutput', `Completed fetching DJs for '${letter}'`);
      await writeScraperCheckpoint({
        status: nextLetter ? 'checkpoint' : 'complete',
        lastCompletedLetter: letter,
        nextLetter
      });

      await politeSleep(getCrawlDelay());
    }
  } catch (error) {
    console.error('An error occurred:', error);
    io.emit('scraperError', `An error occurred: ${error.message}`);
  }
}

module.exports = { scrapeAllDJs, setShouldStopScraper, setScraperQuietMode };
