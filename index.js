const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, StreamType, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const { spawn } = require('child_process');
const { token, clientId } = require('./config.json');
const fs = require('fs');
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ]
});

// Default prefix
const defaultPrefix = '?';

// Load prefixes from file or initialize empty object
const prefixesPath = path.join(__dirname, 'prefixes.json');
let prefixes = {};
if (fs.existsSync(prefixesPath)) {
    try {
        prefixes = JSON.parse(fs.readFileSync(prefixesPath, 'utf8'));
    } catch (err) {
        console.error('Error reading prefixes.json:', err);
        prefixes = {};
    }
}

const queue = new Map();

// Slash commands definition
const commands = [
    new SlashCommandBuilder().setName('play').setDescription('Play a song from a URL or search query').addStringOption(option =>
        option.setName('query').setDescription('The URL or search query').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
    new SlashCommandBuilder().setName('queue').setDescription('Show the current music queue'),
    new SlashCommandBuilder().setName('pause').setDescription('Pause the music'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume the music'),
    new SlashCommandBuilder().setName('volume').setDescription('Set the volume').addIntegerOption(option =>
        option.setName('amount').setDescription('Volume from 1 to 200').setRequired(true)),
    new SlashCommandBuilder().setName('help').setDescription('Show help information'),
    new SlashCommandBuilder().setName('setprefix').setDescription('Set a custom prefix for this server').addStringOption(option =>
        option.setName('prefix').setDescription('The new prefix (max 3 characters)').setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);


client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    client.user.setActivity(`${defaultPrefix}help`, { type: 'LISTENING' }); // Updated to use default prefix

    try {
        console.log('Started refreshing application (/) commands.');
        // Change to guild-specific commands for faster updates during testing
        // Replace 'YOUR_GUILD_ID' with your actual guild ID
        const guildId = '1215288512392200252'; // Updated with user's guild ID
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, guildId),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
});

// Autocomplete interaction handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;

    const focusedOption = interaction.options.getFocused(true);
    if (interaction.commandName === 'play' && focusedOption.name === 'query') {
        const query = focusedOption.value;

        // Use yt-dlp to search for videos matching the query
        const args = [
            '--dump-json',
            '--no-warnings',
            '--default-search', 'ytsearch5',
            '--quiet',
            query
        ];

        const ytDlpProcess = spawn('yt-dlp', args);
        let data = '';

        ytDlpProcess.stdout.on('data', chunk => data += chunk);
        ytDlpProcess.on('error', error => {
            console.error('yt-dlp autocomplete error:', error);
            interaction.respond([]);
        });
        ytDlpProcess.on('close', code => {
            if (code !== 0) {
                console.error(`yt-dlp exited with code ${code} during autocomplete`);
                interaction.respond([]);
                return;
            }
            try {
                // yt-dlp outputs multiple JSON objects concatenated, split by newlines
                const lines = data.trim().split('\n');
                const suggestions = lines.map(line => {
                    const info = JSON.parse(line);
                    return {
                        name: info.title.length > 100 ? info.title.substring(0, 97) + '...' : info.title,
                        value: info.webpage_url
                    };
                }).slice(0, 25); // Max 25 suggestions

                interaction.respond(suggestions);
            } catch (err) {
                console.error('Error parsing yt-dlp autocomplete JSON:', err);
                interaction.respond([]);
            }
        });
    }
});

// Save prefixes to file
function savePrefixes() {
    fs.writeFileSync(prefixesPath, JSON.stringify(prefixes, null, 2));
}

// Audio player manager
function createPlayer(guildId) {
    const player = createAudioPlayer();
    
    player.on('error', error => {
        console.error('Audio player error:', error);
        const serverQueue = queue.get(guildId);
        if (serverQueue) {
            serverQueue.textChannel.send('An error occurred during playback. Skipping song...');
            serverQueue.songs.shift();
            playSong(guildId, serverQueue.voiceChannel);
        }
    });

    player.on(AudioPlayerStatus.Idle, () => {
        const serverQueue = queue.get(guildId);
        if (serverQueue) {
            serverQueue.songs.shift();
            playSong(guildId, serverQueue.voiceChannel);
        }
    });

    return player;
}

// Voice connection manager
function createConnection(voiceChannel, guildId, textChannel) {
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch (error) {
            console.log('Voice connection disconnected, attempting to reconnect...');
            connection.destroy();
            const serverQueue = queue.get(guildId);
            if (serverQueue) {
                setTimeout(() => {
                    serverQueue.connection = createConnection(voiceChannel, guildId, textChannel);
                    serverQueue.connection.subscribe(serverQueue.audioPlayer);
                    if (serverQueue.songs.length > 0) {
                        playSong(guildId, voiceChannel);
                    }
                }, 5_000);
            }
        }
    });

    return connection;
}

// Get song info using yt-dlp
async function getSongInfo(urlOrQuery) {
    return new Promise((resolve, reject) => {
        const args = [
            '--dump-json',
            '--no-warnings',
            '--default-search', 'ytsearch',
            '--quiet',
            urlOrQuery
        ];

        const ytDlpProcess = spawn('yt-dlp', args);
        let data = '';

        ytDlpProcess.stdout.on('data', chunk => data += chunk);
        ytDlpProcess.on('error', reject);
        ytDlpProcess.on('close', code => {
            if (code !== 0) return reject(new Error(`yt-dlp exited with code ${code}`));
            try {
                const info = JSON.parse(data);
                resolve({
                    title: info.title || 'Unknown Track',
                    url: info.url || info.webpage_url || urlOrQuery,
                    duration: info.duration ? formatDuration(info.duration) : 'Live',
                    thumbnail: info.thumbnail || null,
                    platform: info.extractor || 'unknown'
                });
            } catch (err) {
                reject(err);
            }
        });
    });
}

// Format duration (seconds to MM:SS)
function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Get audio stream using yt-dlp
async function getAudioStream(url) {
    return new Promise((resolve, reject) => {
        const args = [
            '-q',
            '-f', 'bestaudio',
            '-o', '-',
            '--no-playlist',
            '--audio-quality', '0',
            url
        ];

        const audioStream = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'ignore']
        });

        audioStream.on('error', reject);
        audioStream.stdout.on('error', reject);

        resolve(audioStream.stdout);
    });
}

// Main playback function
async function playSong(guildId, voiceChannel) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        if (serverQueue?.connection) {
            setTimeout(() => {
                if (!serverQueue.songs.length) {
                    serverQueue.connection.destroy();
                    queue.delete(guildId);
                }
            }, 300_000); // Leave after 5 minutes of inactivity
        }
        return;
    }

    const song = serverQueue.songs[0];
    
    try {
        const audioStream = await getAudioStream(song.url);
        const resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });

        if (serverQueue.volume) {
            resource.volume.setVolume(serverQueue.volume / 100);
        }

        serverQueue.audioPlayer.play(resource);
        
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Now Playing')
            .setDescription(`[${song.title}](${song.url})`)
            .setFooter({ text: `Source: ${song.platform}` });

        if (song.thumbnail) {
            embed.setThumbnail(song.thumbnail);
        }

        if (song.duration) {
            embed.addFields({ name: 'Duration', value: song.duration, inline: true });
        }

        embed.addFields({ name: 'Requested by', value: song.requestedBy, inline: true });

        await serverQueue.textChannel.send({ embeds: [embed] });

    } catch (error) {
        console.error('Playback error:', error);
        serverQueue.textChannel.send('Error playing the song. Skipping...');
        serverQueue.songs.shift();
        playSong(guildId, voiceChannel);
    }
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    client.user.setActivity(`${defaultPrefix}help`, { type: 'LISTENING' }); // Updated to use default prefix
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const prefix = prefixes[guildId] || defaultPrefix;

    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const voiceChannel = message.member.voice.channel;

    if (!voiceChannel) {
        return message.reply('You need to be in a voice channel to use music commands!');
    }

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has('Connect') || !permissions.has('Speak')) {
        return message.reply('I need permissions to join and speak in your voice channel!');
    }

    let serverQueue = queue.get(guildId);
    if (!serverQueue) {
        serverQueue = {
            textChannel: message.channel,
            voiceChannel: voiceChannel,
            connection: null,
            audioPlayer: createPlayer(guildId),
            songs: [],
            playing: true,
            volume: 100
        };
        queue.set(guildId, serverQueue);
    }

    // List of valid commands for similarity check
    const validCommands = ['play', 'p', 'skip', 'stop', 'queue', 'q', 'pause', 'resume', 'r', 'volume', 'v', 'help', 'setprefix'];

    // Function to calculate Levenshtein distance
    function levenshtein(a, b) {
        const matrix = [];
        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    // Check if command is close to any valid command (distance <= 2)
    function isCloseCommand(cmd) {
        return validCommands.some(validCmd => levenshtein(cmd, validCmd) <= 2);
    }

    try {
        switch (command) {
            case 'setprefix': {
                // Only allow admins to set prefix
                if (!message.member.permissions.has('Administrator')) {
                    return message.reply('Only server admins can change the prefix.');
                }
                const newPrefix = args[0];
                if (!newPrefix) {
                    return message.reply('Please provide a new prefix.');
                }
                if (newPrefix.length > 3) {
                    return message.reply('Prefix length should be 3 characters or less.');
                }
                prefixes[guildId] = newPrefix;
                savePrefixes();
                await message.reply(`Prefix successfully changed to \`${newPrefix}\``);
                break;
            }
            case 'play':
            case 'p': {
                const query = args.join(' ');
                if (!query) return message.reply('Please provide a URL or search query!');

                await message.channel.sendTyping();
                
                try {
                    const song = await getSongInfo(query);
                    song.requestedBy = message.author.tag;

                    serverQueue.songs.push(song);

                    const embed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Added to Queue')
                        .setDescription(`[${song.title}](${song.url})`)
                        .setFooter({ text: `Source: ${song.platform}` });

                    if (song.thumbnail) {
                        embed.setThumbnail(song.thumbnail);
                    }

                    if (song.duration) {
                        embed.addFields({ name: 'Duration', value: song.duration, inline: true });
                    }

                    embed.addFields({ name: 'Position in queue', value: `${serverQueue.songs.length}`, inline: true });

                    await message.reply({ embeds: [embed] });

                    if (!serverQueue.connection) {
                        serverQueue.connection = createConnection(voiceChannel, guildId, message.channel);
                        serverQueue.connection.subscribe(serverQueue.audioPlayer);
                    }

                    if (serverQueue.songs.length === 1) {
                        playSong(guildId, voiceChannel);
                    }
                } catch (error) {
                    console.error('Play command error:', error);
                    await message.reply('Failed to process this song. Please try a different one.');
                }
                break;
            }
            case 'skip': {
                if (!serverQueue.songs.length) {
                    return message.reply('There are no songs in the queue to skip!');
                }
                
                serverQueue.audioPlayer.stop();
                await message.reply('⏭️ Skipped the current song!');
                break;
            }
            case 'stop': {
                if (!serverQueue.songs.length) {
                    return message.reply('There is nothing playing!');
                }
                
                serverQueue.songs = [];
                serverQueue.audioPlayer.stop();
                await message.reply('⏹️ Stopped the music and cleared the queue!');
                break;
            }
            case 'queue':
            case 'q': {
                if (!serverQueue.songs.length) {
                    return message.reply('The queue is empty!');
                }
                
                const queueEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Music Queue')
                    .setDescription(`Now Playing: [${serverQueue.songs[0].title}](${serverQueue.songs[0].url})`)
                    .addFields({
                        name: 'Up Next',
                        value: serverQueue.songs.slice(1).map((song, index) => 
                            `${index + 1}. [${song.title}](${song.url}) (${song.platform})`
                        ).join('\n') || 'No songs in queue'
                    });
                
                await message.reply({ embeds: [queueEmbed] });
                break;
            }
            case 'pause': {
                if (serverQueue.audioPlayer.state.status === AudioPlayerStatus.Playing) {
                    serverQueue.audioPlayer.pause();
                    await message.reply('⏸️ Paused the music!');
                } else {
                    await message.reply('The music is already paused!');
                }
                break;
            }
            case 'resume':
            case 'r': {
                if (serverQueue.audioPlayer.state.status === AudioPlayerStatus.Paused) {
                    serverQueue.audioPlayer.unpause();
                    await message.reply('▶️ Resumed the music!');
                } else {
                    await message.reply('The music is not paused!');
                }
                break;
            }
            case 'volume':
            case 'v': {
                const volume = parseInt(args[0]);
                if (isNaN(volume) || volume < 1 || volume > 200) {
                    return message.reply('Please provide a volume between 1 and 200!');
                }
                
                serverQueue.volume = volume;
                
                if (serverQueue.audioPlayer.state.resource) {
                    serverQueue.audioPlayer.state.resource.volume.setVolume(volume/100);
                }
                
                await message.reply(`🔊 Volume set to ${volume}%`);
                break;
            }
            case 'help': {
                const helpEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Music Bot Commands')
                    .setDescription(`Prefix: \`${prefix}\``) // Updated to show ?
                    .addFields(
                        { name: `\`${prefix}play [url/query]\``, value: 'Play a song from any platform (alias: ?p)', inline: true },
                        { name: `\`${prefix}skip\``, value: 'Skip current song', inline: true },
                        { name: `\`${prefix}stop\``, value: 'Stop playback and clear queue', inline: true },
                        { name: `\`${prefix}queue\``, value: 'Show current queue (alias: ?q)', inline: true },
                        { name: `\`${prefix}pause\``, value: 'Pause playback', inline: true },
                        { name: `\`${prefix}resume\``, value: 'Resume playback (alias: ?r)', inline: true },
                        { name: `\`${prefix}volume [1-200]\``, value: 'Adjust volume (alias: ?v)', inline: true }
                    );
                
                await message.reply({ embeds: [helpEmbed] });
                break;
            }
            default: {
                if (isCloseCommand(command)) {
                    await message.reply(`Unknown command! Type \`${prefix}help\` for available commands.`);
                }
                // else ignore unknown commands that are not close to valid commands
            }
        }
    } catch (error) {
        console.error('Command execution error:', error);
        await message.reply('There was an error executing that command!');
    }
});

// Slash command interaction handler

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guildId, member } = interaction;

    let serverQueue = queue.get(guildId);
    if (!serverQueue) {
        serverQueue = {
            textChannel: interaction.channel,
            voiceChannel: member.voice.channel,
            connection: null,
            audioPlayer: createPlayer(guildId),
            songs: [],
            playing: true,
            volume: 100
        };
        queue.set(guildId, serverQueue);
    }

    // Helper function to check admin permission
    function isAdmin() {
        return member.permissions.has('Administrator');
    }

    try {
        switch (commandName) {
            case 'setprefix': {
                if (!isAdmin()) {
                    return interaction.reply({ content: 'Only server admins can change the prefix.', ephemeral: true });
                }
                const newPrefix = options.getString('prefix');
                if (newPrefix.length > 3) {
                    return interaction.reply({ content: 'Prefix length should be 3 characters or less.', ephemeral: true });
                }
                prefixes[guildId] = newPrefix;
                savePrefixes();
                await interaction.reply(`Prefix successfully changed to \`${newPrefix}\``);
                break;
            }
            case 'play': {
                const query = options.getString('query');
                if (!query) return interaction.reply({ content: 'Please provide a URL or search query!', ephemeral: true });

                await interaction.deferReply();

                try {
                    const song = await getSongInfo(query);
                    song.requestedBy = interaction.user.tag;

                    serverQueue.songs.push(song);

                    const embed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Added to Queue')
                        .setDescription(`[${song.title}](${song.url})`)
                        .setFooter({ text: `Source: ${song.platform}` });

                    if (song.thumbnail) {
                        embed.setThumbnail(song.thumbnail);
                    }

                    if (song.duration) {
                        embed.addFields({ name: 'Duration', value: song.duration, inline: true });
                    }

                    embed.addFields({ name: 'Position in queue', value: `${serverQueue.songs.length}`, inline: true });

                    await interaction.editReply({ embeds: [embed] });

                    if (!serverQueue.connection) {
                        if (!member.voice.channel) {
                            return interaction.followUp({ content: 'You need to be in a voice channel to play music.', ephemeral: true });
                        }
                        serverQueue.connection = createConnection(member.voice.channel, guildId, interaction.channel);
                        serverQueue.connection.subscribe(serverQueue.audioPlayer);
                    }

                    if (serverQueue.songs.length === 1) {
                        playSong(guildId, member.voice.channel);
                    }
                } catch (error) {
                    console.error('Play command error:', error);
                    await interaction.editReply('Failed to process this song. Please try a different one.');
                }
                break;
            }

            case 'skip': {
                if (!serverQueue.songs.length) {
                    return interaction.reply({ content: 'There are no songs in the queue to skip!', ephemeral: true });
                }
                
                serverQueue.audioPlayer.stop();
                await interaction.reply('⏭️ Skipped the current song!');
                break;
            }

            case 'stop': {
                if (!serverQueue.songs.length) {
                    return interaction.reply({ content: 'There is nothing playing!', ephemeral: true });
                }
                
                serverQueue.songs = [];
                serverQueue.audioPlayer.stop();
                await interaction.reply('⏹️ Stopped the music and cleared the queue!');
                break;
            }

            case 'queue':
            case 'q': {
                if (!serverQueue.songs.length) {
                    return interaction.reply({ content: 'The queue is empty!', ephemeral: true });
                }
                
                const queueEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Music Queue')
                    .setDescription(`Now Playing: [${serverQueue.songs[0].title}](${serverQueue.songs[0].url})`)
                    .addFields({
                        name: 'Up Next',
                        value: serverQueue.songs.slice(1).map((song, index) => 
                            `${index + 1}. [${song.title}](${song.url}) (${song.platform})`
                        ).join('\n') || 'No songs in queue'
                    });
                
                await interaction.reply({ embeds: [queueEmbed] });
                break;
            }

            case 'pause': {
                if (serverQueue.audioPlayer.state.status === AudioPlayerStatus.Playing) {
                    serverQueue.audioPlayer.pause();
                    await interaction.reply('⏸️ Paused the music!');
                } else {
                    await interaction.reply('The music is already paused!');
                }
                break;
            }

            case 'resume':
            case 'r': {
                if (serverQueue.audioPlayer.state.status === AudioPlayerStatus.Paused) {
                    serverQueue.audioPlayer.unpause();
                    await interaction.reply('▶️ Resumed the music!');
                } else {
                    await interaction.reply('The music is not paused!');
                }
                break;
            }

            case 'volume':
            case 'v': {
                const volume = options.getInteger('amount');
                if (isNaN(volume) || volume < 1 || volume > 200) {
                    return interaction.reply({ content: 'Please provide a volume between 1 and 200!', ephemeral: true });
                }
                
                serverQueue.volume = volume;
                
                if (serverQueue.audioPlayer.state.resource) {
                    serverQueue.audioPlayer.state.resource.volume.setVolume(volume/100);
                }
                
                await interaction.reply(`🔊 Volume set to ${volume}%`);
                break;
            }

            case 'help': {
                const prefix = prefixes[guildId] || defaultPrefix;
                const helpEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('Music Bot Commands')
                    .setDescription(`Prefix: \`${prefix}\``)
                    .addFields(
                        { name: `\`${prefix}play [url/query]\``, value: 'Play a song from any platform (alias: ?p)', inline: true },
                        { name: `\`${prefix}skip\``, value: 'Skip current song', inline: true },
                        { name: `\`${prefix}stop\``, value: 'Stop playback and clear queue', inline: true },
                        { name: `\`${prefix}queue\``, value: 'Show current queue (alias: ?q)', inline: true },
                        { name: `\`${prefix}pause\``, value: 'Pause playback', inline: true },
                        { name: `\`${prefix}resume\``, value: 'Resume playback (alias: ?r)', inline: true },
                        { name: `\`${prefix}volume [1-200]\``, value: 'Adjust volume (alias: ?v)', inline: true }
                    );
                
                await interaction.reply({ embeds: [helpEmbed] });
                break;
            }

            default: {
                await interaction.reply({ content: 'Unknown command! Type `' + (prefixes[guildId] || defaultPrefix) + 'help` for available commands.', ephemeral: true });
            }
        }
    } catch (error) {
        console.error('Command execution error:', error);
        await interaction.reply({ content: 'There was an error executing that command!', ephemeral: true });
    }
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

client.login(token);
