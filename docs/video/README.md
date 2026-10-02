# Product video

## Current binary founder-pitch draft

The local [binary-pitch storyboard](binary-pitch-storyboard.json) and [renderer](../../scripts/render-binary-pitch.py) produce an 85.72-second, 1920×1080 narrated motion-graphics **draft** at `outputs/demo-video/binary-pitch/tend-binary-founder-pitch-draft.mp4`. The output directory also contains a poster, transcript, SRT captions, and render report. It explains the exact 1.5×/2×/3× total winning payouts, expiry-only settlement, and the September 28 position #4 loss using [verified evidence](../evidence/demo-rehearsal.json). It explicitly discloses that the trade used an operator CLI wallet and MockPyth does not authenticate updates.

This is not footage of the current application or a browser-wallet trade, and it has not been published or submitted. The separate working-product video still needs current app captures and accepted public hosting. To rebuild this local draft on macOS with Python 3, Pillow, `ffmpeg`, `ffprobe`, and the Samantha `say` voice:

```sh
python3 scripts/render-binary-pitch.py
```

The renderer only writes to gitignored `outputs/demo-video/binary-pitch/` and does not replace the historical video below.

The September 12 recording is a **historical** 126.355-second artifact, 1920×1080, H.264/AAC, 30 fps. Public player: `https://monad.usetend.xyz/demo.html`. It predates the current BTC/ETH/MON strike ladder and signed early-exit flow; it is not a current product demo or submission video. The MP4, poster, transcript, SRT and WebVTT files are under `web/public/media/`.

## What the footage establishes

Eight edited scenes show the actual app, live market switching, expiry/direction/premium selection, on-chain pool values, a historical completed trade summary, and MonadScan fill/settlement pages. Source browser captures were sampled at approximately four frames per second and held where narration needed more time. Neither rendering at 30 fps nor edited timing measures application or chain performance.

Position #10 was an operator-run rehearsal executed through the live HTTP signer and a CLI wallet. It was not a user transaction, and the video does not show a new browser wallet confirmation. Its zero payout and premium-only loss are stated explicitly. Synthetic macOS Samantha narration and AI assistance are disclosed on the player page.

## Re-render

Prerequisites: macOS `say` with Samantha installed, `ffmpeg`, `ffprobe`, Python 3 and Pillow. No paid media service or voice account is needed.

```sh
python3 scripts/render-demo.py
```

The renderer needs source captures in `outputs/demo-video/capture/<scene>/00000.jpg`, increasing zero-padded frame numbers, and `capture.json` containing the frame count and actual capture seconds. The scene/crop/caption specification is [storyboard.json](storyboard.json). Captures are obtained with the supported browser-client `tab.screenshot` API; inspect the actual page before each interaction. JPEG is the returned format for these external-browser captures. Do not replace captured source with fabricated wallet UI or a synthetic success state.

Raw captures and intermediate media are ignored locally under `outputs/`. The final compressed video and accessibility files are checked in under `web/public/media/`. New captures may require changing the crop rectangles to fit their dimensions; the renderer rejects out-of-bounds crops. It also rejects an over-three-minute result and captions exceeding two lines.

## Verification

Independent review confirmed the final streams, all 25 ordered/nonoverlapping caption cues within duration, byte-identical public copies, and explicit historical/mock disclosures. The parent inspected the opening, pool and explorer frames; FFmpeg decoded the full video and detected a non-silent narration stream. This is media and code validation, not a browser-signing rehearsal, current-demo validation, or a security certification.
