# ActiveFrame 🖼️ (beta)

![ActiveFrame sample](./docs/assets/sample.gif)
![ActiveFrame sample2](./docs/assets/sample2.gif)

Demo: https://activetheory.github.io/activeframe/  
[More Context](https://x.com/luruke/status/2037511335257223626?s=20)

ActiveFrame is a small pipeline and javascript library for turning a video into a **single binary `.af` file** and decoding it in the browser with the **Web Codec API** — without a `<video>` element and **without third-party dependencies** such as FFmpeg.wasm, Mediabunny, or other JS demuxers/decoders.

The file packs **raw encoded samples** (H.264 / H.265) plus a **JSON manifest**. The runtime loads the buffer, configures the decoder from the manifest, and exposes **frame-accurate** navigation via `setFrame(index)`.

---

## Why use this instead of “regular” video?

- Frame-accurate control and random access
- Feed the frame natively to WebGL/WebGPU and Canvas 2D
- Hardware accelerated**
- Optimized for interactive scrubbing, 3D, image-like control over which frame is shown
- You can keep multiple videos "in sync"
- Predictable loading times, buffering, etc

---

## Why use this instead of “regular” spritesheet?

- Smaller file size, leveraging H.264 / H.265 intra frame compression
- Better memory management


---

## Generating an `.af` file

```bash
node af.js --input <input video> --output <output.af> [--codec h264|h265] [--mode cpu|gpu] [--maxWidth N] [--gop N] [--crf N] [--cq N]
```

Defaults to H.264 on the GPU (NVENC) path, with settings validated end-to-end through real playback testing (Baseline profile, GOP=1). Pass `--codec h265` for H.265/HEVC (libx265/hevc_nvenc) if your target player doesn't have H.264's specific constraints, or `--mode cpu` for environments without an NVIDIA GPU. Run `node af.js` with no arguments to see every available flag.

---

## File format

An `.af` file is three parts, in order:

```
[ encoded samples ][ JSON manifest ][ 8-byte footer ]
```

- **Samples** — raw encoded frames (H.264 / H.265), concatenated with no container.
- **Manifest** — JSON describing the clip (`codec`, `width`, `height`, `totalFrames`) and one entry
  per frame giving its byte offset `o`, length `l`, timestamp `t` in microseconds, and type `ty`.
- **Footer** — the byte offset at which the manifest begins, as a **little-endian unsigned 64-bit
  integer**. Read the last 8 bytes to locate the manifest, then the manifest to locate any frame.

### 64-bit footer — not backwards compatible

The footer was previously a 4-byte offset, which capped the sample region at 4 GiB. That is a real
limit rather than a theoretical one: roughly a 6.6-hour clip at 960x540 / 15fps all-intra reaches
it, and anything past that point produced a file whose manifest could not be located.

It is now 8 bytes, which removes the limit for any practical input.

**This is a breaking change in both directions.** Files written with the old 4-byte footer cannot be
read by this version, and files written by this version cannot be read by older readers. Existing
`.af` files must be regenerated, and any separate reader implementation — including native players
outside this repo — needs the same 4 → 8 byte change.

---

## Roadmap / ideas

- Surface **codec support** before loading (e.g. companion manifest or a tiny probe).
- **Streaming** or partial fetch (range requests), LOD, adaptive quality.
- **Runtime tuning** of hardware vs software decode based on performance.
- **Benchmark suite** to calibrate and fine tune performance and hw support.


---

Demo video is from [Netflix Open Content](https://opencontent.netflix.com/) – Meridian. Under Creative Commons Attribution 4.0 International Public License.
