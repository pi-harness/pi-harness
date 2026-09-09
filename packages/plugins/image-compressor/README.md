# @pi-harness/plugin-image-compressor

Image Compressor — Create bounded image copies for model context while preserving the original file and reporting saved bytes.

## Install

```sh
npm install --save-exact @pi-harness/plugin-image-compressor
```

## Enable

Add the entry to the Cordis profile the harness starts from:

```yaml
- id: image-compressor
  name: "@pi-harness/plugin-image-compressor"
  config: {}
```

The Pi Harness plugin marketplace installs and enables this package for you; the steps above are the manual equivalent.

## Native workspace and publication

`image_compress` binds input and output paths to the current native session workspace, using the launch directory before a native session is available. Replacing the session, changing its ID, or changing its workspace clears the receipt and invalidates pending work. Reads, final atomic publication, and returned receipts recheck that scope; cancellation and disposal also prevent pending publication.

The atomic writer validates scope after the staged file is synced and closed, immediately before linking or renaming it into place. A rejected check removes staging and preserves an existing target. Once the filesystem commit has been submitted it cannot be rolled back; a later session change discards the receipt. Empty output parent directories may remain after an interrupted preparation. Default output names never overwrite an existing file; explicit output paths retain their confirmed replacement behavior.
