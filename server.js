const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn, execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Agar '/' par masla ho toh explicit route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ⚡ DIRECT SYSTEM DOWNLOADS FOLDER
const DOWNLOAD_FOLDER = path.join(os.homedir(), 'Downloads', 'VidFetcher');
if (!fs.existsSync(DOWNLOAD_FOLDER)) {
    fs.mkdirSync(DOWNLOAD_FOLDER, { recursive: true });
}

const baseArgs = ['--no-warnings', '--geo-bypass', '--no-check-certificate'];

// 1. Search API
app.post('/search', (req, res) => {
    const query = req.body.query;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const searchQuery = query.includes('http') ? query : `ytsearch10:${query}`;
    
    // Yahan hum Node ko bata rahe hain ke direct yt-dlp ki jagah "python -m yt_dlp" chalaye
    const args = ['-m', 'yt_dlp', ...baseArgs, '-J', '--flat-playlist', searchQuery];

    execFile('python', args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        if (error) {
            console.error("❌ Search Error:", error.message);
            return res.status(500).json({ error: error.message });
        }
        try {
            const info = JSON.parse(stdout);
            const entries = info.entries || [info];
            const results = entries.map(entry => ({
                title: entry.title,
                thumbnail: entry.thumbnails ? entry.thumbnails[0].url : '',
                url: entry.url,
                duration: entry.duration_string || 'N/A',
                uploader: entry.uploader || 'YouTube'
            })).filter(e => e.title);
            res.json({ results });
        } catch (e) {
            console.error("❌ Parse Error:", e.message);
            res.status(500).json({ error: 'Failed to parse data' });
        }
    });
});

// 2. Get Formats API
app.post('/get-formats', (req, res) => {
    const url = req.body.url;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const args = ['-m', 'yt_dlp', ...baseArgs, '-J', url];

    execFile('python', args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
        if (error) {
            console.error("❌ Format Error:", error.message);
            return res.status(500).json({ error: error.message });
        }
        try {
            const info = JSON.parse(stdout);
            const formats = info.formats || [];
            
            let musicOptions = [];
            let videoOptions = [];
            let seenVideoRes = new Set();
            let seenAudioAbr = new Set();

            formats.forEach(f => {
                if (f.vcodec === 'none' && f.acodec !== 'none') {
                    const abr = f.abr;
                    if (!abr || seenAudioAbr.has(abr)) return;
                    seenAudioAbr.add(abr);
                    const size = f.filesize || f.filesize_approx || 0;
                    if (size > 0) {
                        musicOptions.push({
                            id: f.format_id,
                            quality: `${Math.round(abr)}K`,
                            format: 'MP3',
                            size: `${(size / (1024 * 1024)).toFixed(1)}MB`,
                            is_audio: true
                        });
                    }
                } else if (f.vcodec !== 'none') {
                    const height = f.height;
                    if (!height || height < 144) return;
                    let resLabel = `${height}P`;
                    if (height >= 720) resLabel += " HD";
                    if (seenVideoRes.has(resLabel)) return;
                    seenVideoRes.add(resLabel);
                    const size = f.filesize || f.filesize_approx || 0;
                    videoOptions.push({
                        id: f.format_id,
                        quality: resLabel,
                        format: 'Auto',
                        size: size > 0 ? `${(size / (1024 * 1024)).toFixed(1)}MB` : "Auto",
                        is_audio: false
                    });
                }
            });

            musicOptions.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
            videoOptions.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));

            res.json({
                title: info.title || 'Video',
                thumbnail: info.thumbnail,
                platform: (info.extractor_key || 'Web').toLowerCase(),
                music: musicOptions,
                video: videoOptions
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to process formats' });
        }
    });
});

// 3. Download Progress
io.on('connection', (socket) => {
    socket.on('disconnect', () => {});
});

app.post('/process-download', (req, res) => {
    const { url, format_id, is_audio, socket_id } = req.body;
    const taskId = Date.now().toString();
    
    setTimeout(() => {
        let formatStr = is_audio ? format_id : (format_id === 'best' ? 'best' : `${format_id}+bestaudio/best`);
        let args = ['-m', 'yt_dlp', ...baseArgs, '--newline', '-f', formatStr, '-o', path.join(DOWNLOAD_FOLDER, `${taskId}.%(ext)s`)];
        
        if (is_audio) {
            args.push('--extract-audio', '--audio-format', 'mp3');
        }

        const ytdlp = spawn('python', [...args, url]);

        ytdlp.stdout.on('data', (data) => {
            const output = data.toString();
            const percentMatch = output.match(/\[download\]\s+([\d\.]+)%/);
            if (percentMatch) {
                const percent = parseFloat(percentMatch[1]);
                io.to(socket_id).emit('progress', { percent: percent, status: 'Downloading...' });
            } else if (output.includes('Merging formats') || output.includes('Extracting audio')) {
                io.to(socket_id).emit('progress', { percent: 100, status: 'Instant Merging...' });
            }
        });

        ytdlp.on('close', () => {
            fs.readdir(DOWNLOAD_FOLDER, (err, files) => {
                const downloadedFile = files.find(f => f.startsWith(taskId));
                let actualExt = '.mp4';
                if (downloadedFile) actualExt = path.extname(downloadedFile);
                io.to(socket_id).emit('download_complete', { task_id: taskId, ext: actualExt, title: 'Downloaded Successfully' });
            });
        });

        ytdlp.stderr.on('data', (data) => {
             console.error("❌ Download Warning/Error:", data.toString());
        });

    }, 0);

    res.json({ status: "started" });
});

// 4. API Files List
app.get('/api/files', (req, res) => {
    let filesList = [];
    if (fs.existsSync(DOWNLOAD_FOLDER)) {
        const files = fs.readdirSync(DOWNLOAD_FOLDER);
        files.forEach(f => {
            const filePath = path.join(DOWNLOAD_FOLDER, f);
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
                const sizeMb = stats.size / (1024 * 1024);
                const ext = path.extname(f).replace('.', '').toUpperCase();
                const isAudio = ['MP3', 'M4A', 'OPUS'].includes(ext);
                filesList.push({
                    name: f,
                    size: `${sizeMb.toFixed(1)} MB`,
                    type: ext,
                    date: stats.mtime.toISOString().split('T')[0],
                    is_audio: isAudio,
                    mod_time: stats.mtime.getTime()
                });
            }
        });
    }
    filesList.sort((a, b) => b.mod_time - a.mod_time);
    res.json({ files: filesList });
});

// 5. System Player Launcher
app.get('/play-system/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(DOWNLOAD_FOLDER, filename);
    
    if (fs.existsSync(filePath)) {
        let command;
        if (process.platform === 'win32') command = `start "" "${filePath}"`;
        else if (process.platform === 'darwin') command = `open "${filePath}"`;
        else command = `xdg-open "${filePath}"`;

        exec(command, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ status: "success" });
        });
    } else {
        res.status(404).json({ error: "File not found" });
    }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Node Server running on port ${PORT}`);
});