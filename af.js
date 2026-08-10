const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir } = require('os');
const fs = require('fs');
const mp4box = require('mp4box');

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
            args[key] = val;
        }
    }
    return args;
}

// A flag whose default is `true` needs an explicit "--flag false" to turn off, since a bare
// `--flag` (no value) parses to the boolean `true` either way.
function boolFlag(val, defaultValue) {
    if (val === undefined) return defaultValue;
    if (val === 'false') return false;
    if (val === 'true') return true;
    return !!val;
}

const args = parseArgs(process.argv.slice(2));
const inputFile = args.input;
const outputFile = args.output;
const maxWidth = parseInt(args.maxWidth || '1920', 10);
const gop = parseInt(args.gop || '1', 10); // 1 = all-intra, for maximum seek compatibility
// copy = package an already-correctly-encoded input without re-encoding.
const mode = args.mode || 'gpu'; // gpu (nvenc) | cpu (software x264/x265) | copy (no re-encode)
const codec = args.codec || 'h264'; // h264 | h265
if (codec !== 'h264' && codec !== 'h265') {
    console.error(`Unknown --codec ${codec} (use h264 or h265)`);
    process.exit(1);
}
const tag = codec === 'h264' ? 'avc1' : 'hvc1';
const crf = args.crf || '20';    // x264/x265 CRF (cpu mode)
const cq = args.cq || '24';      // NVENC CQ (gpu mode)
const preset = args.preset || (mode === 'gpu' ? 'p4' : 'slower');
// tune is x264-only (libx265 and both NVENC encoders have no "fastdecode" tune).
const tune = args.tune === 'none' ? null : (args.tune || (mode === 'cpu' && codec === 'h264' ? 'fastdecode' : null));
// H.265 has no Baseline profile, hence the different default.
const profile = args.profile || (codec === 'h264' ? 'baseline' : 'main');
const fps = args.fps; // optional target output frame rate; omit to keep source rate
const hwaccel = args.hwaccel || 'none'; // cuda | none - GPU-resident decode via NVDEC
// See the NVENC GOP workaround below for why this defaults to true.
const forceAllKeyframes = boolFlag(args.forceAllKeyframes, true);

if (!inputFile || !outputFile) {
    console.error('Usage: node af.js --input <in> --output <out.af> [--codec h264|h265] [--mode cpu|gpu|copy] [--gop N] [--crf N] [--cq N] [--preset P] [--tune fastdecode|none] [--profile P] [--coder cabac|cavlc] [--forceAllKeyframes true|false] [--hwaccel cuda|none] [--maxWidth N] [--fps N] [--ffmpeg /path/to/ffmpeg]');
    process.exit(1);
}

// ffmpeg-static is only required if actually needed as a fallback - keeps deployments
// that always pass --ffmpeg (or set FFMPEG_PATH) from needing that package at all.
const ffmpegBin = args.ffmpeg || process.env.FFMPEG_PATH || require('ffmpeg-static');
const tmpMp4 = path.join(tmpdir(), `${Math.random().toString(36).substring(2, 15)}.mp4`);
const coder = codec === 'h264' ? (args.coder || null) : null; // NVENC-only, H.264-only (no CAVLC in HEVC)

// NVENC rejects "-g 1 -bf 0" for main/high profile ("Gop Length should be greater than
// number of B frames + 1"). Worked around via a large nominal -g plus -force_key_frames.
const effectiveGop = (mode === 'gpu' && forceAllKeyframes) ? Math.max(gop, 999999) : gop;

// scale_cuda keeps decode->scale->encode entirely GPU-resident when hwaccel is on.
const hwaccelArgs = hwaccel === 'cuda' ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : [];
const filterChain = hwaccel === 'cuda'
    ? `scale_cuda=w='min(${maxWidth},iw)':h=-2`
    : `scale='min(${maxWidth},iw)':-2`;

let ffArgs;
if (mode === 'copy') {
    // Input is already encoded to the wanted spec, so every encode-side option (scale, profile,
    // GOP, pix_fmt, keyframe forcing, frame rate) is either meaningless or rejected under -c:v copy.
    ffArgs = [
        '-i', inputFile,
        '-c:v', 'copy',
        '-tag:v', tag,
        '-map_metadata', '-1',
        '-movflags', '+faststart',
        '-an',
        '-y',
        tmpMp4,
    ];
} else {
    let codecArgs;
    if (mode === 'cpu') {
        const lib = codec === 'h264' ? 'libx264' : 'libx265';
        codecArgs = ['-c:v', lib, '-crf', String(crf), '-sc_threshold', '0', '-preset', preset];
        if (tune) codecArgs.push('-tune', tune);
        if (coder) codecArgs.push('-coder', coder);
    } else if (mode === 'gpu') {
        const enc = codec === 'h264' ? 'h264_nvenc' : 'hevc_nvenc';
        codecArgs = ['-c:v', enc, '-rc', 'vbr', '-cq', String(cq), '-preset', preset];
        if (tune) codecArgs.push('-tune', tune);
        if (coder) codecArgs.push('-coder', coder);
    } else {
        console.error(`Unknown --mode ${mode} (use cpu, gpu or copy)`);
        process.exit(1);
    }

    ffArgs = [
        ...hwaccelArgs,
        '-i', inputFile,
        ...codecArgs,
        '-tag:v', tag,
        '-vf', filterChain,
        '-map_metadata', '-1',
        '-refs', '1',
        '-level:v', '5.1',
        '-profile:v', profile,
        // -pix_fmt would force a software conversion filter, breaking the GPU-resident path.
        ...(hwaccel === 'cuda' ? [] : ['-pix_fmt', 'yuv420p']),
        '-g', String(effectiveGop),
        '-bf', '0',
        '-movflags', '+faststart',
        '-an',
        '-y',
    ];
    if (forceAllKeyframes) {
        ffArgs.push('-force_key_frames', 'expr:1');
        // NVENC-only: without this, only the first forced keyframe is a real IDR.
        if (mode === 'gpu') ffArgs.push('-forced-idr', '1');
    }
    if (fps) ffArgs.push('-r', String(fps));
    ffArgs.push(tmpMp4);
}

console.log(`[af] input:  ${inputFile}`);
console.log(`[af] output: ${outputFile}  ` + (mode === 'copy'
    ? `(codec=${codec}, mode=copy - no re-encode)`
    : `(codec=${codec}, mode=${mode}, hwaccel=${hwaccel}, maxWidth=${maxWidth}, gop=${gop}, crf=${crf}, cq=${cq}, tune=${tune || 'none'}, profile=${profile}, fps=${fps || 'source'})`));
console.log(`[af] Step 1/3: ${mode === 'copy' ? 'remuxing' : 'transcoding'} with ffmpeg (live progress below)...`);

const t0 = process.hrtime.bigint();
// stdio: 'inherit' streams ffmpeg's own progress live so the transcode never looks
// hung; trade-off is stderr isn't separately captured on failure.
const ffmpeg = spawnSync(ffmpegBin, ffArgs, { stdio: 'inherit' });
const t1 = process.hrtime.bigint();
const encodeSeconds = Number(t1 - t0) / 1e9;

if (ffmpeg.status !== 0) {
    console.error(`[af] ffmpeg failed (exit code ${ffmpeg.status}).`);
    fs.rmSync(tmpMp4, { force: true }); // ffmpeg may have written a partial file before failing
    process.exit(1);
}
console.log(`[af] Transcode complete (${encodeSeconds.toFixed(2)}s). Step 2/3: demuxing samples...`);

const mp4Buffer = new Uint8Array(fs.readFileSync(tmpMp4)).buffer;
mp4Buffer.fileStart = 0;
fs.unlinkSync(tmpMp4);

const mp4boxfile = mp4box.createFile();

mp4boxfile.onReady = function (info) {
    const videoTrack = info.videoTracks[0];
    console.log(`[af] video: ${videoTrack.video.width}x${videoTrack.video.height}, ${videoTrack.nb_samples} frames, codec ${videoTrack.codec}`);

    const trak = mp4boxfile.getTrackById(videoTrack.id);
    const sampleEntry = trak.mdia.minf.stbl.stsd.entries[0];
    let descriptionBase64 = null;
    const codecConfigBox = sampleEntry.hvcC || sampleEntry.avcC || sampleEntry.av1C;
    if (codecConfigBox) {
        const stream = new mp4box.DataStream(null, 0, mp4box.DataStream.BIG_ENDIAN);
        codecConfigBox.write(stream);
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

        process.stdout.write(`\r[af] collected ${jsonbuf.length}/${videoTrack.nb_samples} frames`);

        // mp4box delivers samples in batches - emit the manifest+footer+file exactly
        // once, after every sample has been collected (see header comment).
        if (jsonbuf.length < videoTrack.nb_samples) {
            return;
        }

        const manifest = {
            codec: videoTrack.codec,
            fps: videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale),
            totalFrames: videoTrack.nb_samples,
            frames: jsonbuf,
            width: videoTrack.video.width,
            height: videoTrack.video.height,
            gop,
            type: codec,
            description: descriptionBase64,
            _mode: mode,
            _hwaccel: hwaccel,
            _tune: tune || 'none',
            _profile: profile,
            _coder: coder || 'default',
            _forceAllKeyframes: forceAllKeyframes,
            _encodeSeconds: encodeSeconds,
        };

        chunks.push(Buffer.from(JSON.stringify(manifest)));
        const footer = Buffer.alloc(4);
        footer.writeUInt32LE(offset, 0);
        chunks.push(footer);

        const databuf = Buffer.concat(chunks);
        console.log(`\n[af] Step 3/3: writing ${(databuf.length / 1048576).toFixed(1)} MB to ${outputFile}...`);
        fs.writeFileSync(outputFile, databuf);
        console.log(`OK frames=${frameKey} bytes=${databuf.length} encode_seconds=${encodeSeconds.toFixed(2)}`);
    };
    mp4boxfile.setExtractionOptions(videoTrack.id);
    mp4boxfile.start();
};

mp4boxfile.onError = function (e) {
    console.error(`mp4box error: ${e}`);
    process.exit(1);
};

mp4boxfile.appendBuffer(mp4Buffer);
mp4boxfile.flush();
