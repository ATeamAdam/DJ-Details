const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const readline = require('readline');
const { promisify } = require('util');
const { insertDJ, checkDJExists, getDJCount } = require('./database');
const notifier = require('node-notifier');

const baseUrl = 'https://www.1001tracklists.com/djs/';
const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const crawlDelay = 2000;
const scrollDelay = 500;
const batchSize = 50;

const sleep = promisify(setTimeout);
let shouldStopScraper = false;

function setShouldStopScraper(value) {
  shouldStopScraper = value;
}

async function waitForCaptchaToBeSolved(driver, io) {
  console.log("CAPTCHA detected. Please solve it manually in the browser...");
  io.emit('scraperOutput', 'CAPTCHA detected. Please solve it manually in the browser...');
  
  // Send a notification with sound
  notifier.notify({
    title: 'CAPTCHA Detected',
    message: 'Please solve the CAPTCHA manually in the browser.',
    sound: true
  });

  while (true) {
    try {
      await driver.findElement(By.css('img[alt="Captcha"]'));
      await sleep(5000);
    } catch (error) {
      console.log("CAPTCHA solved. Resuming execution...");
      io.emit('scraperOutput', 'CAPTCHA solved. Resuming execution...');
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

async function checkForPageNotExist(driver) {
  const pageNotExistElement = await driver.findElements(By.xpath("//*[contains(text(), 'Sorry, that page does not exist')]"));
  return pageNotExistElement.length > 0;
}

async function scrollToBottom(driver, io) {
  let lastHeight = await driver.executeScript('return document.body.scrollHeight');
  let retries = 0;
  const maxRetries = 10;
  let initialScroll = true;

  while (true) {
    if (initialScroll) {
      io.emit('scraperOutput', 'Scrolling to the bottom of the page...');
      initialScroll = false;
    }

    await driver.executeScript('window.scrollTo(0, document.body.scrollHeight);');
    await sleep(scrollDelay);
    await checkForCaptcha(driver, io);

    const newHeight = await driver.executeScript('return document.body.scrollHeight');
    const noMoreItemsMessage = await driver.findElements(By.xpath("//*[contains(text(), 'No more items found')]"));

    if (newHeight === lastHeight) {
      retries++;
      if (retries % 5 === 0) {
        console.log("No new content loaded, retrying...");
        io.emit('scraperOutput', 'No new content loaded, retrying...');
      }
      await driver.executeScript('window.scrollTo(0, document.body.scrollHeight - 100);');
      await sleep(2000);
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
  await driver.wait(until.elementsLocated(By.css('div.bTitle a')), 30000);
  const djElements = await driver.findElements(By.css('div.bTitle a'));
  if (djElements.length > 0) {
    await driver.executeScript('arguments[0].scrollIntoView()', djElements[djElements.length - 1]);
    await sleep(scrollDelay);
  }
}

async function fetchDJNamesWithSelenium(letter, driver, io) {
  let processedCount = 0;
  let newDJCount = 0;
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
        return;
      }

      if (await checkForPageNotExist(driver)) {
        console.log("Page does not exist. Refreshing page...");
        io.emit('scraperOutput', 'Page does not exist. Refreshing page...');
        await driver.navigate().refresh();
        await sleep(2000);
        await checkForCaptcha(driver, io);
        retries++;
        continue;
      }

      try {
        await driver.wait(until.elementLocated(By.css('div.bTitle a')), 10000);
        await waitForDJElements(driver);
        await scrollToBottom(driver, io);
        break;
      } catch (error) {
        retries++;
        console.log(`Attempt ${retries + 1}: Failed to find 'div.bTitle a'. Retrying...`);
        io.emit('scraperOutput', `Attempt ${retries + 1}: Failed to find 'div.bTitle a'. Retrying...`);
        await driver.navigate().refresh();
        await sleep(2000);
        await checkForCaptcha(driver, io);
      }
    }

    if (retries === maxRetries) {
      console.log(`Failed to load DJ list after ${maxRetries} attempts. Skipping ${letter}.`);
      io.emit('scraperOutput', `Failed to load DJ list after ${maxRetries} attempts. Skipping ${letter}.`);
      return;
    }

    const djElements = await driver.findElements(By.css('div.bTitle a'));
    totalDJCount = djElements.length;
    console.log(`Found ${totalDJCount} DJ elements for letter '${letter}'`);
    io.emit('scraperOutput', `Found ${totalDJCount} DJ elements for letter '${letter}'`);

    const newNamesPromises = djElements.map(async (element) => {
      const djName = await element.getText();
      const djUrl = await element.getAttribute('href');
  
      try {
        const exists = await checkDJExists(djName, djUrl);
        if (!exists) {
          await insertDJ(djName, djUrl);
          newDJCount++;
          console.log(`Inserted new DJ: ${djName}`);
        } else {
          console.log(`DJ already exists: ${djName}`);
        }
      } catch (err) {
        console.error(`Error processing DJ: ${djName} - ${err.message}`);
        io.emit('scraperError', `Error processing DJ: ${djName} - ${err.message}`);
      } finally {
        processedCount++;
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`Processed: ${processedCount}, New: ${newDJCount}`);
        io.emit('scraperStatus', { processedCount, newDJCount });
      }
    });

    await Promise.all(newNamesPromises);

    console.log(`Processed: ${processedCount}, New: ${newDJCount}`);
    io.emit('scraperOutput', `Processed: ${processedCount}, New: ${newDJCount}`);
  } catch (error) {
    console.error(`Error fetching DJ names for letter ${letter}:`, error.message);
    io.emit('scraperError', `Error fetching DJ names for letter ${letter}: ${error.message}`);
  }
}

async function scrapeAllDJs(startLetter, io) {
  const options = new chrome.Options();
  options.addArguments('ignore-certificate-errors');
  options.addArguments('start-maximized');
  const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

  try {
    const startIndex = alphabet.indexOf(startLetter);
    if (startIndex === -1) {
      console.error(`Invalid start letter: ${startLetter}`);
      io.emit('scraperError', `Invalid start letter: ${startLetter}`);
      return;
    }

    io.emit('scraperOutput', `Scraper started with letter: ${startLetter}`);
    for (let i = startIndex; i < alphabet.length; i++) {
      if (shouldStopScraper) {
        console.log('Scraper stopped.');
        io.emit('scraperStopped', 'Scraper has been stopped.');
        break;
      }

      const letter = alphabet[i];
      console.log(`Fetching DJs starting with '${letter}'...`);
      io.emit('scraperOutput', `Fetching DJs starting with '${letter}'...`);
      await fetchDJNamesWithSelenium(letter, driver, io);
      console.log(`Completed fetching DJs for '${letter}'`);
      io.emit('scraperOutput', `Completed fetching DJs for '${letter}'`);

      await sleep(crawlDelay);
    }
    io.emit('scraperComplete', 'Scraper completed successfully.');
  } catch (error) {
    console.error('An error occurred:', error);
    io.emit('scraperError', `An error occurred: ${error.message}`);
  } finally {
    await driver.quit();
  }
}

module.exports = { scrapeAllDJs, setShouldStopScraper };
