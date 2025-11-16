import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, BinaryInfo, CacheStore, delay, DisconnectReason, downloadAndProcessHistorySyncNotification, encodeWAM, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, getHistoryMsg, isJidNewsletter, jidDecode, makeCacheableSignalKeyStore, normalizeMessageContent, PatchedMessageWithRecipientJID, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
//import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import { createRedisClient, type RedisConfig } from './redis-client.js'
import P from 'pino'
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent'; // 导入 HTTP 代理库
import config from 'config';
// import { WAMHandler } from './

const proxyUrl = config.get<string>('proxy.url');
// 配置 Clash HTTP 代理（和之前 curl 生效的地址一致）
const proxyAgent = new HttpsProxyAgent(proxyUrl);
const logger = P({
	level: config.get<string>('logging.level'),
	transport: {
		targets: [
			{
				target: "pino-pretty", // pretty-print for console
				options: { colorize: true, translateTime: 'SYS:standard', singleLine: true },
				level: config.get<string>('logging.level'),
			},
			{
				target: "pino/file", // raw file output
				options: { destination: config.get<string>('logging.file') },
				level: config.get<string>('logging.level'),
			},
		],
	},
})
logger.level = config.get<string>('logging.level');

const doReplies = process.argv.includes('--do-reply') || config.get<boolean>('features.doReply');
const usePairingCode = process.argv.includes('--use-pairing-code') || config.get<boolean>('features.usePairingCode');
const argvs = process.argv.slice(3)
const webCode = argvs[0]
const phoneNumber = argvs[1]

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// Redis 连接配置
const redisConfig: RedisConfig = {
	host: config.get<string>('redis.host'),
	port: config.get<number>('redis.port'),
	// password: config.get<string>('redis.password'), // 如果需要认证
	db: config.get<number>('redis.db'),
	connectTimeout: config.get<number>('redis.connectTimeout'),
	maxRetries: config.get<number>('redis.maxRetries')
}

// 创建 Redis 客户端
const redisClient = createRedisClient(redisConfig, logger)

// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		agent: proxyAgent,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage
	})


	// Pairing code for Web clients
	// if (usePairingCode && !sock.authState.creds.registered) {
	// 	// todo move to QR event
	// 	const phoneNumber = await question('Please enter your phone number:\n')
	// 	const code = await sock.requestPairingCode(phoneNumber)
	// 	console.log(`Pairing code: ${code}`)
	// }

	const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async (events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if (events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update
				if (connection === 'close') {
					// reconnect if not logged out
					if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
					}
				}
				console.log('connection update', update)

				// QR Code and 8位配对码
				if (connection === undefined && !sock.authState.creds.registered) {
					// todo move to QR event

					if (usePairingCode) {
						// const phoneNumber = await question('Please enter your phone number:\n')
						const code = await sock.requestPairingCode(phoneNumber)
						// 缓存配对码到 Redis
						await redisClient.set(`pairing_code:${phoneNumber}`, code, 60 * 5) // 5 分钟过期
						console.log(`Pairing code: ${code}`)
					}

					if (qr) {
						console.log(`QR code: ${qr}`)
					}
				}

				// connection opened -- you can start sending messages
				if (connection === 'open') {
					console.log('opened connection')
				}
			}

			// credentials updated -- save them
			if (events['creds.update']) {
				await saveCreds()
			}

			if (events['labels.association']) {
				console.log(events['labels.association'])
			}


			if (events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			if (events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if (events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					console.log('received on-demand history sync, messages=', messages)
				}
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
			}

			// received a new message
			if (events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages ', JSON.stringify(upsert, undefined, 2))

				if (!!upsert.requestId) {
					console.log("placeholder message received for request of id=" + upsert.requestId, upsert)
				}



				if (upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
							const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
							if (text == "requestPlaceholder" && !upsert.requestId) {
								const messageId = await sock.requestPlaceholderResend(msg.key)
								console.log('requested placeholder resync, id=', messageId)
							}

							// go to an old chat and send this
							if (text == "onDemandHistSync") {
								const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
								console.log('requested on-demand sync, id=', messageId)
							}

							if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {

								console.log('replying to', msg.key.remoteJid)
								await sock!.readMessages([msg.key])
								await sendMessageWTyping({ text: 'Hello there!' }, msg.key.remoteJid!)
							}
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if (events['messages.update']) {
				console.log(
					JSON.stringify(events['messages.update'], undefined, 2)
				)

				for (const { key, update } of events['messages.update']) {
					if (update.pollUpdates) {
						const pollCreation: proto.IMessage = {} // get the poll creation message somehow
						if (pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

			if (events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if (events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if (events['presence.update']) {
				console.log(events['presence.update'])
			}

			if (events['chats.update']) {
				console.log(events['chats.update'])
			}

			if (events['contacts.update']) {
				for (const contact of events['contacts.update']) {
					if (typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if (events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		// Implement a way to retreive messages that were upserted from messages.upsert
		// up to you

		// only if store is present
		return proto.Message.create({ conversation: 'test' })
	}
}

startSock()