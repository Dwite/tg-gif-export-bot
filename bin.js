#!/usr/bin/env node

'use strict'

const TeleBot = require('telebot')
const bot = new TeleBot(process.argv[2])
const ERROR_REPLY = 'Boom!\nYou just made this bot go kaboom!\nHave a 🍪️!'
const fetch = require('node-fetch')
const mkdir = require('mkdirp').sync
const rimraf = require('rimraf').sync
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const getTMP = (postname) => path.join(TMP, crypto.randomBytes(6).toString('hex') + (postname || ''))
const cp = require('child_process')
const bl = require('bl')
const URI = require('urijs')

const TMP = path.join(os.tmpdir(), 'gif-export-bot')

const clean = () => {
  log.info('Taking out the trash... (Removing temporary files...)')
  rimraf(TMP)
  mkdir(TMP)
  log.info('Done!')
}

const Sentry = require('@sentry/node')
Sentry.init({dsn: process.env.SENTRY_DSN})

const pino = require('pino')
const log = pino({name: 'tg-gif-export-bot'})

clean()
setInterval(clean, 3600 * 1000) // fixes disk filling with failed dls

const MAX_SIZE = 25 * 1024 * 1024

const nameToGif = (name) => {
  name = path.basename(name)
  const {ext} = path.parse(name)
  return name.replace(ext, name.indexOf('.gif') !== -1 ? '' : '.gif') + '_'
}

const exec = (cmd, args) => new Promise((resolve, reject) => {
  const p = cp.spawn(cmd, args, {stdio: 'pipe'})
  p.stdout = p.stdout.pipe(bl())
  p.stderr = p.stderr.pipe(bl())

  p.once('exit', (code, sig) => {
    if (code || sig) {
      const e = new Error('Code/Sig ' + (code || sig))
      e.stdout = String(p.stdout)
      e.stderr = String(p.stderr)
      return reject(e)
    }

    return resolve(p)
  })

  p.once('error', reject)
})

const tgFetch = async (file, msg) => {
  if (!file) {
    return msg.reply.text(ERROR_REPLY)
  }

  if (file.file_size > MAX_SIZE) {
    return msg.reply.text('Sorry, but we only support files up to 25MB!')
  }

  log.info(file, 'Downloading %s...', file.file_id)

  const f2 = await bot.getFile(file.file_id)

  if (f2.file_size > MAX_SIZE) { // dbl check
    return msg.reply.text('Sorry, but we only support files up to 25MB!')
  }

  return webFetchToTmp(f2.fileLink, path.basename(f2.file_path || ''))
}

const webFetchToTmp = async (url, postname) => {
  const res = await fetch(url)

  let tmp = getTMP(postname)

  log.info({tmp, url}, 'Downloading %s to %s...', url, tmp)

  /* if (res.headers.get('content-type') && !res.headers.get('content-type').startsWith('image/')) {
    throw new Error('Not an image')
  } */

  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(tmp)
    res.body.pipe(dest)
    let dlSize = 0
    res.body.on('data', data => {
      dlSize += data.length
      if (dlSize > MAX_SIZE) { // someone is downloading an ISO or stuff
        dest.close()
        res.body.close()
        reject(new Error('Too big!'))
      }
    })
    res.body.on('error', err => {
      reject(err)
    })
    dest.on('finish', () => {
      resolve()
    })
    dest.on('error', err => {
      reject(err)
    })
  })

  return tmp
}

const origOn = bot.on.bind(bot)
bot.on = (ev, fnc, ...a) => {
  origOn(ev, async (msg, ...a) => {
    try {
      let res = await fnc(msg, ...a)
      return res
    } catch (e) {
      log.error(e)
      Sentry.captureException(e)
      try {
        msg.reply.text(ERROR_REPLY)
      } catch (e) {
        // ignore
      }
    }
  }, ...a)
}

bot.on(['/start', '/hello'], (msg) => msg.reply.text('This bot turns Telegram GIFs into real .gif\'s!\nJust send me your GIFs and I\'ll convert them! (I also take links to .mp4\'s)\nMade by: mkg20001 - Code: https://github.com/mkg20001/tg-gif-export-bot', {webPreview: false}))

bot.on('document', async (msg) => {
  const doc = msg.document
  if (!doc.mime_type.startsWith('video/')) {
    return msg.reply.text('That doesn\'t look like a video')
  }

  const location = await tgFetch(doc)

  await doConvert(location, msg.reply, {fileName: nameToGif(doc.file_name), asReply: true})
})

bot.on('text', async (msg) => {
  if (msg.text.trim().startsWith('/')) { // ignore cmds
    return
  }

  let urls = []
  URI.withinString(msg.text, (url) => urls.push(url))
  if (!urls.length) {
    return msg.reply.text('Didn\'t find any URLs in your message', {asReply: true})
  }

  if (urls.length > 20) {
    return msg.reply.text('Too many URLs!')
  }

  await Promise.all(urls.map(async (url) => {
    try {
      const loc = await webFetchToTmp(url)
      await doConvert(loc, msg.reply, {fileName: nameToGif(url), asReply: true})
    } catch (e) {
      msg.reply.text('ERROR: Couldn\'t convert ' + url, {webPreview: false, asReply: true})
      log.error(e)
      Sentry.captureException(e)
    }
  }))
})

async function doConvert (input, reply, opt) {
  let output = getTMP('_converted.gif')

  log.info({input, output}, 'Converting...')

  await exec('ffmpeg', ['-i', input, output])

  await reply.file(output, opt)

  // clean disk
  rimraf(input)
  rimraf(output)
}

bot.start()
