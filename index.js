#!/usr/bin/env node
const program = require('commander')
const puppeteer = require('puppeteer')
const fsPath = require('fs-path')
const fs = require('fs')
const path = require('path')
const { named } = require('named-regexp') // replace me with regex in standard lib
const RJSON = require('relaxed-json')
const recursiveRead = require('recursive-readdir')
const { promisify } = require('util')

const readFile = promisify(fs.readFile)

program
  .option('-i, --in [path]', 'Input Folder containing Jest Snapshots')
  .option('-o, --out [path]', 'Output Folder that images will be saved to')
  .parse(process.argv)

let excludeList = []

async function getMessageBuilderImage (page, message) {
  await page.goto(`https://api.slack.com/docs/messages/builder?msg=${encodeURIComponent(message)}`)
  // not sure why navigation event doesn't fire
  // await page.waitForNavigation({ waitUntil: 'load' });
  await page.waitForSelector('#message_loading_indicator', { hidden: true, timeout: 30000 })

  // https://github.com/GoogleChrome/puppeteer/issues/306#issuecomment-322929342
  async function screenshotDOMElement (selector, padding = 0) {
    const rect = await page.evaluate((selector) => {
      const element = document.querySelector(selector)
      const { x, y, width, height } = element.getBoundingClientRect()
      return { left: x, top: y, width, height, id: element.id }
    }, selector)

    return page.screenshot({
      clip: {
        x: rect.left - padding,
        y: rect.top - padding,
        width: rect.width + (padding * 2),
        height: rect.height + (padding * 2)
      }
    })
  }

  return screenshotDOMElement('#msgs_div')
}

async function main () {
  // load config from package.json
  let packageJSON
  console.log(path.join(process.cwd(), 'package.json'))
  try {
    packageJSON = await readFile(path.join(process.cwd(), 'package.json'))
  } catch (e) {
    console.error(
      'Cannot find package.json. Make sure you run snappydoo from the root of your project',
      e
    )
  }
  const snappydooConfig = JSON.parse(packageJSON).snappydoo
  let inputPath
  let outputPath
  if (snappydooConfig) {
    if (snappydooConfig.out) {
      outputPath = snappydooConfig.out
    }
    if (snappydooConfig.in) {
      inputPath = snappydooConfig.in
    }
    if (snappydooConfig.exclude) {
      excludeList = snappydooConfig.exclude
    }
  }

  // command line args take precedence over package.json
  if (program.in) {
    inputPath = program.in
  }
  if (program.out) {
    outputPath = program.out
  }

  if (!outputPath || !inputPath) {
    console.error('Error: Please specify both an output and an input path.')
    process.exit(1)
  }

  let snapshotFiles = await recursiveRead(path.join(process.cwd(), inputPath))
  snapshotFiles = snapshotFiles.filter(file => {
    return path.extname(file) === '.snap'
  })
  snapshotFiles = snapshotFiles.map(file => {
    return file.replace(`${process.cwd()}/${inputPath}/`, '')
  })

  const snapshots = {}
  // extraxt individual snapshots from snapshot files
  snapshotFiles.forEach(async (file) => {
    // eslint-disable-next-line
    const match = named(new RegExp('^(:<class>[A-Za-z\/]+).test\.js\.snap')).exec(file)
    if (match) {
      if (excludeList.indexOf(match.captures.class[0]) > -1) {
        // if snapshot is on black list, don't process any further
        return
      }

      const snapshotsInFile = require(path.join(process.cwd(), inputPath, file))
      Object.keys(snapshotsInFile).forEach((snapshotName) => {
        const cleaned = snapshotsInFile[snapshotName]
          .replace(/Object /g, '')
          .replace(/Array /g, '')
          .replace(/\n/g, '')
        let message = JSON.parse(RJSON.transform(cleaned))
        if (!message.attachments) {
          message = { attachments: [message] }
        }

        const folderName = `${outputPath}/${match.captures.class[0]}`
        snapshots[`${folderName}/${snapshotName}.png`] = message
      })
    }
  })

  console.log(`Fetching ${Object.keys(snapshots).length} screenshot${Object.keys(snapshots).length === 1 ? '' : 's'} from message builder`)
  const browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()
  page.setViewport({ width: 1000, height: 600, deviceScaleFactor: 2 })
  let fileCreationCounter = 0
  for (const snapshotFileName of Object.keys(snapshots)) {
    let renderedImage
    try {
      renderedImage = await getMessageBuilderImage(
        page,
        JSON.stringify(snapshots[snapshotFileName])
      )
    } catch (e) {
      // retry once
      console.log(e)
      console.log(`Retrying ${snapshotFileName}`)
      renderedImage = await getMessageBuilderImage(
        page,
        JSON.stringify(snapshots[snapshotFileName])
      )
    }
    try {
      await fsPath.writeFile(snapshotFileName, renderedImage, () => {})
      fileCreationCounter += 1
      console.log(`Created ${snapshotFileName}`)
    } catch (e) {
      throw new Error(`Failed to create file: ${e}`)
    }
  }
  await browser.close()
  console.log(`Message builder fetching complete. Created ${fileCreationCounter} file${fileCreationCounter === 1 ? '' : 's'}`)
}

main()
