const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser, getContentType } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const pino = require('pino')
const path = require('path')
const express = require('express')

// Import local modules
const config = require('./config')
const { cmd, commands } = require('./command')
const { sms } = require('./lib/msg')
const { readEnv } = require('./lib/database')
const connectDB = require('./lib/mongodb')

// Start express server for health check
const app = express()
const PORT = process.env.PORT || 8080

app.get('/', (req, res) => {
    res.send(`
    <div style="text-align: center; font-family: Arial, sans-serif; margin-top: 50px;">
        <h1>🤖 SULA-MD WhatsApp Bot</h1>
        <p>Bot Status: <span style="color: green;">Active ✅</span></p>
        <p>Creator: Sulaksha Madara</p>
        <div style="margin-top: 30px;">
            <img src="https://i.ibb.co/WY2qBYz/SulaMd.jpg" alt="Sula MD" style="max-width: 300px; border-radius: 10px;">
        </div>
    </div>
    `)
})

app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`)
})

let sock
let qr
let connected = false

async function connectWhatsApp() {
    try {
        // Connect to MongoDB
        await connectDB()
        
        // Set up auth state
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys')
        
        // Create socket
        sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ["Sula-MD", "Safari", "3.0"],
            auth: state,
            downloadHistory: false,
            syncFullHistory: false
        })

        // Load environment variables from database
        let env_var
        try {
            env_var = await readEnv()
        } catch (e) {
            console.log('⚠️ Error loading environment variables from database, using defaults')
            env_var = {
                PREFIX: '.',
                MODE: 'public',
                AUTO_READ_STATUS: 'true',
                AUTO_VOICE: 'true',
                AUTO_STICKER: 'true',
                AUTO_REPLY: 'true',
                ALLWAYS_OFFLINE: 'false',
                READ_MESSAGE: 'false',
                AUTO_REACT: 'false',
                AUTO_STATUS_REPLY: 'false',
                AUTO_REACT_STATUS: 'true'
            }
        }

        // Connection handling
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr: qrCode } = update
            
            if (qrCode) {
                qr = qrCode
                console.log('📱 QR Code generated, scan with your WhatsApp')
            }
            
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output.statusCode
                if (reason === DisconnectReason.badSession) {
                    console.log('❌ Bad Session File, Please Delete Session and Scan Again')
                    process.exit(1)
                } else if (reason === DisconnectReason.connectionClosed) {
                    console.log('🔄 Connection closed, reconnecting...')
                    connectWhatsApp()
                } else if (reason === DisconnectReason.connectionLost) {
                    console.log('🔄 Connection Lost from Server, reconnecting...')
                    connectWhatsApp()
                } else if (reason === DisconnectReason.connectionReplaced) {
                    console.log('❌ Connection Replaced, Another New Session Opened, Please Close Current Session First')
                    process.exit(1)
                } else if (reason === DisconnectReason.loggedOut) {
                    console.log('❌ Device Logged Out, Please Delete Session and Scan Again.')
                    process.exit(1)
                } else if (reason === DisconnectReason.restartRequired) {
                    console.log('🔄 Restart Required, Restarting...')
                    connectWhatsApp()
                } else if (reason === DisconnectReason.timedOut) {
                    console.log('🔄 Connection TimedOut, Reconnecting...')
                    connectWhatsApp()
                } else {
                    console.log('❌ Unknown DisconnectReason:', reason, '|', connection)
                    connectWhatsApp()
                }
            } else if (connection === 'open') {
                connected = true
                console.log('✅ Connected to WhatsApp')
                console.log('👤 Bot Info:', sock.user)
                
                // Set bot status
                if (env_var.ALLWAYS_OFFLINE !== 'true') {
                    await sock.sendPresenceUpdate('available')
                }
            }
        })

        // Save credentials on update
        sock.ev.on('creds.update', saveCreds)

        // Message handling
        sock.ev.on('messages.upsert', async (messageUpdate) => {
            try {
                const mek = messageUpdate.messages[0]
                if (!mek.message) return
                
                const m = sms(sock, mek)
                
                // Skip if message is from bot itself
                if (m.fromMe) return
                
                // Auto read messages
                if (env_var.READ_MESSAGE === 'true') {
                    await sock.readMessages([m.key])
                }

                // Get message body
                const body = m.body?.toLowerCase() || ''
                const prefix = env_var.PREFIX || '.'
                const isCmd = body.startsWith(prefix)
                const cmd_name = isCmd ? body.slice(prefix.length).split(' ')[0] : ''
                
                // Auto reactions
                if (env_var.AUTO_REACT === 'true' && !isCmd) {
                    const reactions = ['❤️', '👍', '😊', '🔥', '💯', '✨']
                    const randomReaction = reactions[Math.floor(Math.random() * reactions.length)]
                    setTimeout(() => {
                        m.react(randomReaction)
                    }, 1000)
                }

                // Mode check
                const isOwner = m.sender === (sock.user.id.split(':')[0] + '@s.whatsapp.net')
                if (env_var.MODE === 'private' && !isOwner && isCmd) {
                    return m.reply('🔒 This bot is in private mode. Only the owner can use commands.')
                }

                // Auto reply
                if (env_var.AUTO_REPLY === 'true' && !m.isGroup && !isCmd) {
                    const autoReplies = [
                        'Hello! I\'m SULA-MD bot 🤖',
                        'Thanks for messaging! Use .menu to see available commands',
                        'Hi there! How can I help you today?'
                    ]
                    const randomReply = autoReplies[Math.floor(Math.random() * autoReplies.length)]
                    setTimeout(() => {
                        m.reply(randomReply)
                    }, 2000)
                }

                // Command execution
                if (isCmd) {
                    const command = commands.find(cmd => 
                        cmd.pattern === cmd_name || 
                        (cmd.alias && cmd.alias.includes(cmd_name))
                    )
                    
                    if (command) {
                        try {
                            await command.function(sock, m, {
                                args: body.slice(prefix.length + cmd_name.length).trim().split(' '),
                                prefix: prefix,
                                command: cmd_name,
                                env: env_var
                            })
                        } catch (error) {
                            console.error('Command execution error:', error)
                            m.reply('❌ An error occurred while executing the command.')
                        }
                    } else {
                        // Unknown command
                        m.reply(`❓ Unknown command: *${cmd_name}*\nUse *${prefix}menu* to see available commands.`)
                    }
                }

            } catch (error) {
                console.error('Message handling error:', error)
            }
        })

        // Status update handling
        sock.ev.on('messages.upsert', async (messageUpdate) => {
            try {
                for (const mek of messageUpdate.messages) {
                    if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                        // Auto read status
                        if (env_var.AUTO_READ_STATUS === 'true') {
                            await sock.readMessages([mek.key])
                        }
                        
                        // Auto react to status
                        if (env_var.AUTO_REACT_STATUS === 'true') {
                            const statusReactions = ['❤️', '🔥', '👍', '😍', '💯']
                            const randomReaction = statusReactions[Math.floor(Math.random() * statusReactions.length)]
                            setTimeout(() => {
                                sock.sendMessage(mek.key.remoteJid, {
                                    react: { text: randomReaction, key: mek.key }
                                })
                            }, 1000)
                        }
                        
                        // Auto reply to status
                        if (env_var.AUTO_STATUS_REPLY === 'true') {
                            setTimeout(() => {
                                sock.sendMessage(mek.key.remoteJid, {
                                    text: env_var.AUTO_STATUS_MSG || '👋 SULA-MD auto seen your status!'
                                })
                            }, 2000)
                        }
                    }
                }
            } catch (error) {
                console.error('Status handling error:', error)
            }
        })

        // Group update handling
        sock.ev.on('group-participants.update', async (update) => {
            try {
                console.log('Group update:', update)
                // Handle group member join/leave events here
            } catch (error) {
                console.error('Group update error:', error)
            }
        })

    } catch (error) {
        console.error('Connection error:', error)
        setTimeout(() => {
            connectWhatsApp()
        }, 5000)
    }
}

// Load basic commands
cmd({
    pattern: "menu",
    desc: "Show bot menu",
    category: "main",
    filename: __filename
}, async (conn, mek, m) => {
    const { prefix } = m
    const menuText = `
╭─「 *SULA-MD MENU* 」
│ ◦ *Bot Name:* SULA-MD
│ ◦ *Version:* 1.0.0 
│ ◦ *Creator:* Sulaksha Madara
│ ◦ *Prefix:* ${prefix}
╰────────────

╭─「 *MAIN COMMANDS* 」
│ ◦ ${prefix}menu - Show this menu
│ ◦ ${prefix}alive - Check bot status
│ ◦ ${prefix}ping - Check response time
│ ◦ ${prefix}runtime - Bot uptime
╰────────────

╭─「 *INFO* 」
│ ◦ WhatsApp Multi-Device Bot
│ ◦ Built with Baileys Library
│ ◦ Node.js & MongoDB
╰────────────

*𝐒𝐔𝐋𝐀-𝐌𝐃 - Powered by Sulaksha Madara* ❤️
`
    await mek.reply(menuText)
})

cmd({
    pattern: "alive",
    desc: "Check if bot is alive",
    category: "main",
    filename: __filename
}, async (conn, mek, m) => {
    const aliveMsg = `
*🤖 SULA-MD BOT ALIVE! ✅*

┌─⊷ *BOT INFO*
│ ◦ *Name:* SULA-MD
│ ◦ *Version:* 1.0.0
│ ◦ *Creator:* Sulaksha Madara
│ ◦ *Status:* Online & Active
└───────────

*Thanks for using SULA-MD!* ❤️
`
    await mek.replyImg(Buffer.from(await require('axios').get(config.ALIVE_IMG, { responseType: 'arraybuffer' }).then(res => res.data)), aliveMsg)
})

cmd({
    pattern: "ping", 
    desc: "Check bot response time",
    category: "main",
    filename: __filename
}, async (conn, mek, m) => {
    const start = Date.now()
    const msg = await mek.reply('🏓 *Pinging...*')
    const end = Date.now()
    
    await conn.sendMessage(mek.chat, {
        text: `🏓 *Pong!*\n⚡ *Response Time:* ${end - start}ms`,
        edit: msg.key
    })
})

// Start bot
console.log('🚀 Starting SULA-MD WhatsApp Bot...')
console.log('👨‍💻 Creator: Sulaksha Madara')
console.log('📅 Version: 1.0.0')
console.log('─'.repeat(50))

connectWhatsApp()

// Handle process termination
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error)
})

process.on('SIGINT', () => {
    console.log('👋 Bot shutting down...')
    process.exit(0)
})

module.exports = { sock, connectWhatsApp }
