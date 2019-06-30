#!/usr/bin/env node

'use strict'

const pino = require('pino')
const log = pino({name: 'tg-sticker-convert-bot'})

const URI = require('urijs')
const path = require('path')
const mainURL = process.argv[3]

const hapi = require('@hapi/hapi')
const boom = require('@hapi/boom')

const HELLO = `*This bot turns Telegram GIFs into real .gifs!*

Just send me your GIFs and I'll convert them!
 \\* Links to .mp4s get downloaded and converted as well

Oh, and could you please...
 \\* Report bugs when you spot them: https://github.com/mkg20001/tg-sticker-convert-bot/issues
 \\* Donate: https://paypal.me/mkg20001
`

const core = require('teleutils')('gif-export-bot', {
  token: process.argv[2],
  helloMessage: HELLO
})

async function doConvert (input, reply, opt) {
  let output = core.tmp('_converted.gif')

  log.info({input: input.path, output: output.path}, 'Converting...')

  await core.exec('ffmpeg', ['-i', input.path, output.path])

  let {chat: {id: cid}, message_id: msgId, document: {file_id: id, file_name: fName}} = await reply.file(output.path, opt)
  if (fName.endsWith('_')) { fName = fName.replace(/_$/, '') }
  fName = encodeURI(fName)

  bot.sendMessage(cid, `Here's the link to download the GIF: ${mainURL}/${id}/${fName}?dl=1

And here's the preview: ${mainURL}/${id}/${fName}

Donate to keep this bot up! https://paypal.me/mkg20001`, {webPreview: false, replyToMessage: msgId})

  // clean disk
  input.cleanup()
  output.cleanup()
}
const nameToGif = (name) => {
  name = path.basename(name)
  const parsed = path.parse(name)
  parsed.ext = '.gif_'
  delete parsed.base
  return path.format(parsed)
}

const beConfused = async (msg) => {
  return msg.reply.file(path.join(__dirname, 'confused.webp'), {fileName: 'confused.webp', asReply: true})
}
const handleDocument = async (msg) => {
  const doc = msg.document
  if (!doc.mime_type.startsWith('video/')) {
    return msg.reply.text('That doesn\'t look like a video')
  }

  const location = await core.fetch.tg(doc)

  await doConvert(location, msg.reply, {fileName: nameToGif(doc.file_name), asReply: true})
}
const handleText = async (msg) => {
  if (msg.text.trim().startsWith('/')) { // ignore cmds
    return
  }

  let urls = []
  URI.withinString(msg.text, (url) => urls.push(url))
  if (!urls.length) {
    // TODO: friendly error
    return msg.reply.text('Didn\'t find any URLs in your message', {asReply: true})
  }

  if (urls.length > 20) {
    // TODO: friendly error
    return msg.reply.text('Too many URLs!')
  }

  await Promise.all(urls.map(async (url) => {
    try {
      const loc = await core.fetch.web(url)
      await doConvert(loc, msg.reply, {fileName: nameToGif(url), asReply: true})
    } catch (e) {
      // TODO: rewrite
      msg.reply.text('ERROR: Couldn\'t convert ' + url, {webPreview: false, asReply: true})
      log.error(e)
      core.error.captureException(e)
    }
  }))
}

const {bot} = core

bot.on('sticker', beConfused)
bot.on('document', handleDocument)
bot.on('photo', beConfused)
bot.on('text', handleText)
bot.on('forward', (msg) => {
  switch (true) {
    case Boolean(msg.document):
      handleDocument(msg)
      break
    case Boolean(msg.text):
      handleText(msg)
      break
    case Boolean(msg.photo):
      beConfused(msg)
      break
    default: {} // eslint-disable-line no-empty
  }
})

const main = async () => {
  const server = hapi.server({
    port: 12486,
    host: 'localhost'
  })

  await server.register({
    plugin: require('hapi-pino'),
    options: {name: 'tg-gif-export-bot'}
  })

  /* if (process.env.SENTRY_DSN) { // TODO: this seems to cause heap out of memory
    await server.register({
      plugin: require('hapi-sentry'),
      options: {client: {
        dsn: process.env.SENTRY_DSN
      }}
    })
  } */

  await server.register({
    plugin: require('@hapi/inert')
  })

  await server.route({
    path: '/',
    method: 'GET',
    handler: async (request, h) => {
      return h.redirect('https://t.me/gif_export_bot')
    }
  })

  await server.route({
    path: '/{id}/{real}',
    method: 'GET',
    config: {
      handler: async (request, h) => {
        let file
        try {
          file = await bot.getFile(request.params.id)
        } catch (e) {
          if (e.error_code === 400) {
            throw boom.notFound()
          } else {
            throw e
          }
        }
        log.info(file, 'Downloading %s...', file.file_id)
        const loc = await core.fetch.web(file.fileLink, path.basename(file.file_path || ''))

        if (request.query.dl) {
          return h.file(loc.path, {confine: false}).header('content-description', 'File Transfer').header('type', 'application/octet-stream').header('content-disposition', 'attachment; filename=' + JSON.stringify(request.params.real)).header('content-transfer-encoding', 'binary')
        } else {
          return h.file(loc.path, {confine: false}).type('image/gif')
        }

        // TODO: call loc.cleanup() afterwards
      }
    }
  })

  await server.start()

  core.start()
}

main().then(() => {}, console.error)
