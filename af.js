const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const { spawnSync } = require('child_process');
const { tmpdir } = require('os');
const fs = require('fs');
const mp4box = require('mp4box');

(function () {
    // args input file, output file
    const inputFile = process.argv[2];
    const outputFile = process.argv[3];
    const maxWidth = process.argv[4] || 1080;
    const type = process.argv[5] || 'h264'; // h264, h265
    const gop = process.argv[6] || 5;
    const crf = process.argv[7] || 28;

    if (!inputFile || !outputFile) {
        console.error('Usage: node af.js <input file> <output file> <max width> <type> <gop> <crf>');
        process.exit(1);
    }

    const tmpMp4 = path.join(tmpdir(), `${Math.random().toString(36).substring(2, 15)}.mp4`);

    let cv = null;
    let tag = null;

    if (type === 'h264') {
        cv = 'libx264';
        tag = 'avc1';
    } else if (type === 'h265') {
        cv = 'libx265';
        tag = 'hvc1';
    }

    console.log(`[af] input:  ${inputFile}`);
    console.log(`[af] output: ${outputFile}  (type=${type}, maxWidth=${maxWidth}, gop=${gop}, crf=${crf})`);
    console.log('[af] Step 1/3: transcoding with ffmpeg (live progress below)...');

    // stdio: 'inherit' streams ffmpeg's own frame=/time= progress to the console so the
    // transcode never looks hung. (Trade-off: ffmpeg.stderr is no longer captured on failure,
    // but the same output has already been shown live.)
    const ffmpeg = spawnSync(ffmpegPath, [
        '-i', inputFile,
        '-c:v', cv,
        '-tag:v', tag,
        '-vf', `scale='min(${maxWidth},iw)':-2`,
        '-crf', crf,
        '-map_metadata', '-1',
        '-refs', '1',
        '-sc_threshold', '0',
        '-level:v', '5.1',
        '-tune', 'fastdecode',
        '-preset', 'slower',
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-g', gop,
        '-bf', '0',
        '-movflags', '+faststart',
        '-an',
        '-y',
        tmpMp4
    ], { stdio: 'inherit' });

    if (ffmpeg.status !== 0) {
        console.error(`[af] ffmpeg failed (exit code ${ffmpeg.status}).`);
        if (ffmpeg.stderr) console.error(ffmpeg.stderr.toString());
        process.exit(1);
    }

    console.log('[af] Transcode complete. Step 2/3: demuxing samples...');

    const mp4Buffer = new Uint8Array(fs.readFileSync(tmpMp4)).buffer;
    mp4Buffer.fileStart = 0;

    // Remove the actual file
    fs.unlinkSync(tmpMp4);

    const mp4boxfile = mp4box.createFile();

    mp4boxfile.onReady = function (info) {
        const videoTrack = info.videoTracks[0];

        console.log(`[af] video: ${videoTrack.video.width}x${videoTrack.video.height}, ` +
            `${videoTrack.nb_samples} frames, codec ${videoTrack.codec}`);

        const trak = mp4boxfile.getTrackById(videoTrack.id);
        const sampleEntry = trak.mdia.minf.stbl.stsd.entries[0];
        let descriptionBase64 = null;
        const codecConfigBox = sampleEntry.hvcC || sampleEntry.avcC || sampleEntry.av1C;
        if (codecConfigBox) {
            const stream = new mp4box.DataStream(null, 0, mp4box.DataStream.BIG_ENDIAN);
            codecConfigBox.write(stream);
            // First 8 bytes are the MP4 box header (4 size + 4 type), skip them
            const descriptionBuffer = new Uint8Array(stream.buffer, 8);
            descriptionBase64 = Buffer.from(descriptionBuffer).toString('base64');
        } else {
            console.error('Missing codec configuration box (expected hvcC or avcC)');
            process.exit(1);
        }

        let offset = 0;
        let chunks = []; // collect sample buffers; concatenated once at the end (O(n), not O(n^2))
        let jsonbuf = [];
        let frameKey = 0;

        mp4boxfile.onSamples = function (id, user, samples) {
            for (const sample of samples) {
                const chunkData = Buffer.from(sample.data.buffer || sample.data, sample.data.byteOffset || 0, sample.data.byteLength || sample.data.length);
                chunks.push(chunkData);

                jsonbuf.push({
                    o: offset,
                    l: chunkData.length,
                    t: Math.round((sample.cts / sample.timescale) * 1000000),
                    ty: sample.is_sync ? 'key' : 'delta',
                    i: frameKey
                });

                offset += chunkData.length;
                frameKey += 1;
            }

            // Live progress: rewrite one line as batches arrive so the demux never looks hung.
            process.stdout.write(`\r[af] collected ${jsonbuf.length}/${videoTrack.nb_samples} frames`);

            // mp4box delivers samples in batches, calling onSamples once per batch. Emit the
            // manifest + footer + file exactly ONCE, after every sample has been collected.
            // Emitting inside each batch (the original behaviour) embeds a stale manifest into
            // the stream on every call, which corrupts the footer offset and every frame's byte
            // offset for any video large enough to extract in more than one batch.
            if (jsonbuf.length < videoTrack.nb_samples) {
                return;
            }

            let manifest = {
                codec: videoTrack.codec,
                fps: videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale),
                totalFrames: videoTrack.nb_samples,
                frames: jsonbuf,
                width: videoTrack.video.width,
                height: videoTrack.video.height,
                gop,
                type,
                description: descriptionBase64
            };

            // Append the manifest then the footer, and build the whole file in a single concat.
            chunks.push(Buffer.from(JSON.stringify(manifest)));

            const footer = Buffer.alloc(4);
            footer.writeUInt32LE(offset, 0);
            chunks.push(footer);

            const databuf = Buffer.concat(chunks);
            console.log(`\n[af] Step 3/3: writing ${(databuf.length / 1048576).toFixed(1)} MB to ${outputFile}...`);
            fs.writeFileSync(outputFile, databuf);

            console.log('✅ Video generated successfully!');
        };
        mp4boxfile.setExtractionOptions(videoTrack.id);
        mp4boxfile.start();
    };

    mp4boxfile.onError = function (e) {
        console.error(`Error: ${e}`);
    };

    mp4boxfile.appendBuffer(mp4Buffer);
    mp4boxfile.flush();
})();
