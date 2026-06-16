const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const { promisify } = require('util');
const { getDJsToUpdate, updateDJ, getSearchableDJCount } = require('./database');
const notifier = require('node-notifier'); // Import node-notifier

const sleep = promisify(setTimeout);
let stopSignal = false;

async function waitForCaptchaToBeSolved(driver, io) {
  console.log("CAPTCHA detected. Please solve it manually in the browser...");
  io.emit('updaterOutput', `CAPTCHA detected. Please solve it manually in the browser...`);
  
  // Send a notification with sound
  notifier.notify({
    title: 'CAPTCHA Detected',
    message: 'Please solve the CAPTCHA manually in the browser.',
    sound: true // Play a sound
  });

  while (true) {
    try {
      await driver.findElement(By.css('img[alt="Captcha"]'));
      await sleep(5000);
    } catch (error) {
      console.log("CAPTCHA solved. Resuming execution...");
      io.emit('updaterOutput', `CAPTCHA solved. Resuming execution...`);
      break;
    }
  }
}

async function checkForCaptcha(driver, io) {
  const captchaElement = await driver.findElements(By.css('img[alt="Captcha"]'));
  if (captchaElement.length > 0) {
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
    await driver.executeScript('window.scrollTo(0, document.body.scrollHeight);');
    await sleep(1000);
    await checkForCaptcha(driver, io);

    const newHeight = await driver.executeScript('return document.body.scrollHeight');
    if (newHeight === lastHeight) {
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
    await driver.wait(until.elementsLocated(By.css('img.flag, div.cRow a')), 10000);

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
      await sleep(1500);
    }
  }
}

async function updateAllDJs(io) {
  const options = new chrome.Options();
  options.addArguments('ignore-certificate-errors');
  options.addArguments('start-maximized');
  // options.addArguments('headless');

  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  stopSignal = false;

  try {
    const djs = await getDJsToUpdate();
    const totalDJs = djs.length;

    for (let i = 0; i < totalDJs; i++) {
      if (stopSignal) break;
      const dj = djs[i];
      console.log(`Fetching data for DJ: ${dj.name}`);
      io.emit('updaterOutput', `Fetching data for DJ: ${dj.name}`);

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
      }

      const percentage = Math.round(((i + 1) / totalDJs) * 100);
      io.emit('updateProgress', percentage);
    }
    io.emit('updaterComplete', 'Updater completed successfully.');
  } catch (error) {
    console.error('An error occurred:', error);
    io.emit('updaterError', `An error occurred: ${error.message}`);
  } finally {
    await driver.quit();
  }
}

function setShouldStopUpdater(value) {
  stopSignal = value;
}

module.exports = { updateAllDJs, setShouldStopUpdater };
