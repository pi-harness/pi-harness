# @pi-harness/plugin-vision-toolkit

Vision Toolkit — Catalog signature-verified PNG, JPEG, GIF, and WebP metadata with bounded header reads, cancellable workspace traversal, explicit partial results, and a local-only normalized panel.

## Install

```sh
npm install --save-exact @pi-harness/plugin-vision-toolkit
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: vision-toolkit
  name: "@pi-harness/plugin-vision-toolkit"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Behavior

`vision_catalog` takes an empty object and scans the current native session manager's workspace. `vision_image_info` takes one workspace-relative `path`. Before a runtime exists, both use the launch workspace. No image bytes are uploaded or returned to the model: these tools return metadata only, do not call a vision model, and do not perform OCR or describe image content. The current model does not need image support.

Supported extensions are `.png`, `.jpg`, `.jpeg`, `.gif`, and `.webp` (case-insensitive). The signature must match the extension. Dimensions come from PNG IHDR, GIF logical-screen size, JPEG SOF, or WebP VP8/VP8L/VP8X headers. Header inspection is not full decoding, CRC verification, or proof that the entire image is valid. Dimensions describe the encoded image/canvas, without applying EXIF rotation or inspecting animation frames. A large JPEG whose SOF lies beyond the header budget reports null dimensions and `headerTruncated=true`.

Catalogs skip symlinks and `.git`/`node_modules` directories. Explicit info paths may resolve through symlinks only when the canonical target remains inside the workspace. Image info opens without waiting for a FIFO writer and rejects non-regular files. Malformed or extension-mismatched catalog candidates become bounded issues; valid images remain available. No image file is modified.

## Session and cancellation

The panel holds the latest successful catalog or single-image report in memory. Changing the native session object, manager, session ID, or workspace clears the report and status, including in-place session changes. An old in-flight operation cannot publish results into the replacement session. Only one catalog/info tool request runs at a time. Caller cancellation and plugin disposal propagate through traversal and header reads; cancellation does not become a malformed-image issue.

## Limits and output

Each file is limited to 20 MiB and at most 256 KiB of header reads. Catalogs process at most 4,096 entries, visit at most 512 directories to depth 16, inspect at most 256 image candidates, and return at most 100 assets. Directory discovery is separately bounded for each visited directory by the remaining processed-entry budget. Reaching traversal or asset limits sets `truncated`; at most 20 issues of 500 characters are returned, with `issuesTruncated` indicating additional omitted issues.

Paths are limited to 4,096 characters. Model-facing text quotes filenames, escapes controls and bidirectional formatting characters, and is capped at 16 KiB on a valid UTF-8 boundary with an explicit truncation suffix. Tool details and the panel retain the bounded structured report. Returned reports are detached from internal state. The panel's idle/running/completed/failed/cancelled states describe inspection, not model analysis.
